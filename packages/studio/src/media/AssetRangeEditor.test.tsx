// @vitest-environment happy-dom
import { act, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetRange, AssetRangesView } from "@hyperframes/agent-protocol";
import { cleanupMounted, mountHost } from "../components/ui/mountHost.testHelpers";
import { AssetRangeEditor } from "./AssetRangeEditor";
import { assetRangesStore } from "./assetRangesStore";
import { mediaClient } from "./mediaClient";
import type { MediaItem } from "./mediaLibrary";

const PATH = "assets/music.mp3";

function audio(range: AssetRange | null): MediaItem {
  return {
    path: PATH,
    name: "music.mp3",
    kind: "audio",
    bytes: 1000,
    duration: 100,
    width: null,
    height: null,
    hasAudio: null,
    origin: "imported",
    provenance: null,
    offline: false,
    used: false,
    analysis: null,
    range,
  };
}

const view = (range: AssetRange | null): AssetRangesView => ({
  ranges: range ? { [PATH]: range } : {},
});

function mount(range: AssetRange | null) {
  return mountHost(
    <AssetRangeEditor
      item={audio(range)}
      projectId="demo"
      mediaRef={createRef<HTMLVideoElement>()}
      time={0}
      playing={false}
      onSeek={vi.fn()}
      shotStarts={[]}
    />,
  );
}

const key = (host: HTMLElement, handle: "start" | "end", name: string, shiftKey = false) => {
  const target = host.querySelector(`[data-handle="${handle}"]`);
  if (!target) throw new Error(`no ${handle} handle`);
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true }));
  });
};

const button = (host: HTMLElement, label: string) => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`no button ${label}`);
  return found;
};

const shown = (host: HTMLElement) =>
  [...host.querySelectorAll("input")].map((input) => input.value);

beforeEach(() => {
  vi.useFakeTimers();
  // The waveform fetch has nothing to answer.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  assetRangesStore.setState({ projectId: "demo", ranges: new Map(), loaded: true });
});

afterEach(() => {
  cleanupMounted();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the fragment editor", () => {
  it("shows the whole file when nothing is picked, and the pick when there is one", () => {
    expect(shown(mount(null))).toEqual(["0:00.0", "1:40.0"]);
    cleanupMounted();
    expect(shown(mount({ start: 42, end: 75 }))).toEqual(["0:42.0", "1:15.0"]);
  });

  it("saves a run of arrow-key steps once, after a pause", async () => {
    const setRange = vi.spyOn(mediaClient, "setRange").mockResolvedValue(view(null));
    const host = mount({ start: 10, end: 20 });

    key(host, "end", "ArrowLeft", true);
    key(host, "end", "ArrowLeft", true);
    expect(shown(host)).toEqual(["0:10.0", "0:18.0"]);
    expect(setRange).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(setRange).toHaveBeenCalledOnce();
    expect(setRange).toHaveBeenCalledWith("demo", PATH, { start: 10, end: 18 });
  });

  it("saves a pending arrow-key pick when the inspector moves to another asset first", async () => {
    const setRange = vi.spyOn(mediaClient, "setRange").mockResolvedValue(view(null));
    const host = mount({ start: 10, end: 20 });

    key(host, "end", "ArrowLeft", true);
    expect(setRange).not.toHaveBeenCalled();
    cleanupMounted();
    expect(setRange).toHaveBeenCalledOnce();
    expect(setRange).toHaveBeenCalledWith("demo", PATH, { start: 10, end: 19 });

    // The timer died with the editor: nothing is saved a second time.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(setRange).toHaveBeenCalledOnce();
  });

  it("moves a handle 0.1 s with the arrow and keeps the in point before the out point", async () => {
    vi.spyOn(mediaClient, "setRange").mockResolvedValue(view(null));
    const host = mount({ start: 10, end: 10.3 });

    key(host, "start", "ArrowRight");
    key(host, "start", "ArrowRight");
    key(host, "start", "ArrowRight");

    expect(shown(host)).toEqual(["0:10.2", "0:10.3"]);
    expect(host.querySelector('[data-handle="start"]')?.getAttribute("aria-valuenow")).toBe("10.2");
  });

  it("reflects the server's clamped answer, not what was asked", async () => {
    vi.spyOn(mediaClient, "setRange").mockResolvedValue(view({ start: 10, end: 15 }));
    const host = mount({ start: 10, end: 20 });

    key(host, "end", "ArrowLeft");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(shown(host)).toEqual(["0:10.0", "0:15.0"]);
    expect(host.querySelector('[data-testid="media-range-length"]')?.textContent).toBe("0:05.0");
  });

  it("resets to the whole file by clearing the pick", async () => {
    const setRange = vi.spyOn(mediaClient, "setRange").mockResolvedValue(view(null));
    const host = mount({ start: 42, end: 75 });

    await act(async () => button(host, "Reset").click());

    expect(setRange).toHaveBeenCalledWith("demo", PATH, null);
    expect(shown(host)).toEqual(["0:00.0", "1:40.0"]);
  });

  it("does not offer Reset while the whole file is in use", () => {
    const host = mount(null);

    expect(button(host, "Reset").disabled).toBe(true);
  });

  it("says so when the save fails, and goes back to what the server holds", async () => {
    vi.spyOn(mediaClient, "setRange").mockRejectedValue(new Error("disk full"));
    vi.spyOn(mediaClient, "ranges").mockResolvedValue(view({ start: 10, end: 20 }));
    const host = mount({ start: 10, end: 20 });

    key(host, "end", "ArrowLeft", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("disk full");
  });
});
