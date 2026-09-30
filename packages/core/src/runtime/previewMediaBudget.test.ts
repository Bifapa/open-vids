import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_PREVIEW_DETACHED_SRC_ATTR } from "../studioPreviewMark";
import {
  type BudgetClip,
  type BudgetState,
  createPreviewMediaBudget,
  DETACH_BATCH_SIZE,
  DETACH_INTERVAL_MS,
  isAwaitingRestoredSource,
  MAX_ACTIVE_PREVIEW_MEDIA,
  planPreviewMediaBudget,
  decidePreviewMediaBudget,
  type PreviewMediaBudget,
  RETAIN_UPCOMING_CLIPS,
  type PreviewMediaClip,
} from "./previewMediaBudget";

/** `count` back-to-back clips of `length` seconds; key = index. */
function strip(count: number, length: number, pinned: number[] = []): BudgetClip<number>[] {
  return Array.from({ length: count }, (_, key) => ({
    key,
    start: key * length,
    end: (key + 1) * length,
    pinned: pinned.includes(key),
  }));
}

function states(
  clips: BudgetClip<number>[],
  attached: (key: number) => boolean,
  cheap = false,
): BudgetState<number>[] {
  return clips.map((clip) => ({
    ...clip,
    attached: attached(clip.key),
    cheapToDrop: cheap,
  }));
}

describe("planPreviewMediaBudget", () => {
  it("keeps the current clip, a short past and a lookahead, and drops the rest", () => {
    const clips = strip(40, 4); // clip k spans [4k, 4k+4)
    const { wanted } = planPreviewMediaBudget(clips, 82);
    const keys = new Set(wanted);
    expect(keys.has(20)).toBe(true); // [80, 84) holds the playhead
    expect(keys.has(19)).toBe(true); // ended 2 s ago, inside the retained past
    expect(keys.has(18)).toBe(false); // ended 6 s ago, beyond RETAIN_BEHIND_SECONDS
    expect(keys.has(22)).toBe(true); // starts in 6 s
    expect(keys.has(23)).toBe(true); // starts in exactly RETAIN_AHEAD_SECONDS: still retained
    expect(keys.has(24)).toBe(false); // starts in 14 s
    expect(keys.has(30)).toBe(false);
    expect(keys.has(0)).toBe(false);
  });

  it("retains the next few clips however far away they start", () => {
    const clips: BudgetClip<number>[] = [
      { key: 0, start: 0, end: 5, pinned: false },
      { key: 1, start: 100, end: 105, pinned: false },
      { key: 2, start: 200, end: 205, pinned: false },
      { key: 3, start: 300, end: 305, pinned: false },
      { key: 4, start: 400, end: 405, pinned: false },
    ];
    const keys = planPreviewMediaBudget(clips, 1).wanted;
    expect(keys).toHaveLength(1 + RETAIN_UPCOMING_CLIPS);
    expect(keys).not.toContain(4);
  });

  it("never wants more than the cap, cutting by distance from the playhead", () => {
    // 0.25 s clips: the ±window alone would hold ~60 of them.
    const clips = strip(200, 0.25);
    const time = 25.1;
    const { wanted } = planPreviewMediaBudget(clips, time);
    expect(wanted).toHaveLength(MAX_ACTIVE_PREVIEW_MEDIA);
    expect(wanted[0]).toBe(100); // the clip holding the playhead comes first
    const distances = wanted.map((key) => Math.abs(clips[key]!.start + 0.125 - time));
    const worstKept = Math.max(...distances);
    const nearestDropped = Math.min(
      ...clips
        .filter((clip) => !wanted.includes(clip.key))
        .map((clip) => Math.abs(clip.start + 0.125 - time)),
    );
    expect(worstKept).toBeLessThanOrEqual(nearestDropped + 0.25);
  });

  it("honours an explicit cap", () => {
    const { wanted } = planPreviewMediaBudget(strip(50, 1), 25, { cap: 4 });
    expect(wanted).toHaveLength(4);
    expect(wanted).toContain(25);
  });

  it("never drops a pinned clip, however far away, and counts it against the cap", () => {
    const clips = strip(60, 2, [3]);
    const { wanted } = planPreviewMediaBudget(clips, 100, { cap: 5 });
    expect(wanted).toContain(3);
    expect(wanted).toHaveLength(5);
  });

  it("lets every clip under the playhead keep its source even beyond the cap", () => {
    const overlapping: BudgetClip<number>[] = Array.from({ length: 6 }, (_, key) => ({
      key,
      start: 0,
      end: 10,
      pinned: false,
    }));
    expect(planPreviewMediaBudget(overlapping, 5, { cap: 2 }).wanted).toHaveLength(6);
  });

  it("marks clips about to start as urgent", () => {
    const clips = strip(10, 4);
    const { urgent } = planPreviewMediaBudget(clips, 6.5);
    expect(urgent.has(1)).toBe(true); // holds the playhead
    expect(urgent.has(2)).toBe(true); // starts in 1.5 s
    expect(urgent.has(3)).toBe(false); // starts in 5.5 s: retained, but can wait for room
  });
});

