import {
  isPreviewManagedVideo,
  STUDIO_PREVIEW_DETACHED_SRC_ATTR,
  STUDIO_PREVIEW_MARK_META,
} from "../studioPreviewMark";
import { isClipVisibleAt, isInClipWindow } from "./clipWindow";
import { isElementNode, isMediaElement, isVideoElement } from "./domRealm";
import { swappedElements } from "./proxySrc";

/**
 * Preview media budget.
 *
 * A preview document of a long edit holds a hundred or more `<video>` elements. In WebKit every one
 * that has a source opens an AVURLAsset: a byte stream in the GPU process, read through a resource
 * loader. Opening dozens at once, and deleting players whose asset is still opening, deadlocked the
 * WebContent process (its synchronous audio-session IPC waits on the GPU main thread, which waits in
 * the resource loader's dealloc for the byte streams). So the preview never holds more than it
 * needs, and never churns a load in progress:
 *
 * - The Studio server serves every managed video without a `src` (`data-hf-detached-src`,
 *   `preload="none"`): nothing opens at parse. `isPreviewManagedVideo` is the rule.
 * - This module attaches a source only to videos that are playing, near the playhead or starting
 *   soon, at most `MAX_ACTIVE_PREVIEW_MEDIA` of them, at most `MAX_IN_FLIGHT_LOADS` opening at a
 *   time (`MAX_IN_FLIGHT_URGENT_LOADS` for the clips the viewer is looking at), nearest first.
 * - It releases a source (`src` removed, `load()`) only once its load has settled and no other load
 *   is in flight, at most `DETACH_BATCH_SIZE` per `DETACH_INTERVAL_MS`, farthest first.
 *
 * The policy (`planPreviewMediaBudget`, `decidePreviewMediaBudget`) is pure. `createPreviewMediaBudget`
 * applies it to elements; the DOM is the state (a video with `data-hf-detached-src` and no `src` is
 * released). A render drives every frame itself and needs every source, so the runtime never
 * activates this there (`isPreviewMediaBudgetActive`).
 */

/** Videos allowed to hold a source at once. Clips playing or under the playhead are exempt. */
export const MAX_ACTIVE_PREVIEW_MEDIA = 16;
/** A clip that ended at most this long ago keeps its source (a short backward scrub stays instant). */
export const RETAIN_BEHIND_SECONDS = 5;
/** A clip that starts within this long keeps its source. */
export const RETAIN_AHEAD_SECONDS = 10;
/** The next clips to start keep their source however far away they start. */
export const RETAIN_UPCOMING_CLIPS = 3;
/** A clip starting within this long is urgent: it may open ahead of the cap and the queue. */
export const URGENT_AHEAD_SECONDS = 2;
/** Element loads (attach until metadata, error or abort) allowed in flight at once. */
export const MAX_IN_FLIGHT_LOADS = 3;
/** A paused playhead that keeps jumping is a scrub: sources are planned once it rests this long. */
export const SCRUB_SETTLE_MS = 120;
/** The same for urgent clips: the ones under the playhead must not wait behind far-away loads. */
export const MAX_IN_FLIGHT_URGENT_LOADS = 6;
/** A load older than this no longer counts toward the limit (it still cannot be released). */
export const LOAD_STALL_MS = 15_000;
/** Settled videos released per batch; teardown of many players at once is the hazard. */
export const DETACH_BATCH_SIZE = 3;
export const DETACH_INTERVAL_MS = 250;
/** The playback tick re-plans at most this often, unless the playhead jumped. */
export const PLAN_MIN_INTERVAL_MS = 100;
export const PLAN_SEEK_JUMP_SECONDS = 0.25;

const HAVE_NOTHING = 0;
const NETWORK_LOADING = 2;
/** Seek target already applied by the transport; do not override it. */
const POSITIONED_EPSILON_SECONDS = 0.01;

