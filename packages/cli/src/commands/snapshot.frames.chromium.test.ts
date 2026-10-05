import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findSystemBrowser } from "../browser/manager.js";
import { captureSnapshots } from "./snapshot.js";
import { studioEditBodyScripts } from "../utils/studioFrameScripts.js";

// A real capture needs a Chrome; Windows runners are left to the release build (fonts and the static server are slow there).
const chrome = process.platform === "win32" ? undefined : findSystemBrowser();

function composition(id: string, background: string, label: string): string {
  return `<!doctype html>
<html><head><style>html,body{margin:0}#root{position:relative;width:1280px;height:720px;overflow:hidden;background:${background}}
.t{position:absolute;left:100px;top:100px;color:#fff;font:700 80px sans-serif}</style></head>
<body><div id="root" data-composition-id="${id}" data-width="1280" data-height="720" data-duration="4">
<div class="t">${label}</div>
<script>window.__timelines=window.__timelines||{};window.__timelines["${id}"]={duration:()=>4,seek(){},pause(){}};</script>
</div></body></html>
`;
}

describe.runIf(chrome)("JPEG composition frames (real Chrome)", () => {
  let root: string;
  let previousBrowser: string | undefined;
  beforeAll(() => {
    previousBrowser = process.env.HYPERFRAMES_BROWSER_PATH;
    process.env.HYPERFRAMES_BROWSER_PATH = chrome?.executablePath;
    root = mkdtempSync(join(tmpdir(), "openvids-frames-test-"));
    mkdirSync(join(root, "compositions"));
    writeFileSync(join(root, "index.html"), composition("main", "#102030", "Main"));
    writeFileSync(
      join(root, "compositions", "other.html"),
      composition("other", "#a03020", "Other"),
    );
  });
  afterAll(() => {
    if (previousBrowser === undefined) delete process.env.HYPERFRAMES_BROWSER_PATH;
    else process.env.HYPERFRAMES_BROWSER_PATH = previousBrowser;
    rmSync(root, { recursive: true, force: true });
  });

  async function capture(entryFile?: string) {
    const out = mkdtempSync(join(root, "out-"));
    const frames: Array<{
      index: number;
      time: number;
      duration: number;
      path: string;
      width: number;
      height: number;
    }> = [];
    await captureSnapshots(root, {
      at: [0, 99],
      outputDir: out,
      timeout: 30_000,
      includeEnd: false,
      clampToDuration: true,
      image: { width: 320, quality: 70 },
      ...(entryFile && { entryFile }),
      onFrame: (frame) => frames.push(frame),
    });
    return frames;
  }

  it("writes downscaled JPEGs, moves a time past the end to the last readable frame and reports the length", async () => {
    const frames = await capture();
    expect(frames.map((frame) => frame.index)).toEqual([0, 1]);
    expect(frames[0]).toMatchObject({ time: 0, duration: 4, width: 320, height: 180 });
    expect(frames[1]?.time).toBeCloseTo(3.88, 5);
    for (const frame of frames) {
      expect(frame.path.endsWith(".jpg")).toBe(true);
      expect([...readFileSync(frame.path).subarray(0, 2)]).toEqual([0xff, 0xd8]);
    }
  }, 60_000);

  it("captures the requested composition instead of index.html", async () => {
    const main = await capture();
    const other = await capture("compositions/other.html");
    expect(readFileSync(other[0]!.path).equals(readFileSync(main[0]!.path))).toBe(false);
  }, 60_000);

  it("keeps the files already in the output directory", async () => {
    const out = mkdtempSync(join(root, "keep-"));
    const existing = join(out, "photo.png");
    writeFileSync(existing, "not really a png");
    await captureSnapshots(root, {
      at: [0],
      outputDir: out,
      timeout: 30_000,
      includeEnd: false,
      image: { width: 320, quality: 70 },
      cleanOutput: false,
    });
    expect(readFileSync(existing, "utf8")).toBe("not really a png");
  }, 60_000);

  describe("Studio position edits", () => {
    /** A box Studio moved 400px right; the fake timeline overwrites `translate` on every seek, as GSAP does. */
    function box(attrs: { moved: boolean }): string {
      const position = attrs.moved
        ? `left:100px;--hf-studio-offset-x:400px;--hf-studio-offset-y:0px;translate:var(--hf-studio-offset-x) var(--hf-studio-offset-y)`
        : `left:500px`;
      const edit = attrs.moved ? ` data-hf-studio-path-offset="true"` : "";
      return `<!doctype html>
<html><head><style>html,body{margin:0}#root{position:relative;width:1280px;height:720px;overflow:hidden;background:#000}
#box{position:absolute;top:200px;width:200px;height:200px;background:#f00}</style></head>
<body><div id="root" data-composition-id="drag" data-width="1280" data-height="720" data-duration="4">
<div id="box"${edit} style="${position}"></div>
<script>window.__timelines=window.__timelines||{};
window.__timelines["drag"]={duration:()=>4,pause(){},seek(){var b=document.getElementById("box");b.style.translate="0px 0px";b.style.background="#0f0";}};</script>
</div></body></html>
`;
    }

    async function frameOf(
      dir: string,
      scripts?: (html: string) => readonly string[],
    ): Promise<Buffer> {
      const out = mkdtempSync(join(dir, "out-"));
      const paths: string[] = [];
      await captureSnapshots(dir, {
        at: [1],
        outputDir: out,
        timeout: 30_000,
        includeEnd: false,
        image: { width: 320, quality: 70 },
        ...(scripts && { bodyScripts: scripts }),
        onFrame: (frame) => paths.push(frame.path),
      });
      return readFileSync(paths[0]!);
    }

    function projectWith(html: string): string {
      const dir = mkdtempSync(join(root, "drag-"));
      writeFileSync(join(dir, "index.html"), html);
      return dir;
    }

    it("shows a dragged, seek-animated element where Studio put it once the edit scripts are injected", async () => {
      const moved = projectWith(box({ moved: true }));
      const placed = projectWith(box({ moved: false }));
      const withoutScripts = await frameOf(moved);
      const withScripts = await frameOf(moved, (html) =>
        studioEditBodyScripts(moved, html, undefined),
      );
      const reference = await frameOf(placed);
      expect(withScripts.equals(reference)).toBe(true);
      expect(withoutScripts.equals(reference)).toBe(false);
    }, 90_000);
  });
});
