// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import { compileForRender } from "./htmlCompiler.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-asset-paths-"));
  tempDirs.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

describe("compileForRender mounted sub-composition asset paths", () => {
  it("rewrites inline-style url(), poster and srcset the way the preview bundle does", async () => {
    const dir = project({
      "index.html": `<!doctype html>
<html><body>
  <div data-composition-id="root" data-width="320" data-height="180">
    <div data-composition-id="scene" data-composition-src="compositions/scene.html"
      data-start="0" data-duration="2"></div>
  </div>
</body></html>`,
      "compositions/bg.png": "png",
      "compositions/bg@2x.png": "png",
      "compositions/scene.html": `<div data-composition-id="scene" data-width="320" data-height="180">
  <div id="bg" style="background-image:url(bg.png)"></div>
  <img id="pic" src="bg.png" srcset="bg.png 1x, bg@2x.png 2x" alt="">
  <video id="vid" src="../assets/clip.mp4" poster="../assets/poster.jpg"></video>
</div>`,
    });
    const { html } = await compileForRender(dir, join(dir, "index.html"), join(dir, ".downloads"), {
      allowSystemFontCapture: false,
    });
    const { document } = parseHTML(html);

    expect(document.getElementById("bg")?.getAttribute("style")).toContain(
      "url(compositions/bg.png)",
    );
    expect(document.getElementById("pic")?.getAttribute("src")).toBe("compositions/bg.png");
    expect(document.getElementById("pic")?.getAttribute("srcset")).toBe(
      "compositions/bg.png 1x, compositions/bg@2x.png 2x",
    );
    expect(document.getElementById("vid")?.getAttribute("poster")).toBe("assets/poster.jpg");
  });
});
