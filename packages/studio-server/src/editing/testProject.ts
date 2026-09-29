import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { classifyMediaColor, type MediaMetadata } from "../helpers/mediaMetadata.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { MediaFacts, type MediaProber } from "./mediaFacts.js";

/** What the fake prober reports per file name; the files themselves are placeholder bytes. */
export const FAKE_MEDIA: Record<string, Partial<MediaMetadata>> = {
  "a.mp4": { kind: "video", durationSeconds: 8, width: 1920, height: 1080, hasAudio: true },
  "b.mp4": { kind: "video", durationSeconds: 5, width: 1280, height: 720, hasAudio: false },
  "photo.png": { kind: "image", width: 800, height: 600 },
  "music.mp3": { kind: "audio", durationSeconds: 30 },
};

export const fakeProber: MediaProber = async (path) => {
  const known = FAKE_MEDIA[basename(path)];
  return { kind: "unknown", color: classifyMediaColor(null), ...known };
};

export const MAIN_HTML = `<!doctype html>
<html>
  <head><style>#root { position: relative; }</style></head>
  <body>
    <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">
      <video id="intro" data-hf-id="hf-intro" class="clip" src="assets/a.mp4" data-start="0" data-duration="4" data-track-index="0" muted playsinline style="position: absolute; left: 0px; top: 0px; width: 1920px; height: 1080px; z-index: 1"></video>
      <div id="title" data-hf-id="hf-title" class="clip" data-start="1" data-duration="2" data-track-index="2" style="position: absolute; z-index: 3">Hello</div>
      <audio id="music" data-hf-id="hf-music" class="clip" src="assets/music.mp3" data-start="0" data-duration="10" data-track-index="3" data-volume="0.5"></audio>
      <div id="host" data-hf-id="hf-host" class="clip" data-composition-id="lower-third" data-composition-src="compositions/lower-third.html" data-start="5" data-duration="3" data-track-index="4"></div>
      <script>
        window.__timelines = window.__timelines || {};
        const tl = gsap.timeline({ paused: true });
        tl.to("#title", { opacity: 1, duration: 1 }, 1);
        window.__timelines["main"] = tl;
      </script>
    </div>
  </body>
</html>
`;

export interface TestProject {
  root: string;
  project: ResolvedProject;
  adapter: StudioApiAdapter;
  facts: MediaFacts;
  read(path: string): string;
  write(path: string, content: string): void;
  cleanup(): void;
}

export function createTestProject(
  options: { html?: string; adapter?: Partial<StudioApiAdapter> } = {},
): TestProject {
  const root = mkdtempSync(join(tmpdir(), "openvids-editing-"));
  const dir = join(root, "project");
  const project: ResolvedProject = { id: "demo", dir };
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  write("index.html", options.html ?? MAIN_HTML);
  for (const name of Object.keys(FAKE_MEDIA)) write(`assets/${name}`, `bytes of ${name}`);
  write("assets/fonts/brand.woff2", "font");
  write("compositions/lower-third.html", LOWER_THIRD_HTML);
  const adapter: StudioApiAdapter = {
    listProjects: () => [project],
    resolveProject: (id) => (id === project.id ? project : null),
    bundle: async () => null,
    lint: () => ({ findings: [] }),
    runtimeUrl: "/runtime.js",
    rendersDir: () => join(dir, "renders"),
    startRender: () => {
      throw new Error("not used");
    },
    ...options.adapter,
  };
  return {
    root,
    project,
    adapter,
    facts: new MediaFacts(fakeProber),
    read: (path) => readFileSync(join(dir, path), "utf-8"),
    write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const LOWER_THIRD_HTML = `<div id="lt-root" data-composition-id="lower-third" data-width="1920" data-height="1080" data-duration="3">
  <div id="lt-bar" class="clip" data-start="0" data-duration="3" data-track-index="0">Lower third</div>
</div>
`;
