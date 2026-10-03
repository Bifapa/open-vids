// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomEditSelection } from "../components/editor/domEditing";
import { usePlayerStore } from "../player";
import { mountReactHarness } from "./domSelectionTestHarness";
import type { CommitMutationOptions } from "./gsapScriptCommitTypes";
import { useGestureCommit } from "./useGestureCommit";
import type { GestureSample } from "./useGestureRecording";

const gestureRecording = vi.hoisted(() => ({
  startRecording: vi.fn(),
  stopRecording: vi.fn((): GestureSample[] => [
    { time: 0, properties: { x: 0, y: 0, opacity: 1 } },
    { time: 0.5, properties: { x: 50, y: 25, opacity: 0.5 } },
    { time: 1, properties: { x: 100, y: 50, opacity: 0 } },
  ]),
  clearSamples: vi.fn(),
  isRecording: false,
  recordingDuration: 0,
  samplesRef: { current: [] },
  trailRef: { current: [] },
}));

vi.mock("./useGestureRecording", () => ({
  useGestureRecording: () => gestureRecording,
}));

vi.mock("../utils/rdpSimplify", () => ({
  simplifyGestureSamples: () =>
    new Map([
      [0, { x: 0, y: 0, opacity: 1 }],
      [50, { x: 50, y: 25, opacity: 0.5 }],
      [100, { x: 100, y: 50, opacity: 0 }],
    ]),
}));

vi.mock("../utils/gestureSmoother", () => ({
  smoothGestureKeyframes: (keyframes: unknown) => keyframes,
}));

