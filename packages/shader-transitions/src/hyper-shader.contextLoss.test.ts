// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "./hyper-shader.js";
import { mountScenes, stubGsap, stubWebGl } from "./hyper-shader.testStubs.js";

// jsdom cannot rasterise a scene; hand the prewarm a canvas that encodes to a blob so the
// transition reaches the textured (WebGL) path.
vi.mock("./capture.js", () => ({
  initCapture: () => {},
  captureScene: async () => ({
    width: 0,
    height: 0,
    toBlob: (done: BlobCallback) => done(new Blob(["x"])),
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "__timelines");
  Reflect.deleteProperty(window, "__hf");
});

const glCanvas = (): HTMLCanvasElement => {
  const canvas = document.getElementById("gl-canvas");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("no gl-canvas");
  return canvas;
};

const opacityOf = (id: string): string =>
  (document.getElementById(id) as HTMLElement).style.opacity;

async function startTexturedTransition() {
  stubGsap();
  const gl = stubWebGl(true);
  vi.stubGlobal("createImageBitmap", async () => ({}));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mountScenes(["a", "b"]);
  const tl = init({
    bgColor: "#000",
    scenes: ["a", "b"],
    transitions: [{ time: 2, duration: 1, shader: "domain-warp" }],
    previewCaptureFps: 1,
  });
  await Reflect.get(Reflect.get(window, "__hf"), "shaderTransitionsReady");
  tl.time(2.5);
  await vi.waitFor(() => expect(glCanvas().style.display).toBe("block"));
  return { tl, gl };
}

describe("a WebGL context lost during a shader transition", () => {
  it("lets the browser restore the context and falls back to the CSS crossfade meanwhile", async () => {
    const { tl } = await startTexturedTransition();

    const lost = new Event("webglcontextlost", { cancelable: true });
    glCanvas().dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    // No transparent canvas over the scenes: the crossfade carries the transition.
    expect(glCanvas().style.display).toBe("none");
    expect([opacityOf("a"), opacityOf("b")]).toEqual(["0.5", "0.5"]);

    tl.time(2.75);
    expect(glCanvas().style.display).toBe("none");
    expect([opacityOf("a"), opacityOf("b")]).toEqual(["0.15625", "0.84375"]);
  });

  it("rebuilds its GL resources and composites again once the context is restored", async () => {
    const { tl, gl } = await startTexturedTransition();
    const quads = gl.calls.get("createBuffer") ?? 0;
    const programs = gl.calls.get("createProgram") ?? 0;
    const framebuffers = gl.calls.get("createFramebuffer") ?? 0;
    const textures = gl.calls.get("createTexture") ?? 0;

    glCanvas().dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(glCanvas().style.display).toBe("none");
    glCanvas().dispatchEvent(new Event("webglcontextrestored"));

    expect(gl.calls.get("createBuffer")).toBeGreaterThan(quads);
    expect(gl.calls.get("createProgram")).toBeGreaterThan(programs);
    expect(gl.calls.get("createFramebuffer")).toBeGreaterThan(framebuffers);
    // The transition textures are uploaded again on demand, not carried over from the dead context.
    await vi.waitFor(() => expect(glCanvas().style.display).toBe("block"));
    expect(gl.calls.get("createTexture")).toBeGreaterThan(textures);

    tl.time(2.6);
    expect(glCanvas().style.display).toBe("block");
  });
});