describe("decidePreviewMediaBudget", () => {
  const none = { nowMs: 10_000, lastDetachAtMs: Number.NEGATIVE_INFINITY };

  it("restores a released clip before it starts", () => {
    const clips = strip(40, 4);
    const inLookahead = 2; // starts at 8 s, inside RETAIN_AHEAD_SECONDS
    const decision = decidePreviewMediaBudget(
      states(clips, (key) => key === 0 || key === 1),
      0,
      none,
    );
    expect(decision.attach).toContain(inLookahead);
    expect(decision.attach).not.toContain(39);
  });

  it("restores the clip that holds the playhead straight away, even at the cap", () => {
    const clips = strip(40, 4);
    // 16 far clips hold a source, none of the near ones do.
    const decision = decidePreviewMediaBudget(
      states(clips, (key) => key >= 24 && key < 24 + MAX_ACTIVE_PREVIEW_MEDIA),
      0,
      none,
    );
    expect(decision.attach).toContain(0);
    // Room under the cap, not the wish list, limits the non-urgent rest: they wait for releases.
    expect(decision.attach).not.toContain(3);
    expect(decision.pending).toBe(true);
  });

  it("releases loaded clips in batches, farthest first", () => {
    const clips = strip(40, 4);
    const all = states(clips, () => true);
    const first = decidePreviewMediaBudget(all, 0, none);
    expect(first.detach).toHaveLength(DETACH_BATCH_SIZE);
    expect(first.detach[0]).toBe(39);
    expect(first.pending).toBe(true);

    const soon = decidePreviewMediaBudget(all, 0, { nowMs: 10_000, lastDetachAtMs: 9_900 });
    expect(soon.detach).toEqual([]);
    expect(soon.pending).toBe(true);

    const later = decidePreviewMediaBudget(all, 0, {
      nowMs: 10_000,
      lastDetachAtMs: 10_000 - DETACH_INTERVAL_MS,
    });
    expect(later.detach).toHaveLength(DETACH_BATCH_SIZE);
  });

  it("drains a full scrub in batches and ends at the cap", () => {
    const clips = strip(73, 2);
    const attached = new Set(clips.map((clip) => clip.key));
    let now = 0;
    let lastDetachAtMs = Number.NEGATIVE_INFINITY;
    let passes = 0;
    for (;;) {
      const decision = decidePreviewMediaBudget(
        states(clips, (key) => attached.has(key)),
        70,
        { nowMs: now, lastDetachAtMs },
      );
      for (const key of decision.detach) attached.delete(key);
      for (const key of decision.attach) attached.add(key);
      if (decision.detach.length > 0) lastDetachAtMs = now;
      passes += 1;
      if (!decision.pending) break;
      now += DETACH_INTERVAL_MS;
      expect(passes).toBeLessThan(100);
    }
    expect(attached.size).toBeLessThanOrEqual(MAX_ACTIVE_PREVIEW_MEDIA);
    expect(attached.has(35)).toBe(true); // [70, 72) holds the playhead
  });

  it("releases clips that decoded nothing without waiting for a batch slot", () => {
    const clips = strip(40, 4);
    const decision = decidePreviewMediaBudget(
      states(clips, () => true, true),
      0,
      { nowMs: 10_000, lastDetachAtMs: 9_999 },
    );
    expect(decision.detach.length).toBeGreaterThan(DETACH_BATCH_SIZE);
    expect(decision.detach).not.toContain(0);
  });

  it("does not release a pinned (audible) clip", () => {
    const clips = strip(40, 4, [30]);
    const decision = decidePreviewMediaBudget(
      states(clips, () => true, true),
      0,
      none,
    );
    expect(decision.detach).not.toContain(30);
    expect(decision.detach).toContain(31);
  });

  it("has nothing to do once the wanted set is loaded", () => {
    const clips = strip(40, 4);
    const wanted = planPreviewMediaBudget(clips, 0).wanted;
    const decision = decidePreviewMediaBudget(
      states(clips, (key) => wanted.includes(key)),
      0,
      none,
    );
    expect(decision).toEqual({ attach: [], detach: [], pending: false });
  });
});

