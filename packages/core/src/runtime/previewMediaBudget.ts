import { STUDIO_PREVIEW_DETACHED_SRC_ATTR } from "../studioPreviewMark";
import { isClipVisibleAt, isInClipWindow } from "./clipWindow";
import { isMediaElement } from "./domRealm";

/**
 * Preview media budget.
 *
 * A preview document of a long edit holds dozens to a hundred `<video>` elements. Every one of them
 * that has a source keeps a decoder (and, in WebKit, an AVFoundation player in the GPU process)
 * alive, and tearing many of them down at once — a scrub, a reload — deadlocked the WebContent
 * process against the synchronous audio-session IPC. The preview therefore keeps a source only on
 * the videos that are playing, that sit near the playhead, or that start soon; the rest release
 * their decoder (`src` removed, `load()`) and get it back before they are needed.
 *
 * The policy (`planPreviewMediaBudget`, `decidePreviewMediaBudget`) is pure. `createPreviewMediaBudget`
 * applies it to elements. Only a Studio preview uses it: a render drives every frame itself and
 * needs every source loaded, so the runtime never enables it there (see init.ts).
 */

/** Videos allowed to hold a loaded source at once. Clips playing right now are exempt. */
export const MAX_ACTIVE_PREVIEW_MEDIA = 16;
/** A clip that ended at most this long ago keeps its source (a short backward scrub stays instant). */
export const RETAIN_BEHIND_SECONDS = 5;
/** A clip that starts within this long keeps its source. */
export const RETAIN_AHEAD_SECONDS = 10;
/** The next clips to start keep their source however far away they start. */
export const RETAIN_UPCOMING_CLIPS = 3;
/** A clip starting within this long gets its source back at once, ahead of the cap. */
export const URGENT_AHEAD_SECONDS = 2;
/** Loaded videos released per batch; teardown of many decoders at once is the hazard. */
export const DETACH_BATCH_SIZE = 3;
export const DETACH_INTERVAL_MS = 250;
/** The playback tick re-plans at most this often, unless the playhead jumped. */
export const PLAN_MIN_INTERVAL_MS = 100;
export const PLAN_SEEK_JUMP_SECONDS = 0.25;

const HAVE_NOTHING = 0;
/** Seek target already applied by the transport; do not override it. */
const POSITIONED_EPSILON_SECONDS = 0.01;

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
  /** Holds a loaded source right now. */
  attached: boolean;
  /** Releasing it tears no decoder down (nothing was decoded yet), so it needs no batching. */
  cheapToDrop: boolean;
}

export interface BudgetDecision<K> {
  attach: K[];
  detach: K[];
  /** Work was deferred (batching, cap room): run again after `DETACH_INTERVAL_MS`. */
  pending: boolean;
}

/**
 * What to attach and release in this pass.
 *
 * Releases of loaded videos go out in batches of `DETACH_BATCH_SIZE`, at most one batch per
 * `DETACH_INTERVAL_MS`, farthest first, so a scrub across the film never tears down a storm of
 * players. Attaches never wait for that: a clip that is playing or about to start gets its source
 * now; the rest wait for room under the cap, so the loaded count converges to the cap instead of
 * overshooting it by a whole window.
 */
