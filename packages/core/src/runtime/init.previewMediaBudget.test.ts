import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_PREVIEW_DETACHED_SRC_ATTR, STUDIO_PREVIEW_MARK_META } from "../studioPreviewMark";
import { initSandboxRuntimeModular } from "./init";
import {
  MAX_IN_FLIGHT_LOADS,
  MAX_IN_FLIGHT_URGENT_LOADS,
  SCRUB_SETTLE_MS,
} from "./previewMediaBudget";
import type { RuntimeTimelineLike } from "./types";
import {
  createMockTimeline,
  installImmediateAnimationFrame,
  resetRuntimeFixtureDom,
} from "./runtimeSeekFixture.test-helpers";

const CLIPS = 40;

/** Clips as the Studio server serves a preview: no `src`, the source in the detached attribute. */
function mountServedClips(served: boolean): void {
  const source = (src: string) =>
    served ? `${STUDIO_PREVIEW_DETACHED_SRC_ATTR}="${src}" preload="none"` : `src="${src}"`;
  const clips = Array.from(
    { length: CLIPS },
    (_unused, i) =>
      `<video id="clip${i}" ${source("assets/source.mp4")} data-start="${i * 2}" data-duration="2"></video>`,
  ).join("");
  document.body.innerHTML = `<div data-composition-id="main" data-root="true" data-start="0">${clips}</div>`;
  window.__timelines = { main: createMockTimeline(CLIPS * 2) };
}

function markAsStudioPreview(): void {
  document.head.appendChild(
    Object.assign(document.createElement("meta"), { name: STUDIO_PREVIEW_MARK_META }),
  );
}

const videosWithSource = () =>
  Array.from(document.querySelectorAll("video")).filter((video) => video.hasAttribute("src"));

describe("preview media budget in the runtime", () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;

  beforeEach(() => {
    resetRuntimeFixtureDom();
    installImmediateAnimationFrame();
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  afterEach(() => {
    window.__hfRuntimeTeardown?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    document.head.querySelector(`meta[name="${STUDIO_PREVIEW_MARK_META}"]`)?.remove();
    document.body.innerHTML = "";
    window.__timelines = {} as Record<string, RuntimeTimelineLike>;
    delete window.__HF_EXPORT_RENDER_SEEK_CONFIG;
    delete window.__player;
    delete window.__playerReady;
    delete window.__renderReady;
  });

  it("opens only the clips under the playhead and the next few at boot, never the whole film", () => {
    mountServedClips(true);
    markAsStudioPreview();
    initSandboxRuntimeModular();

    const opened = videosWithSource();
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.length).toBeLessThanOrEqual(MAX_IN_FLIGHT_LOADS);
    expect(document.getElementById("clip0")?.hasAttribute("src")).toBe(true);
    const far = document.getElementById("clip39")!;
    expect(far.hasAttribute("src")).toBe(false);
    expect(far.getAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR)).toBe("assets/source.mp4");
    expect(far.getAttribute("preload")).toBe("none");
  });

  it("opens the next sources as loads settle, without waiting for a playback tick", () => {
    vi.useFakeTimers();
    mountServedClips(true);
    markAsStudioPreview();
    initSandboxRuntimeModular();
    const before = videosWithSource();

    for (const video of before) {
      Object.defineProperty(video, "readyState", { value: 4, configurable: true });
      video.dispatchEvent(new Event("loadedmetadata"));
    }
    vi.advanceTimersByTime(50);

    expect(videosWithSource().length).toBeGreaterThan(before.length);
  });

  it("gives the clip a seek lands on its source once the playhead rests", () => {
    vi.useFakeTimers();
    mountServedClips(true);
    markAsStudioPreview();
    initSandboxRuntimeModular();
    const far = document.getElementById("clip39")!;
    expect(far.hasAttribute("src")).toBe(false);

    window.__player!.seek(39 * 2 + 0.5);
    expect(far.hasAttribute("src")).toBe(false);
    vi.advanceTimersByTime(SCRUB_SETTLE_MS + 1);

    expect(far.getAttribute("src")).toBe("assets/source.mp4");
    expect(far.hasAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR)).toBe(false);
    expect(videosWithSource().length).toBeLessThanOrEqual(
      MAX_IN_FLIGHT_LOADS + MAX_IN_FLIGHT_URGENT_LOADS,
    );
  });

  it("plans for where a scrub rests, not for every stop on the way", () => {
    vi.useFakeTimers();
    mountServedClips(true);
    markAsStudioPreview();
    initSandboxRuntimeModular();
    const before = videosWithSource().length;
    for (let stop = 0; stop < 12; stop += 1) {
      window.__player!.seek(10 + stop * 6.1);
      vi.advanceTimersByTime(SCRUB_SETTLE_MS - 20);
    }
    expect(videosWithSource()).toHaveLength(before);
    vi.advanceTimersByTime(SCRUB_SETTLE_MS + 1);
    expect(videosWithSource().length).toBeLessThanOrEqual(before + MAX_IN_FLIGHT_URGENT_LOADS);
    // The clip under the playhead where it came to rest (10 + 11 * 6.1 = 77.1 s -> clip 38).
    expect(document.getElementById("clip38")!.hasAttribute("src")).toBe(true);
  });

  it("never releases the clips a scrub left behind while they are still opening", () => {
    vi.useFakeTimers();
    mountServedClips(true);
    markAsStudioPreview();
    initSandboxRuntimeModular();
    const opened = videosWithSource();
    for (let scrub = 0; scrub < 6; scrub += 1) {
      window.__player!.seek(30 + scrub * 7.3);
      vi.advanceTimersByTime(SCRUB_SETTLE_MS + 1);
    }
    for (const video of opened) expect(video.hasAttribute("src")).toBe(true);
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled();
  });

  it("leaves every source alone outside a Studio preview", () => {
    mountServedClips(false);
    initSandboxRuntimeModular();
    window.__player!.seek(10);
    expect(videosWithSource()).toHaveLength(CLIPS);
  });

  it("leaves every source alone while a render drives the page", () => {
    mountServedClips(false);
    markAsStudioPreview();
    window.__HF_EXPORT_RENDER_SEEK_CONFIG = { fps: 30, fpsSource: "render-options" };
    initSandboxRuntimeModular();
    window.__player!.seek(10);
    expect(videosWithSource()).toHaveLength(CLIPS);
  });
});
