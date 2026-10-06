// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { useAutoScroll } from "./useAutoScroll";

/** Delivers sizes by hand: happy-dom lays nothing out. */
class StubResizeObserver implements ResizeObserver {
  static instances: StubResizeObserver[] = [];
  constructor(readonly callback: ResizeObserverCallback) {
    StubResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function Scroller() {
  const { ref, onScroll } = useAutoScroll(0);
  return <div ref={ref} onScroll={onScroll} data-testid="scroller" />;
}

interface Geometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

/** A scroller's box as the browser would report it, with a scrollTop that sticks. */
function giveGeometry(element: HTMLElement, geometry: Geometry) {
  Object.defineProperties(element, {
    scrollHeight: { get: () => geometry.scrollHeight, configurable: true },
    clientHeight: { get: () => geometry.clientHeight, configurable: true },
    scrollTop: {
      get: () => geometry.scrollTop,
      set: (value: number) => {
        geometry.scrollTop = value;
      },
      configurable: true,
    },
  });
}

async function resized() {
  await act(async () => {
    for (const observer of StubResizeObserver.instances) observer.callback([], observer);
  });
}

async function scrolledTo(element: HTMLElement, geometry: Geometry, top: number) {
  geometry.scrollTop = top;
  await act(async () => {
    element.dispatchEvent(new Event("scroll"));
  });
}

beforeEach(() => {
  StubResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe("useAutoScroll when the scroller's own box changes height", () => {
  const setup = () => {
    const host = mountHost(<Scroller />);
    const element = host.querySelector<HTMLElement>('[data-testid="scroller"]');
    if (!element) throw new Error("no scroller");
    // Pinned to the end of a 1000 px log shown through a 400 px window.
    const geometry: Geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    giveGeometry(element, geometry);
    return { element, geometry };
  };

  it("stays on the newest content when the box gets shorter (the plan dock above it opens)", async () => {
    const { geometry } = setup();
    geometry.clientHeight = 250;
    await resized();
    expect(geometry.scrollTop).toBe(geometry.scrollHeight);
  });

  it("leaves a reader who scrolled up where they are", async () => {
    const { element, geometry } = setup();
    await scrolledTo(element, geometry, 100);
    geometry.clientHeight = 250;
    await resized();
    expect(geometry.scrollTop).toBe(100);
  });

  it("follows again once the reader is back at the bottom", async () => {
    const { element, geometry } = setup();
    await scrolledTo(element, geometry, 100);
    await scrolledTo(element, geometry, geometry.scrollHeight - geometry.clientHeight);
    geometry.clientHeight = 250;
    await resized();
    expect(geometry.scrollTop).toBe(geometry.scrollHeight);
  });
});
