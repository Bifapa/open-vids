/**
 * Parent-frame media proxy subsystem.
 *
 * Maintains mirror copies of the iframe's timed `<audio>`/`<video>` elements
 * in the parent frame so that mobile browsers — which gate `el.play()` on user
 * activation in the *same* frame — can still produce audible output via proxies
 * the parent controls directly.
 *
 * See the class-level JSDoc on `HyperframesPlayer` for the full ownership model.
 */

import { selectMediaObserverTargets } from "./mediaObserverScope.js";
import { isRealmElement, isRealmHtmlMediaElement } from "./media-element-guards.js";
import { isInClipWindow } from "@hyperframes/core/runtime/clip-window";
import { readClipTiming } from "@hyperframes/core/composition-contract";
import {
  STUDIO_PREVIEW_DETACHED_SRC_ATTR,
  readPreviewMediaSrc,
} from "@hyperframes/core/studio-preview-mark";

/**
 * Most iframe-media proxies whose load has not settled (loadedmetadata/error)
 * at once. Every proxy with a live `src` opens its own platform media asset;
 * hundreds of concurrent opens exhaust the decoder/IPC layer, so the rest wait
 * in a FIFO queue and start as earlier ones settle.
 */
const MAX_CONCURRENT_PROXY_LOADS = 3;

/** An iframe clip whose proxy has not been created yet. */
interface PendingProxy {
  src: string;
  tag: "audio" | "video";
  start: number;
  duration: number;
  source: HTMLMediaElement;
}

/** Minimum absolute drift before a currentTime correction is attempted. */
const MIRROR_DRIFT_THRESHOLD_SECONDS = 0.05;

/**
 * How many *consecutive* over-threshold samples are required before issuing a
 * `currentTime` write. Absorbs single-sample jitter (GC pause, slow bridge
 * tick) without thrashing. Forced calls bypass this gate.
 *
 * Worst-case correction latency ≈ this × bridgeMaxPostIntervalMs (80 ms in
 * core/runtime/state.ts) = 160 ms — well under human A/V re-sync tolerance.
 */
const MIRROR_REQUIRED_CONSECUTIVE_DRIFT_SAMPLES = 2;

export interface ProxyEntry {
  el: HTMLMediaElement;
  start: number;
  duration: number;
  /**
   * The iframe media element this proxy mirrors, when adopted from the DOM.
   * Its `data-start`/`data-duration` are re-read each tick so live timeline
   * edits (trim/move) bound the proxy correctly. Null for URL-driven proxies.
   */
  source?: HTMLMediaElement | null;
  /**
   * Count of consecutive steady-state samples in which the proxy's
   * `currentTime` was found drifted beyond `MIRROR_DRIFT_THRESHOLD_SECONDS`.
   * Reset on every in-threshold sample. A write is only issued once this
   * reaches `MIRROR_REQUIRED_CONSECUTIVE_DRIFT_SAMPLES`, absorbing
   * single-sample jitter without thrashing.
   */
  driftSamples: number;
}

export class ParentMediaManager {
  private _entries: ProxyEntry[] = [];
  private _mediaObserver?: MutationObserver;
  private _playbackErrorPosted = false;
  private _audioOwner: "runtime" | "parent" = "runtime";
  /** Iframe clips waiting for a free load slot (FIFO). Parent ownership only. */
  private _queue: PendingProxy[] = [];
  /** Iframe-clip proxies whose load has not settled yet. */
  private readonly _loading = new Set<ProxyEntry>();
  /** The proxy created from the `audio-src` attribute, tracked so it can be
   *  replaced or cleared instead of accumulating on every attribute change. */
  private _urlAudioEntry: ProxyEntry | null = null;
  private _urlAudioSrc: string | null = null;

  private readonly _dispatchEvent: (event: Event) => void;
  private readonly _getMuted: () => boolean;
  private readonly _getVolume: () => number;
  private readonly _getPlaybackRate: () => number;
  private readonly _getCurrentTime: () => number;
  private readonly _isPaused: () => boolean;

