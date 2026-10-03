// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetRangesView } from "@hyperframes/agent-protocol";
import { mediaClient } from "./mediaClient";
import { assetRangesStore, refreshAssetRanges, saveAssetRange } from "./assetRangesStore";

const view = (ranges: AssetRangesView["ranges"]): AssetRangesView => ({ ranges });

beforeEach(() => {
  vi.useFakeTimers();
  assetRangesStore.setState({
    projectId: "demo",
    ranges: new Map([["assets/music.mp3", { start: 10, end: 20 }]]),
    loaded: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the picked-fragment store", () => {
  it("shows a new pick at once and keeps the server's clamped answer", async () => {
    let answer: (value: AssetRangesView) => void = () => {};
    vi.spyOn(mediaClient, "setRange").mockReturnValue(
      new Promise<AssetRangesView>((resolve) => {
        answer = resolve;
      }),
    );

    const saving = saveAssetRange("demo", "assets/music.mp3", { start: 42, end: 90 });
    expect(assetRangesStore.getState().ranges.get("assets/music.mp3")).toEqual({
      start: 42,
      end: 90,
    });

    answer(view({ "assets/music.mp3": { start: 42, end: 75 } }));
    await expect(saving).resolves.toEqual({ start: 42, end: 75 });
    expect(assetRangesStore.getState().ranges.get("assets/music.mp3")).toEqual({
      start: 42,
      end: 75,
    });
  });

  it("clears a pick with null and answers null", async () => {
    const setRange = vi.spyOn(mediaClient, "setRange").mockResolvedValue(view({}));

    await expect(saveAssetRange("demo", "assets/music.mp3", null)).resolves.toBeNull();

    expect(setRange).toHaveBeenCalledWith("demo", "assets/music.mp3", null);
    expect(assetRangesStore.getState().ranges.has("assets/music.mp3")).toBe(false);
  });

  it("reloads what the server holds when the save fails, instead of keeping the unsaved pick", async () => {
    vi.spyOn(mediaClient, "setRange").mockRejectedValue(new Error("disk full"));
    // The server's truth differs from both the starting state and the unsaved pick.
    const ranges = vi
      .spyOn(mediaClient, "ranges")
      .mockResolvedValue(view({ "assets/music.mp3": { start: 5, end: 8 } }));

    await expect(
      saveAssetRange("demo", "assets/music.mp3", { start: 42, end: 75 }),
    ).rejects.toThrow("disk full");

    await vi.waitFor(() => expect(ranges).toHaveBeenCalledTimes(1));
    expect(assetRangesStore.getState().ranges.get("assets/music.mp3")).toEqual({
      start: 5,
      end: 8,
    });
  });

  it("picks up a pick changed elsewhere (undo, another window) on a refresh", async () => {
    vi.spyOn(mediaClient, "ranges").mockResolvedValue(
      view({ "assets/music.mp3": { start: 1, end: 2 }, "assets/clip.mp4": { start: 3, end: 4 } }),
    );

    refreshAssetRanges();
    refreshAssetRanges();
    await vi.advanceTimersByTimeAsync(300);

    expect(mediaClient.ranges).toHaveBeenCalledTimes(1);
    expect([...assetRangesStore.getState().ranges]).toEqual([
      ["assets/music.mp3", { start: 1, end: 2 }],
      ["assets/clip.mp4", { start: 3, end: 4 }],
    ]);
  });

  it("drops an answer for a project that is no longer open", async () => {
    let answer: (value: AssetRangesView) => void = () => {};
    vi.spyOn(mediaClient, "ranges").mockReturnValue(
      new Promise<AssetRangesView>((resolve) => {
        answer = resolve;
      }),
    );
    refreshAssetRanges();
    await vi.advanceTimersByTimeAsync(300);

    assetRangesStore.setState({ projectId: "other", ranges: new Map(), loaded: false });
    answer(view({ "assets/music.mp3": { start: 1, end: 2 } }));
    await vi.advanceTimersByTimeAsync(0);

    expect(assetRangesStore.getState().ranges.size).toBe(0);
  });
});
