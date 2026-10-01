// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CONCURRENT_MEDIA_ELEMENT_LOADS,
  MEDIA_LOAD_SETTLE_TIMEOUT_MS,
} from "../utils/mediaLoadGate";
import { useMediaLoadSlot } from "./useMediaLoadSlot";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Card({ id, enabled = true }: { id: number; enabled?: boolean }) {
  const { granted, release } = useMediaLoadSlot(enabled);
  return granted ? <video data-card={id} onLoadedMetadata={release} /> : <div data-card={id} />;
}

describe("useMediaLoadSlot", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const renderCards = (count: number, enabled = true) =>
    act(async () =>
      root.render(
        <>
          {Array.from({ length: count }, (_, i) => (
            <Card key={i} id={i} enabled={enabled} />
          ))}
        </>,
      ),
    );
  const videoIds = () =>
    Array.from(container.querySelectorAll("video"), (v) => v.getAttribute("data-card"));

  it("renders media for at most MAX_CONCURRENT_MEDIA_ELEMENT_LOADS cards and advances as loads settle", async () => {
    await renderCards(8);
    expect(videoIds()).toEqual(["0", "1", "2"].slice(0, MAX_CONCURRENT_MEDIA_ELEMENT_LOADS));

    // loadedmetadata frees card 0's slot; the next queued card gets it.
    const first = container.querySelector("video");
    await act(async () => {
      first?.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(videoIds()).toContain("3");
  });

  it("frees slots when a card is disabled (hover) and skips queueing when disabled", async () => {
    await renderCards(5);
    expect(videoIds()).toHaveLength(MAX_CONCURRENT_MEDIA_ELEMENT_LOADS);

    await renderCards(5, false);
    expect(videoIds()).toHaveLength(0);

    await renderCards(5, true);
    expect(videoIds()).toHaveLength(MAX_CONCURRENT_MEDIA_ELEMENT_LOADS);
  });

  it("drops a stalled element after the settle timeout so it cannot starve the queue", async () => {
    vi.useFakeTimers();
    await renderCards(4);
    expect(videoIds()).toEqual(["0", "1", "2"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEDIA_LOAD_SETTLE_TIMEOUT_MS);
    });
    expect(videoIds()).toContain("3");
  });
});