  constructor(opts: {
    dispatchEvent: (event: Event) => void;
    getMuted: () => boolean;
    getVolume: () => number;
    getPlaybackRate: () => number;
    getCurrentTime: () => number;
    isPaused: () => boolean;
  }) {
    this._dispatchEvent = opts.dispatchEvent;
    this._getMuted = opts.getMuted;
    this._getVolume = opts.getVolume;
    this._getPlaybackRate = opts.getPlaybackRate;
    this._getCurrentTime = opts.getCurrentTime;
    this._isPaused = opts.isPaused;
  }

  get audioOwner(): "runtime" | "parent" {
    return this._audioOwner;
  }

  /** Exposed for test instrumentation only — do not use in production code. */
  get entries(): ProxyEntry[] {
    return this._entries;
  }

  resetForIframeLoad(): void {
    this._playbackErrorPosted = false;
    const wasPromoted = this._audioOwner === "parent";
    this._audioOwner = "runtime";
    this.pauseAll();
    for (const m of this._entries) if (m !== this._urlAudioEntry) m.el.src = "";
    this._entries = this._urlAudioEntry ? [this._urlAudioEntry] : [];
    this._queue = [];
    this._loading.clear();
    if (this._urlAudioSrc && !this._urlAudioEntry)
      this._urlAudioEntry = this._createEntry(this._urlAudioSrc, "audio", 0, Infinity);
    this.teardownObserver();
    if (wasPromoted) {
      this._dispatchEvent(
        new CustomEvent("audioownershipchange", {
          detail: { owner: "runtime", reason: "iframe-reload" },
        }),
      );
    }
  }

  destroy(): void {
    this.teardownObserver();
    for (const m of this._entries) {
      m.el.pause();
      m.el.src = "";
    }
    this._entries = [];
    this._queue = [];
    this._loading.clear();
    this._urlAudioEntry = null;
    this._urlAudioSrc = null;
    this._audioOwner = "runtime";
    this._playbackErrorPosted = false;
  }

  updateMuted(muted: boolean): void {
    for (const m of this._entries) m.el.muted = muted;
  }

  updateVolume(volume: number): void {
    for (const m of this._entries) m.el.volume = volume;
  }

  updatePlaybackRate(rate: number): void {
    for (const m of this._entries) m.el.playbackRate = rate;
  }

  private _playEntry(m: ProxyEntry): void {
    if (!m.el.src) return;
    m.el.play().catch((err: unknown) => this._reportPlaybackError(err));
  }

  // Play only if the current playhead is inside the clip's (live) window, so
  // bulk starts (playAll / adopt) don't blip audio for clips outside their
  // window until the next mirrorTime tick gates them off.
  private _playEntryIfActive(m: ProxyEntry): void {
    this._refreshEntryBounds(m);
    if (!this._inWindow(m, this._getCurrentTime())) return;
    this._playEntry(m);
  }

  // Re-read the source clip's live timing so trims/moves bound the proxy
  // (adopt-time values go stale when the timeline is edited).
  private _refreshEntryBounds(m: ProxyEntry): void {
    if (!m.source?.isConnected) return;
    // Guard against a malformed (non-numeric) attribute parsing to NaN: an NaN
    // duration makes every window check pass, so the
    // gate never closes and the proxy plays past its clip end.
    const timing = readClipTiming(m.source);
    m.start = timing.start ?? 0;
    m.duration =
      timing.duration != null && timing.duration > 0 ? timing.duration : Number.POSITIVE_INFINITY;
  }

  // Pause the proxy outside its clip window; resume it on re-entry during
  // parent-owned playback. Returns whether the proxy is within the window.
  private _inWindow(m: ProxyEntry, timeSeconds: number): boolean {
    return isInClipWindow(timeSeconds, m.start, m.start + m.duration);
  }

  private _gateEntryPlayback(m: ProxyEntry, timeSeconds: number): boolean {
    if (!this._inWindow(m, timeSeconds)) {
      if (!m.el.paused) m.el.pause();
      m.driftSamples = 0;
      return false;
    }
    if (this._audioOwner === "parent" && !this._isPaused() && m.el.paused) this._playEntry(m);
    return true;
  }

  playAll(): void {
    for (const m of this._entries) this._playEntryIfActive(m);
  }

  pauseAll(): void {
    for (const m of this._entries) m.el.pause();
  }

  stopAdoptedMedia(): void {
    for (const m of this._entries) {
      if (m.source) m.el.pause();
    }
  }

