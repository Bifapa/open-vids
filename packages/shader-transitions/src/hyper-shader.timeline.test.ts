// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "./hyper-shader.js";
import { FakeTimeline, mountScenes, stubGsap, stubWebGl } from "./hyper-shader.testStubs.js";

function opacityOf(id: string): string {
  return (document.getElementById(id) as HTMLElement).style.opacity;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "__timelines");
  Reflect.deleteProperty(window, "__hf");
});

// A caller's film: a paused timeline with `seconds` of content.
function providedTimeline(seconds: number): FakeTimeline {
  const tl = new FakeTimeline();
  tl.to({}, { duration: seconds }, 0);
  return tl;
}

describe.each([
  { mode: "preview", webgl: true, engine: false },
  { mode: "preview without WebGL", webgl: false, engine: false },
  { mode: "engine render", webgl: true, engine: true },
])("a timeline passed to init() in $mode", ({ webgl, engine }) => {
  function setup(): void {
    stubGsap();
    stubWebGl(webgl);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (engine) vi.stubGlobal("__HF_VIRTUAL_TIME__", {});
  }

  // The WebGL preview prewarms its transition caches in the background.
  async function settle(): Promise<void> {
    if (webgl && !engine) await Reflect.get(Reflect.get(window, "__hf"), "shaderTransitionsReady");
  }

  it("keeps its own length when the composition declares no duration", async () => {
    setup();
    mountScenes(["a", "b"]);
    const tl = providedTimeline(12);
    init({
      bgColor: "#000",
      scenes: ["a", "b"],
      transitions: [{ time: 5, duration: 1 }],
      timeline: tl,
    });
    await settle();
    expect(tl.duration()).toBe(12);
  });

  it("is extended to the last transition when that ends after the timeline", async () => {
    setup();
    mountScenes(["a", "b"]);
    const tl = providedTimeline(6);
    init({
      bgColor: "#000",
      scenes: ["a", "b"],
      transitions: [{ time: 8, duration: 1.5 }],
      timeline: tl,
    });
    await settle();
    expect(tl.duration()).toBe(9.5);
  });

  it("is extended to a longer declared data-duration", async () => {
    setup();
    mountScenes(["a", "b"], 'data-duration="20"');
    const tl = providedTimeline(12);
    init({
      bgColor: "#000",
      scenes: ["a", "b"],
      transitions: [{ time: 5, duration: 1 }],
      timeline: tl,
    });
    await settle();
    expect(tl.duration()).toBe(20);
  });

  it("is not cut to a data-duration shorter than the timeline", async () => {
    setup();
    mountScenes(["a", "b"], 'data-duration="4"');
    const tl = providedTimeline(12);
    init({
      bgColor: "#000",
      scenes: ["a", "b"],
      transitions: [{ time: 9, duration: 1 }],
      timeline: tl,
    });
    await settle();
    expect(tl.duration()).toBe(12);
  });
});

describe("preview without WebGL", () => {
  function setup(): void {
    stubGsap();
    stubWebGl(false);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  }

  it("still shows one scene at a time and crossfades CSS transitions", () => {
    setup();
    mountScenes(["a", "b"]);
    const tl = init({
      bgColor: "#000",
      scenes: ["a", "b"],
      transitions: [{ time: 5, duration: 1 }],
    });

    tl.time(1);
    expect(opacityOf("a")).not.toBe("0");
    expect(opacityOf("b")).toBe("0");

    tl.time(5.5);
    expect(opacityOf("a")).toBe("0.5");
    expect(opacityOf("b")).toBe("0.5");

    tl.time(6);
    expect(opacityOf("a")).toBe("0");
    expect(opacityOf("b")).toBe("1");
  });

  it("degrades a shader transition to a crossfade instead of stacking the scenes", () => {
    setup();
    mountScenes(["a", "b", "c"]);
    const tl = init({
      bgColor: "#000",
      scenes: ["a", "b", "c"],
      transitions: [
        { time: 3, duration: 1, shader: "domain-warp" },
        { time: 8, duration: 1, shader: "domain-warp" },
      ],
    });

    tl.time(1);
    expect([opacityOf("b"), opacityOf("c")]).toEqual(["0", "0"]);
    tl.time(5);
    expect([opacityOf("a"), opacityOf("b"), opacityOf("c")]).toEqual(["0", "1", "0"]);
    tl.time(9);
    expect([opacityOf("a"), opacityOf("b"), opacityOf("c")]).toEqual(["0", "0", "1"]);
  });

  it("registers the timeline it sequences the scenes on", () => {
    setup();
    mountScenes(["a", "b"]);
    const tl = init({
      bgColor: "#000",
      scenes: ["a", "b"],
      transitions: [{ time: 5, duration: 1 }],
    });
    expect(Reflect.get(Reflect.get(window, "__timelines"), "main")).toBe(tl);
  });
});
