import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_PREVIEW_DETACHED_SRC_ATTR, STUDIO_PREVIEW_MARK_META } from "../studioPreviewMark";
import {
  type BudgetClip,
  type BudgetState,
  createPreviewMediaBudget,
  DETACH_BATCH_SIZE,
  DETACH_INTERVAL_MS,
  decidePreviewAudioWarmup,
  decidePreviewMediaBudget,
  deferPreviewMediaSources,
  importPreviewNode,
  isAwaitingRestoredSource,
  isPreviewMediaBudgetActive,
  LOAD_STALL_MS,
  MAX_ACTIVE_PREVIEW_MEDIA,
  MAX_IN_FLIGHT_LOADS,
  MAX_IN_FLIGHT_URGENT_LOADS,
  planPreviewMediaBudget,
  type PreviewMediaBudget,
  type PreviewMediaClip,
  RETAIN_UPCOMING_CLIPS,
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

interface StateShape {
  attached?: (key: number) => boolean;
  loading?: (key: number) => boolean;
  stalled?: (key: number) => boolean;
}

function states(clips: BudgetClip<number>[], shape: StateShape = {}): BudgetState<number>[] {
  return clips.map((clip) => {
    const loading = shape.loading?.(clip.key) ?? false;
    return {
      ...clip,
      attached: loading || (shape.attached?.(clip.key) ?? false),
      loading,
      stalled: loading && (shape.stalled?.(clip.key) ?? false),
    };
  });
}

const NOW = { nowMs: 10_000, lastDetachAtMs: Number.NEGATIVE_INFINITY };

describe("planPreviewMediaBudget", () => {
  it("keeps the current clip, a short past and a lookahead, and drops the rest", () => {
    const clips = strip(40, 4); // clip k spans [4k, 4k+4)
    const keys = new Set(planPreviewMediaBudget(clips, 82).wanted);
    expect(keys.has(20)).toBe(true); // [80, 84) holds the playhead
    expect(keys.has(19)).toBe(true); // ended 2 s ago, inside the retained past
    expect(keys.has(18)).toBe(false); // ended 6 s ago, beyond RETAIN_BEHIND_SECONDS
    expect(keys.has(23)).toBe(true); // starts in exactly RETAIN_AHEAD_SECONDS: still retained
    expect(keys.has(24)).toBe(false); // starts in 14 s
    expect(keys.has(0)).toBe(false);
  });

  it("retains the next few clips however far away they start", () => {
    const clips: BudgetClip<number>[] = [0, 100, 200, 300, 400].map((start, key) => ({
      key,
      start,
      end: start + 5,
      pinned: false,
    }));
    const keys = planPreviewMediaBudget(clips, 1).wanted;
    expect(keys).toHaveLength(1 + RETAIN_UPCOMING_CLIPS);
    expect(keys).not.toContain(4);
  });

  it("never wants more than the cap, cutting by distance from the playhead", () => {
    const clips = strip(200, 0.25);
    const { wanted } = planPreviewMediaBudget(clips, 25.1);
    expect(wanted).toHaveLength(MAX_ACTIVE_PREVIEW_MEDIA);
    expect(wanted[0]).toBe(100); // the clip holding the playhead comes first
  });

  it("never drops a pinned clip, however far away, and counts it against the cap", () => {
    const { wanted } = planPreviewMediaBudget(strip(60, 2, [3]), 100, { cap: 5 });
    expect(wanted).toContain(3);
    expect(wanted).toHaveLength(5);
  });

  it("marks clips about to start as urgent", () => {
    const { urgent } = planPreviewMediaBudget(strip(10, 4), 6.5);
    expect(urgent.has(1)).toBe(true); // holds the playhead
    expect(urgent.has(2)).toBe(true); // starts in 1.5 s
    expect(urgent.has(3)).toBe(false); // starts in 5.5 s: retained, but can wait
  });
});

describe("decidePreviewMediaBudget: attaching", () => {
  it("opens at most MAX_IN_FLIGHT_LOADS non-urgent sources at once, nearest first", () => {
    // The playhead sits between clips, so nothing is urgent and the lookahead wants many.
    const clips = strip(40, 1).map((clip) => ({
      ...clip,
      start: clip.start + 3,
      end: clip.end + 3,
    }));
    const decision = decidePreviewMediaBudget(states(clips), 0, NOW);
    expect(decision.attach).toEqual([0, 1, 2]);
    expect(decision.attach).toHaveLength(MAX_IN_FLIGHT_LOADS);
    expect(decision.pending).toBe(true);
  });

  it("counts loads already in flight against the limit", () => {
    const clips = strip(40, 1).map((clip) => ({
      ...clip,
      start: clip.start + 3,
      end: clip.end + 3,
    }));
    const decision = decidePreviewMediaBudget(states(clips, { loading: (key) => key < 2 }), 0, NOW);
    expect(decision.attach).toEqual([2]);
    const saturated = decidePreviewMediaBudget(
      states(clips, { loading: (key) => key < 3 }),
      0,
      NOW,
    );
    expect(saturated.attach).toEqual([]);
    expect(saturated.pending).toBe(true);
  });

  it("does not count a stalled load, so one stuck source cannot starve the queue", () => {
    const clips = strip(40, 1).map((clip) => ({
      ...clip,
      start: clip.start + 3,
      end: clip.end + 3,
    }));
    const decision = decidePreviewMediaBudget(
      states(clips, { loading: (key) => key < 3, stalled: (key) => key < 3 }),
      0,
      NOW,
    );
    expect(decision.attach).toHaveLength(MAX_IN_FLIGHT_LOADS);
  });

  it("lets the clips under the playhead open ahead of the queue, up to the urgent limit", () => {
    const overlapping: BudgetClip<number>[] = Array.from({ length: 10 }, (_, key) => ({
      key,
      start: 0,
      end: 10,
      pinned: false,
    }));
    const decision = decidePreviewMediaBudget(states(overlapping), 5, NOW);
    expect(decision.attach).toHaveLength(MAX_IN_FLIGHT_URGENT_LOADS);
    expect(decision.pending).toBe(true);
  });

  it("serves an urgent clip before a nearer-queued non-urgent one", () => {
    // 0 is 1 s behind (not urgent), 1 holds the playhead.
    const clips: BudgetClip<number>[] = [
      { key: 0, start: 0, end: 4, pinned: false },
      { key: 1, start: 5, end: 9, pinned: false },
    ];
    const saturatedBy = (n: number) =>
      states(clips, { loading: () => false }).concat(
        Array.from({ length: n }, (_, i) => ({
          key: 10 + i,
          start: 100,
          end: 101,
          pinned: false,
          attached: true,
          loading: true,
          stalled: false,
        })),
      );
    const decision = decidePreviewMediaBudget(saturatedBy(MAX_IN_FLIGHT_LOADS), 5, NOW);
    expect(decision.attach).toEqual([1]);
  });

  it("restores a released clip before it starts", () => {
    const clips = strip(40, 4);
    const decision = decidePreviewMediaBudget(
      states(clips, { attached: (key) => key === 0 }),
      0,
      NOW,
    );
    expect(decision.attach).toContain(2); // starts at 8 s, inside RETAIN_AHEAD_SECONDS
    expect(decision.attach).not.toContain(39);
  });

  it("waits for room under the cap before opening a non-urgent clip", () => {
    const clips = strip(40, 1).map((clip) => ({
      ...clip,
      start: clip.start + 3,
      end: clip.end + 3,
    }));
    const decision = decidePreviewMediaBudget(
      states(clips, { attached: (key) => key >= 24 && key < 24 + MAX_ACTIVE_PREVIEW_MEDIA }),
      0,
      { nowMs: 10_000, lastDetachAtMs: 9_999 },
    );
    expect(decision.attach).toEqual([]);
    expect(decision.pending).toBe(true);
  });
});

describe("decidePreviewMediaBudget: releasing", () => {
  it("never releases a clip whose load has not settled, even one that no longer queues others", () => {
    const clips = strip(40, 4);
    const decision = decidePreviewMediaBudget(
      states(clips, {
        attached: () => true,
        loading: (key) => key >= 30,
        stalled: () => true,
      }),
      0,
      NOW,
    );
    expect(decision.detach).toHaveLength(DETACH_BATCH_SIZE);
    expect(decision.detach.every((key) => key < 30)).toBe(true);
  });

  it("never releases a stalled load either", () => {
    const clips = strip(40, 4);
    const decision = decidePreviewMediaBudget(
      states(clips, {
        attached: (key) => key === 35,
        loading: (key) => key === 39,
        stalled: () => true,
      }),
      0,
      NOW,
    );
    expect(decision.detach).toEqual([35]);
    expect(decision.detach).not.toContain(39);
  });

  it("releases nothing while any load is in flight", () => {
    const clips = strip(40, 4);
    const decision = decidePreviewMediaBudget(
      states(clips, { attached: () => true, loading: (key) => key === 1 }),
      0,
      NOW,
    );
    expect(decision.detach).toEqual([]);
    expect(decision.pending).toBe(true);
  });

  it("releases settled clips in batches, farthest first", () => {
    const clips = strip(40, 4);
    const all = states(clips, { attached: () => true });
    const first = decidePreviewMediaBudget(all, 0, NOW);
    expect(first.detach).toHaveLength(DETACH_BATCH_SIZE);
    expect(first.detach[0]).toBe(39);

    const soon = decidePreviewMediaBudget(all, 0, { nowMs: 10_000, lastDetachAtMs: 9_900 });
    expect(soon.detach).toEqual([]);
    expect(soon.pending).toBe(true);

    const later = decidePreviewMediaBudget(all, 0, {
      nowMs: 10_000,
      lastDetachAtMs: 10_000 - DETACH_INTERVAL_MS,
    });
    expect(later.detach).toHaveLength(DETACH_BATCH_SIZE);
  });

  it("does not release a pinned (audible) clip", () => {
    const decision = decidePreviewMediaBudget(
      states(strip(40, 4, [30]), { attached: () => true }),
      0,
      NOW,
    );
    expect(decision.detach).not.toContain(30);
  });

  it("drains a full scrub in batches, never overlapping loads, and ends at the cap", () => {
    const clips = strip(73, 2);
    const attached = new Set(clips.map((clip) => clip.key));
    const loading = new Set<number>();
    let now = 0;
    let lastDetachAtMs = Number.NEGATIVE_INFINITY;
    let passes = 0;
    let peakInFlight = 0;
    for (;;) {
      const decision = decidePreviewMediaBudget(
        states(clips, { attached: (key) => attached.has(key), loading: (key) => loading.has(key) }),
        70,
        { nowMs: now, lastDetachAtMs },
      );
      for (const key of decision.detach) attached.delete(key);
      for (const key of decision.attach) {
        attached.add(key);
        loading.add(key);
      }
      peakInFlight = Math.max(peakInFlight, loading.size);
      if (decision.detach.length > 0) lastDetachAtMs = now;
      // Every load settles before the next pass.
      loading.clear();
      passes += 1;
      if (!decision.pending) break;
      now += DETACH_INTERVAL_MS;
      expect(passes).toBeLessThan(100);
    }
    expect(attached.size).toBeLessThanOrEqual(MAX_ACTIVE_PREVIEW_MEDIA);
    expect(attached.has(35)).toBe(true); // [70, 72) holds the playhead
    expect(peakInFlight).toBeLessThanOrEqual(MAX_IN_FLIGHT_URGENT_LOADS);
  });

  it("has nothing to do once the wanted set is loaded", () => {
    const clips = strip(40, 4);
    const wanted = planPreviewMediaBudget(clips, 0).wanted;
    const decision = decidePreviewMediaBudget(
      states(clips, { attached: (key) => wanted.includes(key) }),
      0,
      NOW,
    );
    expect(decision).toEqual({ attach: [], detach: [], pending: false });
  });
});

describe("decidePreviewAudioWarmup", () => {
  const waiting = (clips: BudgetClip<number>[], loaded: number[] = []) =>
    clips.map((clip) => ({ ...clip, waiting: !loaded.includes(clip.key) }));

  it("warms what is under or ahead of the playhead, never what it has passed", () => {
    // 1 s clips; the playhead rests in clip 5. Unlimited slots: the window alone decides.
    const { warm } = decidePreviewAudioWarmup(waiting(strip(30, 1)), 5.5, 0, {
      maxInFlight: 100,
      maxInFlightUrgent: 100,
    });
    expect(warm[0]).toBe(5);
    expect([...warm].sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it("does not run ahead to the end of the film once the near clips have loaded", () => {
    // 5 s apart: only the clip under the playhead, the next within 10 s and the next three upcoming
    // clips are wanted. Loaded ones still count as upcoming, so the queue stops there.
    const clips = strip(40, 5);
    const { warm } = decidePreviewAudioWarmup(waiting(clips, [0, 1, 2, 3]), 0.5, 0);
    expect(warm).toEqual([]);
  });

  it("leaves the rest for a later pass while the load slots are taken", () => {
    expect(
      decidePreviewAudioWarmup(waiting(strip(30, 1)), 5.5, MAX_IN_FLIGHT_URGENT_LOADS),
    ).toEqual({ warm: [], pending: true });
    // The ordinary slots are full: only the clips the viewer is about to hear (within 2 s) still open.
    const { warm } = decidePreviewAudioWarmup(waiting(strip(30, 1)), 5.5, MAX_IN_FLIGHT_LOADS);
    expect(warm).toEqual([5, 6, 7]);
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

  /** A video as the preview server serves it: no src, the source in the detached attribute. */
  function video(index: number, attrs: Record<string, string> = {}): PreviewMediaClip {
    const el = document.createElement("video");
    el.setAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR, `clip-${index}.mp4`);
    el.setAttribute("preload", "none");
    el.setAttribute("data-start", String(index * 2));
    el.setAttribute("data-duration", "2");
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    document.body.appendChild(el);
    return { el, start: index * 2, end: index * 2 + 2, mediaStart: index };
  }

  const film = (count = 40) => Array.from({ length: count }, (_, i) => video(i));
  const withSource = (clips: PreviewMediaClip[]) =>
    clips.filter(({ el }) => el.hasAttribute("src")).map(({ mediaStart }) => mediaStart);
  const settle = (el: HTMLMediaElement, type = "loadedmetadata") => {
    Object.defineProperty(el, "readyState", { value: 4, configurable: true });
    el.dispatchEvent(new Event(type));
  };

  function run(
    budget: PreviewMediaBudget,
    clips: PreviewMediaClip[],
    time: number,
    nowMs: number,
    leased: HTMLMediaElement[] = [],
  ) {
    return budget.update({
      clips,
      time,
      nowMs,
      isLeased: (el) => leased.includes(el),
      compositionDuration: () => 1000,
    });
  }

  it("opens nothing at parse: a fresh budget attaches only what the playhead needs, nearest first", () => {
    const clips = film();
    const budget = createPreviewMediaBudget();
    run(budget, clips, 0, 1000);
    // Clip 0 holds the playhead, clip 1 starts in 2 s (urgent), clip 2 is the nearest queued one.
    expect(withSource(clips)).toEqual([0, 1, 2]);
    expect(clips[0]!.el.getAttribute("src")).toBe("clip-0.mp4");
    expect(clips[0]!.el.hasAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR)).toBe(false);
    expect(clips[39]!.el.hasAttribute("src")).toBe(false);
  });

  it("sets preload before src, and does not restart the load it just started", () => {
    const clips = film();
    const order: string[] = [];
    const el = clips[0]!.el;
    const preload = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "preload")!;
    Object.defineProperty(el, "preload", {
      configurable: true,
      get: () => preload.get!.call(el),
      set: (value: string) => {
        order.push("preload");
        preload.set!.call(el, value);
      },
    });
    const setAttribute = el.setAttribute.bind(el);
    vi.spyOn(el, "setAttribute").mockImplementation((name, value) => {
      if (name === "src") order.push("src");
      setAttribute(name, value);
    });
    run(createPreviewMediaBudget(), clips, 0, 1000);
    expect(order).toEqual(["preload", "src"]);
    expect(el.preload).toBe("auto");
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
  });

  it("keeps opening in playhead order as loads settle, never more than the limit at once", () => {
    const clips = film();
    const budget = createPreviewMediaBudget();
    run(budget, clips, 0, 1000);
    expect(withSource(clips)).toEqual([0, 1, 2]);
    // Nothing settled: a later pass opens nothing new.
    run(budget, clips, 0, 1300);
    expect(withSource(clips)).toEqual([0, 1, 2]);

    settle(clips[0]!.el);
    run(budget, clips, 0, 1400);
    expect(withSource(clips)).toEqual([0, 1, 2, 3]);
    settle(clips[1]!.el);
    settle(clips[2]!.el);
    run(budget, clips, 0, 1500);
    expect(withSource(clips)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("tells its owner when a load settles, so the next source opens without waiting for a tick", () => {
    const onLoadSettled = vi.fn();
    const clips = film();
    const budget = createPreviewMediaBudget({}, { onLoadSettled });
    run(budget, clips, 0, 1000);
    expect(onLoadSettled).not.toHaveBeenCalled();
    settle(clips[0]!.el, "error");
    expect(onLoadSettled).toHaveBeenCalledTimes(1);
  });

  it("never releases a video whose load has not settled, then releases it once it has", () => {
    const clips = film();
    const budget = createPreviewMediaBudget();
    run(budget, clips, 0, 1000); // 0, 1, 2 loading
    // A scrub far away: 0-2 are no longer wanted but are still opening.
    for (let pass = 0; pass < 5; pass += 1) run(budget, clips, 70, 2000 + pass * 300);
    for (const index of [0, 1, 2]) {
      expect(clips[index]!.el.getAttribute("src")).toBe(`clip-${index}.mp4`);
    }
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();

    for (const index of [0, 1, 2]) settle(clips[index]!.el);
    for (const { el } of clips) {
      if (
        el.hasAttribute("src") &&
        !["clip-0.mp4", "clip-1.mp4", "clip-2.mp4"].includes(el.getAttribute("src") ?? "")
      ) {
        settle(el);
      }
    }
    for (let pass = 0; pass < 10; pass += 1) run(budget, clips, 70, 4000 + pass * 300);
    for (const index of [0, 1, 2]) expect(clips[index]!.el.hasAttribute("src")).toBe(false);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  });

  it("never releases while another load is in flight", () => {
    const clips = film();
    const budget = createPreviewMediaBudget();
    run(budget, clips, 0, 1000);
    for (const index of [0, 1]) settle(clips[index]!.el); // 2 is still opening
    run(budget, clips, 70, 2000);
    run(budget, clips, 70, 2400);
    expect(clips[0]!.el.hasAttribute("src")).toBe(true);
    expect(clips[1]!.el.hasAttribute("src")).toBe(true);
    settle(clips[2]!.el);
    // The settle opened clips around 70; those are in flight now. Settle whatever is open.
    for (let pass = 0; pass < 12; pass += 1) {
      for (const { el } of clips) if (el.hasAttribute("src")) settle(el);
      run(budget, clips, 70, 3000 + pass * 300);
    }
    expect(clips[0]!.el.hasAttribute("src")).toBe(false);
  });

  it("does not release an element the browser is still opening, even one the budget did not start", () => {
    const clips = film();
    const stray = clips[39]!.el;
    stray.setAttribute("src", "clip-39.mp4");
    stray.removeAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR);
    Object.defineProperty(stray, "networkState", { value: 2, configurable: true });
    const budget = createPreviewMediaBudget();
    for (let pass = 0; pass < 10; pass += 1) run(budget, clips, 0, 1000 + pass * 300);
    expect(stray.hasAttribute("src")).toBe(true);

    Object.defineProperty(stray, "networkState", { value: 1, configurable: true });
    Object.defineProperty(stray, "readyState", { value: 4, configurable: true });
    for (const { el } of clips) if (el.hasAttribute("src") && el !== stray) settle(el);
    for (let pass = 0; pass < 10; pass += 1) run(budget, clips, 0, 5000 + pass * 300);
    expect(stray.hasAttribute("src")).toBe(false);
  });

  it("stops counting a stalled load toward the limit but still never releases it", () => {
    const clips = film();
    const budget = createPreviewMediaBudget();
    run(budget, clips, 0, 1000);
    expect(withSource(clips)).toEqual([0, 1, 2]);
    run(budget, clips, 0, 1000 + LOAD_STALL_MS + 1);
    expect(withSource(clips).length).toBeGreaterThan(3);
    run(budget, clips, 70, 100_000);
    for (const index of [0, 1, 2]) expect(clips[index]!.el.hasAttribute("src")).toBe(true);
  });

  it("never releases a video that is playing or leased", () => {
    const clips = film();
    const budget = createPreviewMediaBudget();
    run(budget, clips, 0, 1000);
    for (const { el } of clips) if (el.hasAttribute("src")) settle(el);
    const audible = clips[1]!.el;
    Object.defineProperty(audible, "paused", { value: false, configurable: true });
    const leased = clips[2]!.el;
    for (let pass = 0; pass < 30; pass += 1) {
      run(budget, clips, 70, 2000 + pass * 400, [leased]);
      for (const { el } of clips) if (el.hasAttribute("src")) settle(el);
    }
    expect(audible.hasAttribute("src")).toBe(true);
    expect(leased.hasAttribute("src")).toBe(true);
    expect(clips[0]!.el.hasAttribute("src")).toBe(false);
  });

  it("leaves a video it may not manage alone, and counts it against the cap", () => {
    const unmanaged = video(30, { "data-duration": "" });
    unmanaged.el.removeAttribute("data-duration");
    unmanaged.el.removeAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR);
    unmanaged.el.setAttribute("src", "clip-30.mp4");
    const clips = [...film(30), unmanaged];
    const budget = createPreviewMediaBudget();
    for (let pass = 0; pass < 30; pass += 1) {
      run(budget, clips, 0, 1000 + pass * 400);
      for (const { el } of clips) if (el.hasAttribute("src")) settle(el);
    }
    expect(unmanaged.el.getAttribute("src")).toBe("clip-30.mp4");
  });

  it("lets a proxy swap replace the source before the load starts", () => {
    const clips = film();
    const prepareSource = vi.fn((el: HTMLMediaElement) =>
      el.setAttribute("src", "clip-0.mp4?hf-proxy=x"),
    );
    run(createPreviewMediaBudget({}, { prepareSource }), clips, 0, 1000);
    expect(prepareSource).toHaveBeenCalledWith(clips[0]!.el);
    expect(clips[0]!.el.getAttribute("src")).toBe("clip-0.mp4?hf-proxy=x");
  });

  it("parks an upcoming clip on its first frame, but leaves a seek the transport made alone", () => {
    const clips = film();
    const budget = createPreviewMediaBudget();
    run(budget, clips, 0, 1000);
    const upcoming = clips[1]!.el;
    upcoming.dispatchEvent(new Event("loadedmetadata"));
    expect(upcoming.currentTime).toBe(1); // mediaStart of the upcoming clip

    const seeked = clips[2]!.el;
    seeked.currentTime = 7.5;
    seeked.dispatchEvent(new Event("loadedmetadata"));
    expect(seeked.currentTime).toBe(7.5);
  });

  it("makes a seek wait for a freshly attached video's first frame", () => {
    const clips = film();
    const budget = createPreviewMediaBudget();
    run(budget, clips, 0, 1000);
    const { el } = clips[0]!;
    expect(isAwaitingRestoredSource(el)).toBe(true);
    Object.defineProperty(el, "readyState", { value: 2, configurable: true });
    expect(isAwaitingRestoredSource(el)).toBe(false);
  });

  it("keeps the last frame of a clip that runs to the composition end", () => {
    const clips = film();
    const budget = createPreviewMediaBudget({ cap: 2 });
    const last = clips[39]!;
    for (let pass = 0; pass < 40; pass += 1) {
      budget.update({
        clips,
        time: last.end,
        nowMs: 10_000 + pass * 300,
        isLeased: () => false,
        compositionDuration: () => last.end,
      });
      for (const { el } of clips) if (el.hasAttribute("src")) settle(el);
    }
    expect(last.el.hasAttribute("src")).toBe(true);
  });

  it("adopts a video released by an earlier runtime from the DOM alone", () => {
    const clips = film();
    const first = createPreviewMediaBudget();
    run(first, clips, 0, 1000);
    const second = createPreviewMediaBudget();
    expect(second.isReleased(clips[39]!.el)).toBe(true);
    expect(second.isReleased(clips[0]!.el)).toBe(false);
  });

  /** A sound effect as the preview server serves it: its src kept, preload none. */
  function sfx(index: number): PreviewMediaClip {
    const el = document.createElement("audio");
    el.setAttribute("src", `sfx-${index}.mp3`);
    el.setAttribute("preload", "none");
    el.setAttribute("data-start", String(index * 2));
    el.setAttribute("data-duration", "0.5");
    document.body.appendChild(el);
    return { el, start: index * 2, end: index * 2 + 0.5, mediaStart: 0 };
  }
  const warmed = (clips: PreviewMediaClip[]) =>
    clips.flatMap((clip, index) => (clip.el.preload === "auto" ? [index] : []));

  it("starts loading only the sound effects near the playhead, a few at a time", () => {
    const clips = Array.from({ length: 40 }, (_, i) => sfx(i));
    const budget = createPreviewMediaBudget();
    // Clip 0 holds the playhead and clip 1 starts in 2 s (both urgent), clip 2 is the nearest queued.
    expect(run(budget, clips, 0, 1000).pending).toBe(true);
    expect(warmed(clips)).toEqual([0, 1, 2]);
    run(budget, clips, 0, 1100);
    expect(warmed(clips)).toEqual([0, 1, 2]);

    settle(clips[0]!.el);
    settle(clips[1]!.el);
    run(budget, clips, 0, 1200);
    expect(warmed(clips)).toEqual([0, 1, 2, 3, 4]);

    // Loads keep settling while the playhead rests: the queue stops at the playhead's window.
    for (let pass = 0; pass < 20; pass += 1) {
      for (const { el } of clips) if (el.preload === "auto") settle(el);
      run(budget, clips, 0, 1300 + pass * 100);
    }
    // Clip 0 under the playhead, clips 1–5 starting within 10 s; clip 6 starts in 12 s.
    expect(warmed(clips)).toEqual([0, 1, 2, 3, 4, 5]);
    // The source stays: the Web Audio transport reads it, and nothing ever restarts a load.
    expect(clips.every(({ el }) => el.hasAttribute("src"))).toBe(true);
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
  });

  it("releases no video while a sound effect is opening, and never releases the sound effect", () => {
    const videos = film(12);
    const effects = [sfx(30)];
    const budget = createPreviewMediaBudget();
    run(budget, videos, 0, 1000);
    for (const { el } of videos) if (el.hasAttribute("src")) settle(el);
    run(budget, videos, 0, 1100);
    expect(withSource(videos)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const { el } of videos) if (el.hasAttribute("src")) settle(el);

    // The playhead jumps next to the sound effect, past every opened video.
    run(budget, [...videos, ...effects], 60, 2000);
    expect(warmed(effects)).toEqual([0]);
    expect(withSource(videos)).toEqual([0, 1, 2, 3, 4, 5]);
    run(budget, [...videos, ...effects], 60, 2000 + DETACH_INTERVAL_MS);
    expect(withSource(videos)).toEqual([0, 1, 2, 3, 4, 5]);

    settle(effects[0]!.el);
    run(budget, [...videos, ...effects], 60, 2000 + 2 * DETACH_INTERVAL_MS);
    expect(withSource(videos).length).toBeLessThan(6);
    expect(effects[0]!.el.getAttribute("src")).toBe("sfx-30.mp3");
  });
});

describe("deferPreviewMediaSources / importPreviewNode", () => {
  const markAsPreview = () =>
    document.head.appendChild(
      Object.assign(document.createElement("meta"), { name: STUDIO_PREVIEW_MARK_META }),
    );
  afterEach(() => {
    document.head.querySelector(`meta[name="${STUDIO_PREVIEW_MARK_META}"]`)?.remove();
    document.body.innerHTML = "";
  });

  const template = () => {
    const tpl = document.createElement("template");
    tpl.innerHTML = `<div><video id="a" src="a.mp4" data-duration="3"></video>
      <video id="loop" src="l.mp4" data-duration="3" loop></video>
      <video id="free" src="f.mp4"></video>
      <audio id="sfx" src="s.mp3" data-duration="0.5"></audio>
      <audio id="bed" src="b.mp3"></audio></div>`;
    return tpl.content;
  };

  it("moves the source of managed videos and holds back paced audio only", () => {
    const content = template();
    deferPreviewMediaSources(content);
    const a = content.querySelector("#a")!;
    expect(a.hasAttribute("src")).toBe(false);
    expect(a.getAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR)).toBe("a.mp4");
    expect(a.getAttribute("preload")).toBe("none");
    expect(content.querySelector("#loop")!.getAttribute("src")).toBe("l.mp4");
    expect(content.querySelector("#free")!.getAttribute("src")).toBe("f.mp4");
    const effect = content.querySelector("#sfx")!;
    expect(effect.getAttribute("src")).toBe("s.mp3");
    expect(effect.getAttribute("preload")).toBe("none");
    expect(content.querySelector("#bed")!.hasAttribute("preload")).toBe(false);
  });

  it("imports a preview clone with no live src ever reaching the document", () => {
    markAsPreview();
    const importNode = vi.spyOn(document, "importNode");
    const clone = importPreviewNode(document, window, template());
    // The only clone made into the live document is the one already stripped in the inert copy.
    const imported = importNode.mock.calls.map(([node]) => node);
    expect(imported).toHaveLength(1);
    expect(imported[0]).not.toBe(clone);
    const [inert] = imported;
    if (!(inert instanceof DocumentFragment)) throw new Error("expected the inert copy");
    expect(inert.querySelector("#a")!.hasAttribute("src")).toBe(false);
    importNode.mockRestore();
    expect(clone.querySelector("#a")!.hasAttribute("src")).toBe(false);
    expect(clone.querySelector("#a")!.getAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR)).toBe("a.mp4");
    expect(clone.querySelector("#a")!.ownerDocument).toBe(document);
    expect(clone.querySelector("#free")!.getAttribute("src")).toBe("f.mp4");
  });

  it("clones untouched outside a preview and while a render drives the page", () => {
    expect(
      importPreviewNode(document, window, template()).querySelector("#a")!.getAttribute("src"),
    ).toBe("a.mp4");
    markAsPreview();
    window.__HF_EXPORT_RENDER_SEEK_CONFIG = { fps: 30, fpsSource: "render-options" };
    try {
      expect(isPreviewMediaBudgetActive(document, window)).toBe(false);
      expect(
        importPreviewNode(document, window, template()).querySelector("#a")!.getAttribute("src"),
      ).toBe("a.mp4");
    } finally {
      delete window.__HF_EXPORT_RENDER_SEEK_CONFIG;
    }
  });
});