  seekAll(timeInSeconds: number): void {
    for (const m of this._entries) {
      // Re-read live bounds so a trim/move just before a paused scrub gates and
      // positions against the current clip window, not the adopt-time one.
      this._refreshEntryBounds(m);
      if (this._inWindow(m, timeInSeconds)) m.el.currentTime = timeInSeconds - m.start;
    }
  }

  // Audible scrub: position every proxy at `timeInSeconds` AND play the ones whose
  // clip window covers it, so the viewer hears the track under the playhead while
  // dragging the scrubber (vs seekAll, which positions silently). Each drag move
  // re-seeks to the new position, so playback restarts from the playhead and you
  // hear the audio you're scrubbing over. The caller settles back to silence on
  // scrub end (a normal pause+seekAll). Muted proxies stay silent (play() is a no-op
  // for output). Out-of-window proxies are paused.
  scrubAll(timeInSeconds: number): void {
    for (const m of this._entries) {
      this._refreshEntryBounds(m);
      if (this._inWindow(m, timeInSeconds)) {
        m.el.currentTime = timeInSeconds - m.start;
        this._playEntry(m);
      } else if (!m.el.paused) {
        m.el.pause();
      }
    }
  }

  /**
   * Mirror parent-proxy `currentTime` to the iframe timeline, with optional
   * jitter-coalescing. Pass `{ force: true }` for alignment moments (ownership
   * promotion, new proxy initialization) where drift must be corrected
   * immediately.
   */
  mirrorTime(timelineSeconds: number, options?: { force?: boolean }): void {
    const force = options?.force === true;
    for (const m of this._entries) {
      this._refreshEntryBounds(m);
      if (!this._gateEntryPlayback(m, timelineSeconds)) continue;
      const relTime = timelineSeconds - m.start;
      if (Math.abs(m.el.currentTime - relTime) > MIRROR_DRIFT_THRESHOLD_SECONDS) {
        m.driftSamples += 1;
        if (force || m.driftSamples >= MIRROR_REQUIRED_CONSECUTIVE_DRIFT_SAMPLES) {
          m.el.currentTime = relTime;
          m.driftSamples = 0;
        }
      } else {
        m.driftSamples = 0;
      }
    }
  }

  /**
   * Take ownership of audible playback in response to the runtime's
   * `media-autoplay-blocked` signal. Idempotent.
   *
   * The caller is responsible for muting the iframe's own media output via the
   * postMessage bridge (`set-media-output-muted`) after calling this.
   */
  /**
   * Take ownership of audible playback. Idempotent. The `onMirror` callback
   * is called with the current timeline time and `{ force: true }` so the
   * caller's mirror implementation runs (enabling test spies on the player
   * to fire). If omitted, `mirrorTime` is called directly.
   */
  promoteToParentProxy(
    iframeDoc: Document | null,
    onMirror?: (t: number, opts: { force: boolean }) => void,
  ): void {
    if (this._audioOwner === "parent") return;
    this._audioOwner = "parent";

    // Synchronously mute iframe media to close the race window.
    if (iframeDoc) {
      for (const el of iframeDoc.querySelectorAll("video, audio")) {
        if (isRealmHtmlMediaElement(el)) el.muted = true;
      }
      // Proxies for iframe clips exist only under parent ownership: bring the
      // clips already in the document online (bounded by the load queue).
      for (const el of iframeDoc.querySelectorAll("audio[data-start], video[data-start]")) {
        if (isRealmHtmlMediaElement(el)) this._adoptIframeMedia(el);
      }
    }

    // One-shot alignment — bypass jitter-coalescing gate.
    const t = this._getCurrentTime();
    if (onMirror) onMirror(t, { force: true });
    else this.mirrorTime(t, { force: true });
    if (!this._isPaused()) this.playAll();

    this._dispatchEvent(
      new CustomEvent("audioownershipchange", {
        detail: { owner: "parent", reason: "autoplay-blocked" },
      }),
    );
  }

  /**
   * Set up proxies for all timed media currently in the iframe document, then
   * install a MutationObserver for media added later (sub-composition activation).
   */
  setupFromIframe(iframeDoc: Document): void {
    const mediaEls = iframeDoc.querySelectorAll("audio[data-start], video[data-start]");
    for (const iframeEl of mediaEls) {
      if (isRealmHtmlMediaElement(iframeEl)) this._adoptIframeMedia(iframeEl);
    }
    this._observeDynamicMedia(iframeDoc);
  }