vi.mock("../utils/velocityEaseFitter", () => ({
  fitEasesFromVelocity: (keyframes: unknown) => keyframes,
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  usePlayerStore.getState().reset();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function makeSelection(element: HTMLElement): DomEditSelection {
  return {
    id: element.id,
    element,
    label: "Card",
    tagName: "div",
    sourceFile: "index.html",
    compositionPath: "index.html",
    isCompositionHost: false,
    isInsideLockedComposition: false,
    boundingBox: { x: 0, y: 0, width: 100, height: 100 },
    textContent: null,
    dataAttributes: { start: "0", duration: "2" },
    inlineStyles: {},
    computedStyles: {},
    textFields: [],
    capabilities: {
      canSelect: true,
      canEditStyles: true,
      canCrop: true,
      canMove: true,
      canResize: true,
      canApplyManualOffset: true,
      canApplyManualSize: true,
      canApplyManualRotation: true,
    },
  };
}

const NO_MODIFIERS = { shift: false, alt: false, meta: false };

function mountGesture(options: { readOnlyPreview?: boolean; selected?: boolean } = {}) {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const element = document.createElement("div");
  element.id = "card";
  const commitMutation = vi.fn<
    (mutation: Record<string, unknown>, options: CommitMutationOptions) => Promise<void>
  >(async () => {});
  const showToast = vi.fn();
  const isGestureRecordingRef = { current: false };
  const sessionRef = {
    current: {
      domEditSelection: options.selected === false ? null : makeSelection(element),
      selectedGsapAnimations: [],
      commitMutation,
    },
  };
  const captured: { hook: ReturnType<typeof useGestureCommit> | null } = { hook: null };
  function Probe() {
    captured.hook = useGestureCommit({
      domEditSessionRef: sessionRef,
      previewIframeRef: { current: iframe },
      showToast,
      isGestureRecordingRef,
      readOnlyPreview: options.readOnlyPreview ?? false,
    });
    return null;
  }
  const root = mountReactHarness(<Probe />);
  cleanup = () => act(() => root.unmount());
  const hook = () => {
    if (!captured.hook) throw new Error("hook did not initialize");
    return captured.hook;
  };
  return { hook, element, iframe, commitMutation, showToast, isGestureRecordingRef };
}

describe("useGestureCommit", () => {
  it("coalesces property-group commits and reloads only the terminal group", async () => {
    const { hook, commitMutation } = mountGesture();

    act(() => hook().handleToggleRecording());
    act(() => hook().beginRecording({ x: 900, y: 300 }, NO_MODIFIERS));
    act(() => hook().finishRecording());
    await act(async () => {
      await vi.waitFor(() => expect(commitMutation).toHaveBeenCalledTimes(2));
    });

    const options = commitMutation.mock.calls.map((call) => call[1]);
    expect(new Set(options.map((entry) => entry.coalesceKey)).size).toBe(1);
    expect(options[0]).toEqual(expect.objectContaining({ coalesceMs: Infinity, skipReload: true }));
    expect(options[0]).not.toHaveProperty("softReload");
    expect(options[1]).toEqual(expect.objectContaining({ coalesceMs: Infinity, softReload: true }));
    expect(options[1]).not.toHaveProperty("skipReload");
  });

  it("arms on the first toggle without recording or committing anything", () => {
    const { hook, commitMutation, isGestureRecordingRef } = mountGesture();

    act(() => hook().handleToggleRecording());

    expect(hook().gestureState).toBe("armed");
    expect(isGestureRecordingRef.current).toBe(true);
    expect(gestureRecording.startRecording).not.toHaveBeenCalled();
    expect(commitMutation).not.toHaveBeenCalled();
  });

  it("starts recording at the pointer-down point, not at wherever the pointer was when armed", () => {
    const { hook, element, iframe } = mountGesture();

    act(() => hook().handleToggleRecording());
    act(() => hook().beginRecording({ x: 900, y: 300 }, { shift: false, alt: true, meta: false }));

    expect(hook().gestureState).toBe("recording");
    expect(gestureRecording.startRecording).toHaveBeenCalledTimes(1);
    expect(gestureRecording.startRecording).toHaveBeenCalledWith(element, iframe, {
      elementEndTime: 2,
      startPointer: { x: 900, y: 300 },
      modifiers: { shift: false, alt: true, meta: false },
    });
  });

  it("ignores a pointer press while nothing is armed", () => {
    const { hook } = mountGesture();

    act(() => hook().beginRecording({ x: 10, y: 10 }, NO_MODIFIERS));

    expect(hook().gestureState).toBe("idle");
    expect(gestureRecording.startRecording).not.toHaveBeenCalled();
  });

  it("cancels an armed recording without committing, and R toggles it off the same way", () => {
    const { hook, commitMutation, isGestureRecordingRef } = mountGesture();

    act(() => hook().handleToggleRecording());
    let handled = false;
    act(() => {
      handled = hook().cancelRecording();
    });
    expect(handled).toBe(true);
    expect(hook().gestureState).toBe("idle");
    expect(isGestureRecordingRef.current).toBe(false);

    act(() => hook().handleToggleRecording());
    expect(hook().gestureState).toBe("armed");
    act(() => hook().handleToggleRecording());
    expect(hook().gestureState).toBe("idle");
    expect(gestureRecording.startRecording).not.toHaveBeenCalled();
    expect(commitMutation).not.toHaveBeenCalled();
  });

  it("cancels a running recording on Esc: nothing is committed and the playhead goes back", async () => {
    const { hook, commitMutation, showToast } = mountGesture();
    usePlayerStore.getState().setCurrentTime(1.25);
    const requestSeek = vi.spyOn(usePlayerStore.getState(), "requestSeek");

    act(() => hook().handleToggleRecording());
    act(() => hook().beginRecording({ x: 900, y: 300 }, NO_MODIFIERS));
    usePlayerStore.getState().setCurrentTime(1.9);
    let handled = false;
    act(() => {
      handled = hook().cancelRecording();
    });
    // A pointer release arriving after Esc must not commit what was dropped.
    act(() => hook().finishRecording());
    await act(async () => {
      await Promise.resolve();
    });

    expect(handled).toBe(true);
    expect(hook().gestureState).toBe("idle");
    expect(gestureRecording.stopRecording).toHaveBeenCalledTimes(1);
    expect(gestureRecording.clearSamples).toHaveBeenCalled();
    expect(requestSeek).toHaveBeenCalledWith(1.25);
    expect(commitMutation).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    act(() => {
      handled = hook().cancelRecording();
    });
    expect(handled).toBe(false);
  });

  it("commits nothing when the press is released without any motion", async () => {
    const { hook, commitMutation, showToast } = mountGesture();
    gestureRecording.stopRecording.mockReturnValueOnce([
      { time: 0, properties: { x: 0, y: 0 } },
      { time: 0.1, properties: { x: 0, y: 0 } },
      { time: 0.2, properties: { x: 0, y: 0 } },
    ]);

    act(() => hook().handleToggleRecording());
    act(() => hook().beginRecording({ x: 900, y: 300 }, NO_MODIFIERS));
    act(() => hook().finishRecording());
    await act(async () => {
      await Promise.resolve();
    });

    expect(commitMutation).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.any(String), "error");
    expect(hook().gestureState).toBe("idle");
  });

  it("refuses to arm without a selected element", () => {
    const { hook, showToast } = mountGesture({ selected: false });

    act(() => hook().handleToggleRecording());

    expect(hook().gestureState).toBe("idle");
    expect(showToast).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("does not arm while the preview is read-only", () => {
    const { hook, commitMutation } = mountGesture({ readOnlyPreview: true });

    act(() => hook().handleToggleRecording());

    expect(hook().gestureState).toBe("idle");
    expect(gestureRecording.startRecording).not.toHaveBeenCalled();
    expect(commitMutation).not.toHaveBeenCalled();
  });
});
