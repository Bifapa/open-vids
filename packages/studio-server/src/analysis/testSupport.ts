import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ResolvedProject,
  SpeakerDiarization,
  SpeechTranscription,
  StudioApiAdapter,
} from "../types.js";

export const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

/**
 * An 8 s clip with a known shape: red 0–2 s, black 2–4 s, white 4–6 s, colour bars 6–8 s (three hard cuts, one black
 * section, every scene static so the picture also counts as frozen), and a sine tone that is muted from 3 s to 5 s.
 */
export function makeClip(file: string, seconds = 8): void {
  mkdirSync(dirname(file), { recursive: true });
  const color = (name: string) => `color=c=${name}:s=320x240:d=2:r=25,format=yuv420p`;
  const run = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      color("red"),
      "-f",
      "lavfi",
      "-i",
      color("black"),
      "-f",
      "lavfi",
      "-i",
      color("white"),
      "-f",
      "lavfi",
      "-i",
      "smptebars=s=320x240:d=2:r=25,format=yuv420p",
      "-f",
      "lavfi",
      "-i",
      `sine=f=440:d=${seconds}`,
      "-filter_complex",
      "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v];[4:a]volume=enable='between(t,3,5)':volume=0[a]",
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-t",
      String(seconds),
      file,
    ],
    { encoding: "utf-8" },
  );
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
}

/** Words of a short talk around the silent gap: two sentences before it, two after, the last one said twice. */
export const SCRIPT: SpeechTranscription["words"] = [
  ...words("Welcome to the show today.", 0.2, 0.4),
  ...words("We talk about cameras.", 1.4, 0.35),
  ...words("Now the second part starts.", 5.1, 0.35),
  ...words("Thanks for watching.", 6.6, 0.3),
  ...words("Thanks for watching.", 7.2, 0.15),
];

function words(sentence: string, start: number, each: number): SpeechTranscription["words"] {
  return sentence.split(" ").map((text, index) => ({
    text,
    start: Math.round((start + index * each) * 1000) / 1000,
    end: Math.round((start + (index + 1) * each - 0.05) * 1000) / 1000,
  }));
}

export interface FakeSpeech {
  transcribeCalls: number;
  diarizeCalls: number;
  /** Words the next recognition returns. */
  words: SpeechTranscription["words"];
  /** Rejects with `unavailable` instead of recognizing. */
  unavailable: string | null;
  /** When set, recognition waits until the signal aborts (a stuck recognizer). */
  hang: boolean;
  abortedCalls: number;
  /** When set, the recognizer prints nothing and answers only after this resolves (a long, silent decode). */
  hold: Promise<void> | null;
}

export interface TestProject {
  root: string;
  project: ResolvedProject;
  adapter: StudioApiAdapter;
  speech: FakeSpeech;
  path(relative: string): string;
  cleanup(): void;
}

export interface TestProjectOptions {
  /** Provide the adapter's recognizer and diarizer (default true). */
  speech?: boolean;
}

/** A temp project (an `index.html` only) with an adapter whose recognizer and diarizer are fakes. */
export function createAnalysisProject(options: TestProjectOptions = {}): TestProject {
  const root = mkdtempSync(join(tmpdir(), "openvids-analysis-"));
  const dir = join(root, "project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html></html>");
  const project: ResolvedProject = { id: "demo", dir };
  const speech: FakeSpeech = {
    transcribeCalls: 0,
    diarizeCalls: 0,
    words: SCRIPT,
    unavailable: null,
    hang: false,
    abortedCalls: 0,
    hold: null,
  };
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
  };
  if (options.speech !== false) {
    adapter.transcribeMedia = async ({ signal }) => {
      speech.transcribeCalls += 1;
      if (speech.unavailable) return { unavailable: speech.unavailable };
      if (speech.hang) {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              speech.abortedCalls += 1;
              reject(new Error("recognition aborted"));
            },
            { once: true },
          );
        });
      }
      await speech.hold;
      return { words: speech.words, language: "en", producer: "fake recognizer" };
    };
    adapter.diarizeMedia = async (): Promise<SpeakerDiarization | { unavailable: string }> => {
      speech.diarizeCalls += 1;
      return { unavailable: "No diarizer in tests" };
    };
  }
  return {
    root,
    project,
    adapter,
    speech,
    path: (relative) => join(dir, relative),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Copies the shared test clip into a project. */
export function addClip(test: TestProject, clip: string, relative: string): void {
  mkdirSync(dirname(test.path(relative)), { recursive: true });
  copyFileSync(clip, test.path(relative));
}

/** Runs ffmpeg to make a test input; throws with ffmpeg's message when it fails. */
export function ffmpegSync(args: string[]): void {
  const run = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { encoding: "utf-8" });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
}

/**
 * Waits for a condition that only a real child process or the file system can bring about (ffmpeg started, a killed
 * process gone), so fake timers cannot drive it. Checked every 20 ms, up to a minute.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
): Promise<void> {
  for (let waited = 0; waited < 60_000; waited += 20) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