  /**
   * Set (or replace) the parent-frame audio proxy driven by the `audio-src`
   * attribute. Re-setting with a different URL tears down the previous proxy
   * first, so changing `audio-src` swaps the track instead of stacking a
   * second one that keeps preloading and plays in parallel.
   */
  setupFromUrl(audioSrc: string): void {
    if (this._urlAudioSrc === audioSrc && this._urlAudioEntry) return;
    this.teardownUrlAudio();
    const entry = this._createEntry(audioSrc, "audio", 0, Infinity);
    // Null when the composition already has a proxy for this URL: that one stays the
    // composition's, and a reset creates ours once that document's proxies are gone.
    this._urlAudioEntry = entry;
    this._urlAudioSrc = audioSrc;
    // If the parent already owns playback, bring the fresh proxy online so a
    // mid-playback swap is not silent until the next play tick.
    if (entry && this._audioOwner === "parent" && !this._isPaused()) {
      this.mirrorTime(this._getCurrentTime(), { force: true });
      this.playAll();
    }
  }

  /** Tear down the `audio-src` proxy (used when the attribute is removed). */
  teardownUrlAudio(): void {
    const entry = this._urlAudioEntry;
    this._urlAudioEntry = null;
    this._urlAudioSrc = null;
    if (!entry) return;
    entry.el.pause();
    entry.el.src = "";
    const idx = this._entries.indexOf(entry);
    if (idx !== -1) this._entries.splice(idx, 1);
  }

  teardownObserver(): void {
    this._mediaObserver?.disconnect();
    this._mediaObserver = undefined;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _reportPlaybackError(err: unknown): void {
    if (this._playbackErrorPosted) return;
    this._playbackErrorPosted = true;
    this._dispatchEvent(
      new CustomEvent("playbackerror", { detail: { source: "parent-proxy", error: err } }),
    );
  }

  /**
   * Create a parent-frame media element and start preloading it. Returns the
   * new entry, or `null` when a URL-driven proxy (no `source`) would duplicate
   * a src the composition already plays. Iframe clips are never deduplicated by URL.
   */
  private _createEntry(
    src: string,
    tag: "audio" | "video",
    start: number,
    duration: number,
    source?: HTMLMediaElement | null,
  ): ProxyEntry | null {
    if (!source && this._entries.some((m) => m.el.src === src)) return null;

    const el = tag === "video" ? document.createElement("video") : new Audio();
    el.preload = "auto";
    el.src = src;
    el.load();
    el.muted = this._getMuted();
    el.volume = this._getVolume();
    const rate = this._getPlaybackRate();
    if (rate !== 1) el.playbackRate = rate;

    const entry: ProxyEntry = { el, start, duration, driftSamples: 0, source };
    this._entries.push(entry);
    return entry;
  }

  /** Hold a load slot for `entry` until it settles, then start the next queued clip. */
  private _trackLoad(entry: ProxyEntry): void {
    this._loading.add(entry);
    const settle = () => {
      entry.el.removeEventListener("loadedmetadata", settle);
      entry.el.removeEventListener("error", settle);
      if (this._loading.delete(entry)) this._pumpQueue();
    };
    entry.el.addEventListener("loadedmetadata", settle);
    entry.el.addEventListener("error", settle);
  }

  /** Start queued clips while load slots are free. */
  private _pumpQueue(): void {
    while (this._loading.size < MAX_CONCURRENT_PROXY_LOADS) {
      const next = this._queue.shift();
      if (!next) return;
      // The preview released this clip's source while it waited.
      if (this._isReleased(next.source)) continue;
      const entry = this._createEntry(next.src, next.tag, next.start, next.duration, next.source);
      if (!entry) continue;
      this._trackLoad(entry);
      this._catchUp(entry);
    }
  }

  /** A new proxy under parent ownership must join the playhead immediately. */
  private _catchUp(entry: ProxyEntry): void {
    if (this._audioOwner !== "parent") return;
    this.mirrorTime(this._getCurrentTime(), { force: true });
    if (!this._isPaused()) this._playEntryIfActive(entry);
  }

  /** The Studio preview dropped the element's decoder: no `src`, authored one parked. */
  private _isReleased(iframeEl: HTMLMediaElement): boolean {
    return (
      iframeEl.getAttribute("src") === null &&
      iframeEl.hasAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR)
    );
  }