/** The Studio server marked this page a preview and no render is driving it. */
export function isPreviewMediaBudgetActive(doc: Document, win: Window): boolean {
  return (
    doc.querySelector(`meta[name="${STUDIO_PREVIEW_MARK_META}"]`) !== null &&
    !Reflect.get(win, "__HF_EXPORT_RENDER_SEEK_CONFIG") &&
    !Reflect.get(win, "__HF_RENDER_CAPTURE_MODE")
  );
}

function videosIn(root: Node): Element[] {
  const videos: Element[] = [];
  if (isElementNode(root) && root.localName === "video") videos.push(root);
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (!isElementNode(child)) continue;
    if (child.localName === "video") videos.push(child);
    videos.push(...child.querySelectorAll("video"));
  }
  return videos;
}

/**
 * Serve managed videos without a source, as the preview server does for the main document: for
 * compositions the runtime mounts itself (inline templates, fetched sub-compositions, scene swaps),
 * before the nodes enter the live document where a `src` would open a player at once.
 */
export function detachPreviewVideoSources(root: Node): void {
  for (const el of videosIn(root)) {
    const src = el.getAttribute("src");
    if (src === null || !isPreviewManagedVideo(el)) continue;
    el.setAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR, src);
    el.removeAttribute("src");
    el.setAttribute("preload", "none");
  }
}

/**
 * `doc.importNode(node, true)` for a preview: a clone into the live document starts loading every
 * `<video src>` at once, so the copy is made in an inert document, stripped of its managed videos'
 * sources there, and only then imported.
 */
export function importPreviewNode<T extends Node>(doc: Document, win: Window, node: T): T {
  if (!isPreviewMediaBudgetActive(doc, win)) return doc.importNode(node, true);
  const copy = doc.implementation.createHTMLDocument("").importNode(node, true);
  detachPreviewVideoSources(copy);
  return doc.importNode(copy, true);
}

export interface BudgetClip<K> {
  key: K;
  start: number;
  end: number;
  /** Must keep its source whatever the policy says: playing, audible, leased or held on screen. */
  pinned: boolean;
}

export interface BudgetOptions {
  cap?: number;
  behindSeconds?: number;
  aheadSeconds?: number;
  upcomingClips?: number;
  urgentAheadSeconds?: number;
  maxInFlight?: number;
  maxInFlightUrgent?: number;
}

export interface BudgetPlan<K> {
  /** Everything that should hold a source, most needed first. */
  wanted: K[];
  /** Wanted and needed now: inside its window, pinned, or starting imminently. */
  urgent: Set<K>;
  /** Seconds from the playhead to the clip's window; 0 inside it. */
  distance: Map<K, number>;
}

/** Which clips should hold a source at `time`, honouring the cap by distance from the playhead. */
export function planPreviewMediaBudget<K>(
  clips: readonly BudgetClip<K>[],
  time: number,
  options: BudgetOptions = {},
): BudgetPlan<K> {
  const cap = options.cap ?? MAX_ACTIVE_PREVIEW_MEDIA;
  const behind = options.behindSeconds ?? RETAIN_BEHIND_SECONDS;
  const ahead = options.aheadSeconds ?? RETAIN_AHEAD_SECONDS;
  const upcomingClips = options.upcomingClips ?? RETAIN_UPCOMING_CLIPS;
  const urgentAhead = options.urgentAheadSeconds ?? URGENT_AHEAD_SECONDS;

  const distance = new Map<K, number>();
  const urgent = new Set<K>();
  const must: K[] = [];
  const candidates: Array<{ key: K; distance: number; upcoming: boolean; start: number }> = [];
  const notStarted = clips
    .filter(
      (clip) => !clip.pinned && time < clip.start && !isInClipWindow(time, clip.start, clip.end),
    )
    .sort((a, b) => a.start - b.start);
  const nextUp = new Set(notStarted.slice(0, upcomingClips).map((clip) => clip.key));

  for (const clip of clips) {
    const inside = isInClipWindow(time, clip.start, clip.end);
    const upcoming = !inside && time < clip.start;
    const d = inside ? 0 : upcoming ? clip.start - time : time - clip.end;
    distance.set(clip.key, d);
    if (inside || clip.pinned) {
      must.push(clip.key);
      urgent.add(clip.key);
      continue;
    }
    const retained = upcoming ? d <= ahead || nextUp.has(clip.key) : d <= behind;
    if (!retained) continue;
    if (upcoming && d <= urgentAhead) urgent.add(clip.key);
    candidates.push({ key: clip.key, distance: d, upcoming, start: clip.start });
  }

  // Nearest first; at equal distance the clip about to play beats the one that just played.
  candidates.sort(
    (a, b) =>
      a.distance - b.distance || Number(b.upcoming) - Number(a.upcoming) || a.start - b.start,
  );
  // Only what is on screen or playing (`must`) may exceed the cap; everything else is cut by distance.
  const room = Math.max(0, cap - must.length);
  const kept = candidates.slice(0, room).map((candidate) => candidate.key);
  return { wanted: [...must, ...kept], urgent, distance };
}

