import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";

export { hasFfmpeg } from "../analysis/testSupport.js";

const SIZE = "160x120";

/** Runs ffmpeg quietly; throws with its message when it fails. */
export function ffmpeg(args: string[]): void {
  mkdirSync(dirname(args[args.length - 1] ?? "."), { recursive: true });
  const run = spawnSync("ffmpeg", ["-y", "-nostdin", "-loglevel", "error", ...args], {
    encoding: "utf-8",
  });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
}

/** A moving picture (frame counter and gradients), so nothing in it counts as frozen or black. */
const moving = (seconds: number) => ["-f", "lavfi", "-i", `testsrc2=s=${SIZE}:r=25:d=${seconds}`];
const tone = (seconds: number, filter = "anull") => [
  "-f",
  "lavfi",
  "-i",
  `sine=f=440:d=${seconds},${filter}`,
];
const encode = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"];
/** A picture that never changes (a talking card, a slide). */
const card = (seconds: number) => [
  "-f",
  "lavfi",
  "-i",
  `color=c=0x204080:s=${SIZE}:r=25:d=${seconds}`,
];

/** Project media: a 6 s clip with a tone, a 2 s silent clip, and a 6 s card that never moves. */
export function makeMedia(dir: string): void {
  ffmpeg([...moving(6), ...tone(6), ...encode, "-t", "6", join(dir, "a.mp4")]);
  ffmpeg([...moving(2), ...encode, "-an", "-t", "2", join(dir, "short.mp4")]);
  ffmpeg([...card(6), ...tone(6), ...encode, "-t", "6", join(dir, "card.mp4")]);
  // The same card with faint temporal noise, kept at high quality: still to the eye, not to a −60 dB comparison.
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=0x204080:s=${SIZE}:r=25:d=6,noise=alls=4:allf=t`,
    ...tone(6),
    "-c:v",
    "libx264",
    "-crf",
    "10",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-t",
    "6",
    join(dir, "noisycard.mp4"),
  ]);
}

/** Renders with one known defect each, made straight with ffmpeg (they stand in for what the renderer produced). */
export const RENDERS = {
  /** 0–2 s picture, 2–3.5 s black, 3.5–5.5 s picture; a tone all along. */
  blackGap(file: string): void {
    ffmpeg([
      ...moving(2),
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${SIZE}:r=25:d=1.5`,
      ...moving(2),
      ...tone(5.5),
      "-filter_complex",
      "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map",
      "[v]",
      "-map",
      "3:a",
      ...encode,
      "-t",
      "5.5",
      file,
    ]);
  },
  /** 2 s of moving picture, then its last frame held for 3 s; a tone all along. */
  frozenTail(file: string): void {
    ffmpeg([
      ...moving(2),
      ...tone(5),
      "-vf",
      "tpad=stop_mode=clone:stop_duration=3",
      ...encode,
      "-t",
      "5",
      file,
    ]);
  },
  /** 6 s of moving picture; the tone is silent from 2 s to 4.5 s. */
  silentStretch(file: string): void {
    ffmpeg([
      ...moving(6),
      ...tone(6, "volume=enable='between(t,2,4.5)':volume=0"),
      ...encode,
      "-t",
      "6",
      file,
    ]);
  },
  /** 5 s of a picture that never changes, with a tone. */
  staticCard(file: string): void {
    ffmpeg([...card(5), ...tone(5), ...encode, "-t", "5", file]);
  },
  /** 6 s of moving picture and a steady tone: nothing wrong. */
  clean(file: string): void {
    ffmpeg([...moving(6), ...tone(6), ...encode, "-t", "6", file]);
  },
  /** 4 s of moving picture and no audio stream. */
  videoOnly(file: string): void {
    ffmpeg([...moving(4), ...encode, "-an", "-t", "4", file]);
  },
};

export interface ClipSpec {
  id: string;
  /** The element's source markup attributes, e.g. `src="assets/a.mp4" data-start="0"`. */
  attrs: string;
  tag?: "video" | "audio" | "div";
  text?: string;
}

/** A main composition of `duration` seconds with the given clips. */
export function composition(duration: number, clips: ClipSpec[]): string {
  const body = clips
    .map(({ id, attrs, tag = "video", text = "" }) =>
      tag === "div"
        ? `<div id="${id}" data-hf-id="hf-${id}" class="clip" ${attrs}>${text}</div>`
        : `<${tag} id="${id}" data-hf-id="hf-${id}" class="clip" ${attrs}></${tag}>`,
    )
    .join("\n      ");
  return `<!doctype html>
<html><body>
  <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="${duration}">
      ${body}
  </div>
</body></html>
`;
}

export interface QaProject {
  root: string;
  project: ResolvedProject;
  adapter: StudioApiAdapter;
  path(relative: string): string;
  write(relative: string, content: string): void;
  cleanup(): void;
}

/** A temp project holding copies of the shared media, an `index.html` and an adapter (extend it with `adapter`). */
export function createQaProject(options: {
  media: string;
  html: string;
  adapter?: Partial<StudioApiAdapter>;
}): QaProject {
  const root = mkdtempSync(join(tmpdir(), "openvids-qa-"));
  const dir = join(root, "project");
  const project: ResolvedProject = { id: "demo", dir };
  const path = (relative: string) => join(dir, relative);
  const write = (relative: string, content: string) => {
    mkdirSync(dirname(path(relative)), { recursive: true });
    writeFileSync(path(relative), content);
  };
  for (const name of ["a.mp4", "short.mp4", "card.mp4", "noisycard.mp4"]) {
    mkdirSync(path("assets"), { recursive: true });
    copyFileSync(join(options.media, name), path(`assets/${name}`));
  }
  write("index.html", options.html);
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
    path,
    write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