describe("createPreviewMediaBudget", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function video(
    index: number,
    attrs: Record<string, string> = { "data-duration": "2" },
  ): PreviewMediaClip {
    const el = document.createElement("video");
    el.setAttribute("src", `clip-${index}.mp4`);
    el.setAttribute("data-start", String(index * 2));
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    document.body.appendChild(el);
    return { el, start: index * 2, end: index * 2 + 2, mediaStart: index };
  }

  const loaded = (el: HTMLMediaElement, readyState = 4) =>
    Object.defineProperty(el, "readyState", { value: readyState, configurable: true });

  function run(
    budget: PreviewMediaBudget,
    clips: PreviewMediaClip[],
    time: number,
    nowMs: number,
    extra: { leased?: HTMLMediaElement[] } = {},
  ) {
    return budget.update({
      clips,
      time,
      nowMs,
      isLeased: (el) => extra.leased?.includes(el) ?? false,
      compositionDuration: () => 1000,
    });
  }

  /** Enough passes, one batch slot apart, for every deferred release and attach to land. */
  function settle(
    budget: PreviewMediaBudget,
    clips: PreviewMediaClip[],
    time: number,
    from: number,
  ) {
    for (let pass = 0; pass < 40; pass += 1) run(budget, clips, time, from + pass * 300);
  }

  it("releases a far video's decoder and stamps its authored src", () => {
    const clips = Array.from({ length: 40 }, (_, i) => video(i));
    for (const { el } of clips) loaded(el);
    const budget = createPreviewMediaBudget();
    run(budget, clips, 0, 10_000);
    const released = clips.filter(({ el }) => budget.isReleased(el));
    expect(released).toHaveLength(DETACH_BATCH_SIZE);
    expect(released.map(({ mediaStart }) => mediaStart).sort((a, b) => a - b)).toEqual([
      37, 38, 39,
    ]);
    const far = clips[39]!.el;
    expect(far.hasAttribute("src")).toBe(false);
    expect(far.getAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR)).toBe("clip-39.mp4");
    expect(far.preload).toBe("none");
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    expect(clips[0]!.el.getAttribute("src")).toBe("clip-0.mp4");
  });

  it("never releases a video that is playing", () => {
    const clips = Array.from({ length: 40 }, (_, i) => video(i));
    for (const { el } of clips) loaded(el);
    const audible = clips[39]!.el;
    Object.defineProperty(audible, "paused", { value: false, configurable: true });
    audible.muted = false;
    audible.volume = 0.8;
    const budget = createPreviewMediaBudget();
    for (let pass = 0; pass < 30; pass += 1) run(budget, clips, 0, 10_000 + pass * 1000);
    expect(budget.isReleased(audible)).toBe(false);
    expect(audible.getAttribute("src")).toBe("clip-39.mp4");
    expect(clips.filter(({ el }) => budget.isReleased(el)).length).toBeGreaterThan(20);
  });

  it("never releases a leased video (scrub audio, grading preview)", () => {
    const clips = Array.from({ length: 40 }, (_, i) => video(i));
    for (const { el } of clips) loaded(el);
    const leased = clips[38]!.el;
    const budget = createPreviewMediaBudget();
    for (let pass = 0; pass < 30; pass += 1) {
      run(budget, clips, 0, 10_000 + pass * 1000, { leased: [leased] });
    }
    expect(budget.isReleased(leased)).toBe(false);
  });

  it("leaves a video whose length comes from its source, or that uses <source>, alone", () => {
    const fromSource = video(30, {});
    const withChildren = video(31);
    withChildren.el.removeAttribute("src");
    withChildren.el.appendChild(Object.assign(document.createElement("source"), { src: "a.mp4" }));
    const clips = [
      video(0),
      fromSource,
      withChildren,
      ...Array.from({ length: 30 }, (_, i) => video(i + 1)),
    ];
    for (const { el } of clips) loaded(el);
    const budget = createPreviewMediaBudget();
    for (let pass = 0; pass < 60; pass += 1) run(budget, clips, 0, 10_000 + pass * 1000);
    expect(budget.isReleased(fromSource.el)).toBe(false);
    expect(budget.isReleased(withChildren.el)).toBe(false);
    expect(fromSource.el.getAttribute("src")).toBe("clip-30.mp4");
  });

  it("restores src, preload and sound state before the clip starts and parks it on its first frame", () => {
    const clips = Array.from({ length: 40 }, (_, i) => video(i));
    for (const { el } of clips) loaded(el);
    const target = clips[3]!; // starts at 6 s
    target.el.muted = true;
    target.el.volume = 0.3;
    target.el.playbackRate = 1.5;
    const budget = createPreviewMediaBudget({ cap: 4 });
    // Seek far away: the clip is released once the batch slot opens.
    settle(budget, clips, 70, 10_000);
    expect(budget.isReleased(target.el)).toBe(true);

    // Back to 0: it starts in 6 s — inside the lookahead — and is restored once the cap has room.
    settle(budget, clips, 0, 100_000);
    expect(budget.isReleased(target.el)).toBe(false);
    expect(target.el.getAttribute("src")).toBe("clip-3.mp4");
    expect(target.el.hasAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR)).toBe(false);
    expect(target.el.preload).toBe("auto");
    expect(target.el.muted).toBe(true);
    expect(target.el.volume).toBeCloseTo(0.3);
    expect(target.el.playbackRate).toBe(1.5);

    target.el.dispatchEvent(new Event("loadedmetadata"));
    expect(target.el.currentTime).toBe(3); // mediaStart of the upcoming clip
  });

  it("makes a seek wait for a restored video's first frame", () => {
    const clips = Array.from({ length: 40 }, (_, i) => video(i));
    for (const { el } of clips) loaded(el);
    const budget = createPreviewMediaBudget({ cap: 4 });
    settle(budget, clips, 70, 10_000);
    const hit = clips[0]!;
    expect(budget.isReleased(hit.el)).toBe(true);
    loaded(hit.el, 0);
    run(budget, clips, 0.5, 200_000);
    expect(isAwaitingRestoredSource(hit.el)).toBe(true);
    hit.el.dispatchEvent(new Event("loadeddata"));
    expect(isAwaitingRestoredSource(hit.el)).toBe(false);
  });

  it("does not park an element the transport already positioned", () => {
    const clips = Array.from({ length: 40 }, (_, i) => video(i));
    for (const { el } of clips) loaded(el);
    const budget = createPreviewMediaBudget({ cap: 4 });
    settle(budget, clips, 70, 10_000);
    const upcoming = clips[2]!;
    settle(budget, clips, 0, 200_000);
    upcoming.el.currentTime = 7.5; // a seek landed on it before metadata arrived
    upcoming.el.dispatchEvent(new Event("loadedmetadata"));
    expect(upcoming.el.currentTime).toBe(7.5);
  });

  it("hands every source back on restoreAll", () => {
    const clips = Array.from({ length: 40 }, (_, i) => video(i));
    for (const { el } of clips) loaded(el);
    const budget = createPreviewMediaBudget();
    for (let pass = 0; pass < 30; pass += 1) run(budget, clips, 0, 10_000 + pass * 1000);
    budget.restoreAll();
    for (const { el, mediaStart } of clips) {
      expect(el.getAttribute("src")).toBe(`clip-${mediaStart}.mp4`);
      expect(el.hasAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR)).toBe(false);
    }
  });

  it("keeps the last frame of a clip that runs to the composition end", () => {
    const clips = Array.from({ length: 40 }, (_, i) => video(i));
    for (const { el } of clips) loaded(el);
    const budget = createPreviewMediaBudget({ cap: 2 });
    const last = clips[39]!;
    // The film ends where the last clip does; the playhead rests past it.
    for (let pass = 0; pass < 40; pass += 1) {
      budget.update({
        clips,
        time: last.end,
        nowMs: 10_000 + pass * 300,
        isLeased: () => false,
        compositionDuration: () => last.end,
      });
    }
    expect(budget.isReleased(last.el)).toBe(false);
  });
});