export interface BudgetState<K> extends BudgetClip<K> {
  /** Holds a source right now (loading, loaded or failed). */
  attached: boolean;
  /** Its load has not settled (no metadata, no error yet): it cannot be released. */
  loading: boolean;
  /** Loading for longer than `LOAD_STALL_MS`: still cannot be released, but no longer queues others. */
  stalled: boolean;
}

export interface BudgetDecision<K> {
  attach: K[];
  detach: K[];
  /** Work was deferred (load slots, batching, cap room): run again when a load settles or after `DETACH_INTERVAL_MS`. */
  pending: boolean;
}

/**
 * What to attach and release in this pass.
 *
 * Attaches go out nearest first, urgent clips (under the playhead, playing, starting within
 * `URGENT_AHEAD_SECONDS`) ahead of the rest. At most `MAX_IN_FLIGHT_LOADS` loads are in flight
 * (`MAX_IN_FLIGHT_URGENT_LOADS` when an urgent clip asks), and a clip that is not urgent also waits
 * for room under the cap, so the loaded count converges to the cap instead of overshooting it.
 *
 * Releases touch only settled videos, and only while no load is in flight: a player deleted while
 * any asset is still opening is what blocked the GPU process. They go out farthest first in batches
 * of `DETACH_BATCH_SIZE`, at most one batch per `DETACH_INTERVAL_MS`.
 */
export function decidePreviewMediaBudget<K>(
  clips: readonly BudgetState<K>[],
  time: number,
  timing: { nowMs: number; lastDetachAtMs: number },
  options: BudgetOptions = {},
): BudgetDecision<K> {
  const cap = options.cap ?? MAX_ACTIVE_PREVIEW_MEDIA;
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT_LOADS;
  const maxInFlightUrgent = options.maxInFlightUrgent ?? MAX_IN_FLIGHT_URGENT_LOADS;
  const plan = planPreviewMediaBudget(clips, time, options);
  const wanted = new Set(plan.wanted);
  const byKey = new Map(clips.map((clip) => [clip.key, clip]));
  let inFlight = clips.filter((clip) => clip.loading && !clip.stalled).length;

  const batchOpen = timing.nowMs - timing.lastDetachAtMs >= DETACH_INTERVAL_MS;
  const unwanted = clips
    .filter((clip) => clip.attached && !clip.loading && !wanted.has(clip.key))
    .sort((a, b) => (plan.distance.get(b.key) ?? 0) - (plan.distance.get(a.key) ?? 0));
  const detach =
    batchOpen && inFlight === 0 ? unwanted.slice(0, DETACH_BATCH_SIZE).map((clip) => clip.key) : [];
  const deferredDetach = unwanted.length - detach.length;

  let room = cap - (clips.filter((clip) => clip.attached).length - detach.length);
  const waiting = plan.wanted.filter((key) => byKey.get(key)?.attached === false);
  const attach: K[] = [];
  let deferredAttach = 0;
  for (const key of [
    ...waiting.filter((key) => plan.urgent.has(key)),
    ...waiting.filter((key) => !plan.urgent.has(key)),
  ]) {
    const isUrgent = plan.urgent.has(key);
    const slotFree = inFlight < (isUrgent ? maxInFlightUrgent : maxInFlight);
    if (slotFree && (isUrgent || room > 0)) {
      attach.push(key);
      inFlight += 1;
      room -= 1;
    } else {
      deferredAttach += 1;
    }
  }
  return { attach, detach, pending: deferredDetach > 0 || deferredAttach > 0 };
}