export function decidePreviewMediaBudget<K>(
  clips: readonly BudgetState<K>[],
  time: number,
  timing: { nowMs: number; lastDetachAtMs: number },
  options: BudgetOptions = {},
): BudgetDecision<K> {
  const cap = options.cap ?? MAX_ACTIVE_PREVIEW_MEDIA;
  const plan = planPreviewMediaBudget(clips, time, options);
  const wanted = new Set(plan.wanted);
  const byKey = new Map(clips.map((clip) => [clip.key, clip]));

  const unwanted = clips
    .filter((clip) => clip.attached && !wanted.has(clip.key))
    .sort((a, b) => (plan.distance.get(b.key) ?? 0) - (plan.distance.get(a.key) ?? 0));
  const cheap = unwanted.filter((clip) => clip.cheapToDrop);
  const costly = unwanted.filter((clip) => !clip.cheapToDrop);
  const batchOpen = timing.nowMs - timing.lastDetachAtMs >= DETACH_INTERVAL_MS;
  const batch = batchOpen ? costly.slice(0, DETACH_BATCH_SIZE) : [];
  const detach = [...cheap, ...batch].map((clip) => clip.key);
  const deferredDetach = costly.length - batch.length;

  const attachedAfter = clips.filter((clip) => clip.attached).length - detach.length;
  let room = cap - attachedAfter;
  const attach: K[] = [];
  let deferredAttach = 0;
  for (const key of plan.wanted) {
    if (byKey.get(key)?.attached !== false) continue;
    if (plan.urgent.has(key) || room > 0) {
      attach.push(key);
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

interface Stash {
  src: string;
  currentTime: number;
  muted: boolean;
  volume: number;
  playbackRate: number;
}

function hasExplicitDuration(el: HTMLMediaElement): boolean {
  const duration = Number.parseFloat(el.dataset.duration ?? "");
  return Number.isFinite(duration) && duration > 0;
}

/**
 * Only a `<video src>` whose window is authored (`data-duration`) can be released: a clip that
 * takes its length from the source would change its window, and with it the composition, the
 * moment the decoder let go of `duration`. `<source>` children are left alone too — the Studio
 * reads the authored `src` attribute and re-creating children would rewrite the document.
 */
function isReleasable(el: HTMLMediaElement): boolean {
  return (
    el.tagName === "VIDEO" &&
    el.hasAttribute("src") &&
    el.querySelector("source") === null &&
    hasExplicitDuration(el)
  );
}

const SETTLE_EVENTS = ["loadeddata", "error", "abort", "emptied"] as const;

/** Restored videos whose first frame has not arrived yet. */
const awaitingSource = new WeakSet<HTMLMediaElement>();

function settle(el: HTMLMediaElement): void {
  awaitingSource.delete(el);
  for (const type of SETTLE_EVENTS) el.removeEventListener(type, onSettle, true);
}

function onSettle(event: Event): void {
  if (isMediaElement(event.currentTarget)) settle(event.currentTarget);
}

/**
 * A restored video whose first frame has not arrived: a seek into it must wait for the frame the
 * way a seek into a still-loading video does. Its `networkState` is still NO_SOURCE until the
 * browser runs resource selection, so the ordinary "is it loading" test cannot see it.
 */
export function isAwaitingRestoredSource(el: HTMLMediaElement): boolean {
  return awaitingSource.has(el) && el.readyState < el.HAVE_CURRENT_DATA;
}

export interface PreviewMediaBudget {
  /** Apply the budget for the playhead at `update.time`. `pending`: call again after DETACH_INTERVAL_MS. */
  update(input: PreviewMediaBudgetUpdate): { pending: boolean };
  /** Was this element's source released (so it must not be preloaded)? */
  isReleased(el: HTMLMediaElement): boolean;
  /** Give every released video its source back (runtime teardown). */
  restoreAll(): void;
}

export function createPreviewMediaBudget(options: BudgetOptions = {}): PreviewMediaBudget {
  const stashes = new Map<HTMLMediaElement, Stash>();
  let lastDetachAtMs = Number.NEGATIVE_INFINITY;

  function detach(el: HTMLMediaElement): void {
    const src = el.getAttribute("src");
    if (src === null) return;
    stashes.set(el, {
      src,
      currentTime: el.currentTime,
      muted: el.muted,
      volume: el.volume,
      playbackRate: el.playbackRate,
    });
    el.pause();
    el.setAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR, src);
    // `removeAttribute`, never `src = ""`: an empty src is an error event, not a released source.
    el.removeAttribute("src");
    el.preload = "none";
    el.load();
  }

  /** `seekTo`: source time to park on once metadata arrives; `null` leaves that to the transport; absent restores where it was. */
  function attach(el: HTMLMediaElement, seekTo?: number | null): void {
    const stash = stashes.get(el);
    if (!stash) return;
    stashes.delete(el);
    el.setAttribute("src", stash.src);
    el.removeAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR);
    // After `src`: whoever watches `preload` (the player's parent proxies) must find a source.
    el.preload = "auto";
    el.load();
    // `load()` resets the rate to the default; the rest survives it but is restored all the same.
    el.muted = stash.muted;
    el.volume = stash.volume;
    el.playbackRate = stash.playbackRate;
    awaitingSource.add(el);
    for (const type of SETTLE_EVENTS) el.addEventListener(type, onSettle, true);
    const target = seekTo === undefined ? stash.currentTime : seekTo;
    if (target === null || target <= POSITIONED_EPSILON_SECONDS) return;
    el.addEventListener(
      "loadedmetadata",
      () => {
        // The transport may already have placed it (a seek into the clip): that position wins.
        if (!el.seeking && el.currentTime < POSITIONED_EPSILON_SECONDS) el.currentTime = target;
      },
      { once: true },
    );
  }

  return {
    /** Apply the budget for the playhead at `time`. `pending`: call again after DETACH_INTERVAL_MS. */
    update(input: PreviewMediaBudgetUpdate): { pending: boolean } {
      for (const el of stashes.keys()) if (!el.isConnected) stashes.delete(el);

      let compositionDuration: number | null = null;
      const managed: Array<BudgetState<PreviewMediaClip>> = [];
      for (const clip of input.clips) {
        const { el } = clip;
        if (el.tagName !== "VIDEO" || !el.isConnected) continue;
        const released = stashes.has(el);
        if (!released && !el.hasAttribute("src")) continue;
        let pinned = input.isLeased(el) || (!released && (!isReleasable(el) || !el.paused));
        if (!pinned && input.time >= clip.end) {
          // Past its end but still the picture on screen: the last frame of the film.
          compositionDuration ??= input.compositionDuration();
          pinned = isClipVisibleAt(input.time, clip.start, clip.end, compositionDuration);
        }
        managed.push({
          key: clip,
          start: clip.start,
          end: clip.end,
          pinned,
          attached: !released,
          cheapToDrop: !released && el.readyState === HAVE_NOTHING,
        });
      }

      const decision = decidePreviewMediaBudget(
        managed,
        input.time,
        { nowMs: input.nowMs, lastDetachAtMs },
        options,
      );
      for (const clip of decision.detach) {
        if (clip.el.readyState !== HAVE_NOTHING) lastDetachAtMs = input.nowMs;
        detach(clip.el);
      }
      for (const clip of decision.attach) {
        if (isInClipWindow(input.time, clip.start, clip.end)) attach(clip.el, null);
        else attach(clip.el, input.time < clip.start ? clip.mediaStart : undefined);
      }
      return { pending: decision.pending };
    },

    /** Was this element's source released (so it must not be preloaded)? */
    isReleased(el: HTMLMediaElement): boolean {
      return stashes.has(el);
    },

    /** Give every released video its source back (runtime teardown). */
    restoreAll(): void {
      for (const el of [...stashes.keys()]) attach(el, null);
    },
  };
}