  /** Resolve an iframe media element's source to an absolute URL, or null. */
  private _resolveIframeMediaSrc(iframeEl: HTMLMediaElement): string | null {
    const rawSrc =
      readPreviewMediaSrc(iframeEl) || iframeEl.querySelector("source")?.getAttribute("src");
    return rawSrc ? new URL(rawSrc, iframeEl.ownerDocument.baseURI).href : null;
  }

  private _adoptIframeMedia(iframeEl: HTMLMediaElement): void {
    // Proxies for iframe clips are only ever audible under parent ownership;
    // in runtime ownership they would just open an idle copy of every source.
    if (this._audioOwner !== "parent") return;
    // Skip elements the preloader has demoted — the observer will re-trigger
    // when the preload attribute is promoted to "auto".
    if (iframeEl.preload === "metadata" || iframeEl.preload === "none") return;
    // A released element has no source loaded; its re-attach flips preload to auto.
    if (this._isReleased(iframeEl)) return;

    // Each clip gets its own proxy even when several share one file: bounds and
    // lifetime belong to the element, not to the URL.
    const src = this._resolveIframeMediaSrc(iframeEl);
    if (!src) return;
    if (this._entries.some((m) => m.source === iframeEl)) return;
    if (this._queue.some((q) => q.source === iframeEl)) return;

    const timing = readClipTiming(iframeEl);
    this._queue.push({
      src,
      tag: iframeEl.tagName === "VIDEO" ? "video" : "audio",
      start: timing.start ?? 0,
      duration: timing.duration ?? Number.POSITIVE_INFINITY,
      source: iframeEl,
    });
    this._pumpQueue();
  }

  private _detachIframeMedia(iframeEl: HTMLMediaElement): void {
    this._queue = this._queue.filter((q) => q.source !== iframeEl);
    const idx = this._entries.findIndex((m) => m.source === iframeEl);
    if (idx === -1) return;
    const entry = this._entries[idx];
    entry.el.pause();
    entry.el.src = "";
    this._loading.delete(entry);
    this._entries.splice(idx, 1);
    this._pumpQueue();
  }

  private _observeDynamicMedia(doc: Document): void {
    this.teardownObserver();
    if (typeof MutationObserver === "undefined" || !doc.body) return;

    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "preload") {
          const target = m.target;
          if (
            isRealmHtmlMediaElement(target) &&
            target.matches("audio[data-start], video[data-start]") &&
            target.preload === "auto"
          ) {
            this._adoptIframeMedia(target);
          }
          continue;
        }

        for (const added of m.addedNodes) {
          if (!isRealmElement(added)) continue;
          const candidates: HTMLMediaElement[] = [];
          if (
            isRealmHtmlMediaElement(added) &&
            added.matches("audio[data-start], video[data-start]")
          ) {
            candidates.push(added);
          }
          const inside = added.querySelectorAll("audio[data-start], video[data-start]");
          for (const el of inside) {
            if (isRealmHtmlMediaElement(el)) candidates.push(el);
          }
          for (const el of candidates) this._adoptIframeMedia(el);
        }

        for (const removed of m.removedNodes) {
          if (!isRealmElement(removed)) continue;
          const dropped: HTMLMediaElement[] = [];
          if (
            isRealmHtmlMediaElement(removed) &&
            removed.matches("audio[data-start], video[data-start]")
          ) {
            dropped.push(removed);
          }
          const inside = removed.querySelectorAll("audio[data-start], video[data-start]");
          for (const el of inside) {
            if (isRealmHtmlMediaElement(el)) dropped.push(el);
          }
          for (const el of dropped) this._detachIframeMedia(el);
        }
      }
    });

    const observeOpts: MutationObserverInit = {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["preload"],
    };

    const targets = selectMediaObserverTargets(doc);
    for (const target of targets) {
      obs.observe(target, observeOpts);
    }
    this._mediaObserver = obs;
  }
}