/** What the clip index knows about a media clip. */
export interface PreviewMediaClip {
  el: HTMLMediaElement;
  start: number;
  end: number;
  mediaStart: number;
}

export interface PreviewMediaBudgetUpdate {
  clips: readonly PreviewMediaClip[];
  time: number;
  nowMs: number;
  /** Borrowed by the Studio (scrub audio, grading preview): never released while leased. */
  isLeased: (el: HTMLMediaElement) => boolean;
  /** The composition's length; a clip that runs to it holds its last frame past its own end. */
  compositionDuration: () => number;
}

export interface PreviewMediaBudgetHooks {
  /**
   * Called with a video whose `src` was just set, before the browser starts loading it, so a proxy
   * swap can replace the source (it may set `src` and call `load()` itself).
   */
  prepareSource?: (el: HTMLMediaElement) => void;
  /** A load settled (metadata, error or abort): capacity is free, plan again. */
  onLoadSettled?: () => void;
}

const LOAD_SETTLE_EVENTS = ["loadedmetadata", "error", "abort"] as const;
const FIRST_FRAME_EVENTS = ["loadeddata", "error", "abort"] as const;

/** Videos whose first frame has not arrived since the budget attached their source. */
const awaitingFirstFrame = new WeakSet<HTMLMediaElement>();

function onFirstFrameSettled(event: Event): void {
  const el = event.currentTarget;
  if (!isMediaElement(el)) return;
  awaitingFirstFrame.delete(el);
  for (const type of FIRST_FRAME_EVENTS) el.removeEventListener(type, onFirstFrameSettled, true);
}

/**
 * A video whose source the budget just attached and whose first frame has not arrived: a seek into
 * it must wait for the frame the way a seek into a still-loading video does. Its `networkState` is
 * still NO_SOURCE until the browser runs resource selection, so the ordinary "is it loading" test
 * cannot see it.
 */
export function isAwaitingRestoredSource(el: HTMLMediaElement): boolean {
  return awaitingFirstFrame.has(el) && el.readyState < el.HAVE_CURRENT_DATA;
}

/** The DOM is the state: a managed video with a detached source and no `src` is released. */
function isReleased(el: HTMLMediaElement): boolean {
  return !el.hasAttribute("src") && el.hasAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR);
}

export interface PreviewMediaBudget {
  /** Apply the budget for the playhead at `input.time`. `pending`: plan again soon. */
  update(input: PreviewMediaBudgetUpdate): { pending: boolean };
  /** Holds no source (so it must not be preloaded, played or seeked yet). */
  isReleased(el: HTMLMediaElement): boolean;
}

