import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_PREVIEW_DETACHED_SRC_ATTR, STUDIO_PREVIEW_MARK_META } from "../studioPreviewMark";
import { initSandboxRuntimeModular } from "./init";
import { MAX_ACTIVE_PREVIEW_MEDIA } from "./previewMediaBudget";
import type { RuntimeTimelineLike } from "./types";
import {
  createMockTimeline,
  installImmediateAnimationFrame,
  resetRuntimeFixtureDom,
} from "./runtimeSeekFixture.test-helpers";

const CLIPS = 40;

function mountClips(): void {
  const clips = Array.from(
    { length: CLIPS },
    (_unused, i) =>
      `<video id="clip${i}" src="assets/source.mp4" data-start="${i * 2}" data-duration="2"></video>`,
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

  it("keeps a source only on the clips near the playhead in a Studio preview", () => {
    mountClips();
    markAsStudioPreview();
    initSandboxRuntimeModular();

    const loaded = videosWithSource();
    expect(loaded.length).toBeLessThanOrEqual(MAX_ACTIVE_PREVIEW_MEDIA);
    expect(loaded.length).toBeLessThan(CLIPS);
    expect(document.getElementById("clip0")?.hasAttribute("src")).toBe(true);
    const far = document.getElementById("clip39")!;
    expect(far.hasAttribute("src")).toBe(false);
    expect(far.getAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR)).toBe("assets/source.mp4");
  });

  it("gives the clip under the playhead its source back the moment a seek lands on it", () => {
    mountClips();
    markAsStudioPreview();
    initSandboxRuntimeModular();
    const far = document.getElementById("clip39")!;
    expect(far.hasAttribute("src")).toBe(false);

    window.__player!.seek(39 * 2 + 0.5);

    expect(far.getAttribute("src")).toBe("assets/source.mp4");
    expect(far.hasAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR)).toBe(false);
  });

  it("leaves every source alone outside a Studio preview", () => {
    mountClips();
    initSandboxRuntimeModular();
    window.__player!.seek(10);
    expect(videosWithSource()).toHaveLength(CLIPS);
  });

  it("leaves every source alone while a render drives the page", () => {
    mountClips();
    markAsStudioPreview();
    window.__HF_EXPORT_RENDER_SEEK_CONFIG = { fps: 30, fpsSource: "render-options" };
    initSandboxRuntimeModular();
    window.__player!.seek(10);
    expect(videosWithSource()).toHaveLength(CLIPS);
  });

  it("hands every source back when the runtime is torn down", () => {
    mountClips();
    markAsStudioPreview();
    initSandboxRuntimeModular();
    expect(videosWithSource().length).toBeLessThan(CLIPS);

    window.__hfRuntimeTeardown?.();

    expect(videosWithSource()).toHaveLength(CLIPS);
  });
});