export function createPreviewMediaBudget(
  options: BudgetOptions = {},
  hooks: PreviewMediaBudgetHooks = {},
): PreviewMediaBudget {
  /** Loads the budget started, and when. Removed when they settle. */
  const loads = new Map<HTMLMediaElement, number>();
  /** Loading elements the budget did not start (a source present at parse) and when first seen. */
  const strayLoads = new WeakMap<HTMLMediaElement, number>();
  let lastDetachAtMs = Number.NEGATIVE_INFINITY;

  function settleLoad(el: HTMLMediaElement): void {
    if (!loads.delete(el)) return;
    for (const type of LOAD_SETTLE_EVENTS) el.removeEventListener(type, onLoadSettled, true);
    hooks.onLoadSettled?.();
  }

  function onLoadSettled(event: Event): void {
    if (isMediaElement(event.currentTarget)) settleLoad(event.currentTarget);
  }

  /** Since when the element's load has been in progress, or null once it has settled. */
  function loadingSince(el: HTMLMediaElement, nowMs: number): number | null {
    const started = loads.get(el);
    if (started !== undefined) {
      if (el.readyState > HAVE_NOTHING || el.error) {
        settleLoad(el);
        return null;
      }
      return started;
    }
    const opening =
      el.hasAttribute("src") &&
      el.readyState === HAVE_NOTHING &&
      !el.error &&
      el.networkState === NETWORK_LOADING;
    if (!opening) {
      strayLoads.delete(el);
      return null;
    }
    const since = strayLoads.get(el) ?? nowMs;
    strayLoads.set(el, since);
    return since;
  }

  function detach(el: HTMLMediaElement): void {
    const src = el.getAttribute("src");
    if (src === null) return;
    el.pause();
    el.setAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR, src);
    // `removeAttribute`, never `src = ""`: an empty src is an error event, not a released source;
    // removing the attribute does not reset the element, so `load()` is what frees the player.
    el.removeAttribute("src");
    el.preload = "none";
    el.load();
  }

  /** `seekTo`: source time to park on once metadata arrives; `null` leaves that to the transport. */
  function attach(el: HTMLMediaElement, nowMs: number, seekTo: number | null): void {
    const src = el.getAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR);
    if (src === null) return;
    // `preload` first: with "none" the browser never starts a load the new `src` asks for.
    // Setting `src` starts the load itself; an explicit `load()` here would restart it.
    el.preload = "auto";
    el.setAttribute("src", src);
    el.removeAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR);
    hooks.prepareSource?.(el);
    loads.set(el, nowMs);
    for (const type of LOAD_SETTLE_EVENTS) el.addEventListener(type, onLoadSettled, true);
    awaitingFirstFrame.add(el);
    for (const type of FIRST_FRAME_EVENTS) el.addEventListener(type, onFirstFrameSettled, true);
    if (seekTo === null || seekTo <= POSITIONED_EPSILON_SECONDS) return;
    el.addEventListener(
      "loadedmetadata",
      () => {
        // The transport may already have placed it (a seek into the clip): that position wins.
        if (!el.seeking && el.currentTime < POSITIONED_EPSILON_SECONDS) el.currentTime = seekTo;
      },
      { once: true },
    );
  }

  return {
    update(input: PreviewMediaBudgetUpdate): { pending: boolean } {
      for (const el of loads.keys()) if (!el.isConnected) settleLoad(el);

      let compositionDuration: number | null = null;
      const managed: Array<BudgetState<PreviewMediaClip>> = [];
      for (const clip of input.clips) {
        const { el } = clip;
        if (!isVideoElement(el) || !el.isConnected) continue;
        const released = isReleased(el);
        if (!released && !el.hasAttribute("src")) continue;
        const detachable = isPreviewManagedVideo(el) && !swappedElements.has(el);
        // A video the budget may not release (unmanaged, proxy-swapped) still holds a source.
        let pinned = input.isLeased(el) || (!released && (!detachable || !el.paused));
        if (!pinned && input.time >= clip.end) {
          // Past its end but still the picture on screen: the last frame of the film.
          compositionDuration ??= input.compositionDuration();
          pinned = isClipVisibleAt(input.time, clip.start, clip.end, compositionDuration);
        }
        const since = released ? null : loadingSince(el, input.nowMs);
        managed.push({
          key: clip,
          start: clip.start,
          end: clip.end,
          pinned,
          attached: !released,
          loading: since !== null,
          stalled: since !== null && input.nowMs - since > LOAD_STALL_MS,
        });
      }

      const decision = decidePreviewMediaBudget(
        managed,
        input.time,
        { nowMs: input.nowMs, lastDetachAtMs },
        options,
      );
      for (const clip of decision.detach) {
        lastDetachAtMs = input.nowMs;
        detach(clip.el);
      }
      for (const clip of decision.attach) {
        if (isInClipWindow(input.time, clip.start, clip.end)) attach(clip.el, input.nowMs, null);
        else attach(clip.el, input.nowMs, input.time < clip.start ? clip.mediaStart : null);
      }
      return { pending: decision.pending };
    },

    isReleased,
  };
}
