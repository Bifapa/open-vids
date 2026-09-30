/**
 * The Studio server's speech capabilities (`transcribeMedia`, `diarizeMedia`), implemented by running this CLI's own
 * `transcribe` / `diarize` commands as child processes. The whisper path is synchronous (execFileSync), so it must
 * never run inside the server process; a child also keeps the native sherpa-onnx addon and the recognizer's memory
 * out of the server, and lets Abort stop the whole tree.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeakerDiarization, SpeechTranscription } from "@hyperframes/studio-server";

/** Multilingual, so the language is detected (the user base speaks more than English). */
const WHISPER_MODEL = "small";
const KILL_GRACE_MS = 3000;

export interface CliInvocation {
  command: string;
  /** Everything before the subcommand: runtime flags, then the CLI entry. */
  prefix: string[];
}

/**
 * This process, run again. The packaged sidecar starts `bun serve.mjs cli.js preview ...`, and serve.mjs spawns
 * `bun cli.js ...`, so execPath is the bundled runtime and argv[1] the CLI entry there too. In source mode the
 * loader flags (`--import tsx`) live in execArgv.
 */
export function selfInvocation(): CliInvocation {
  const entry = process.argv[1];
  if (!entry) throw new Error("cannot locate the CLI entry (process.argv[1] is empty)");
  const runtimeFlags = process.execArgv.filter((a) => !a.startsWith("--inspect"));
  return { command: process.execPath, prefix: [...runtimeFlags, entry] };
}

export interface SpeechAdapterDeps {
  spawn?: typeof nodeSpawn;
  invocation?: () => CliInvocation;
  /** Where the transcribe command writes; removed afterwards. */
  makeTempDir?: () => string;
}

interface RunOptions {
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

interface CliRun {
  code: number | null;
  /** The last stdout line that was a JSON object, if any. */
  json: Record<string, unknown> | null;
  stderrTail: string;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

const running = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Signals the child's whole process group (the CLI and the whisper/sherpa children it started). */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // already gone
  }
}

/** A dying server must not leave a recognizer running for minutes. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of running) killTree(child, "SIGKILL");
  });
}

function lastJsonObject(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return Object.fromEntries(Object.entries(parsed));
      }
    } catch {
      // not the result line
    }
  }
  return null;
}

function runCli(
  args: string[],
  { signal, onProgress }: RunOptions,
  deps: SpeechAdapterDeps,
): Promise<CliRun> {
  signal.throwIfAborted();
  const { command, prefix } = (deps.invocation ?? selfInvocation)();
  const child = (deps.spawn ?? nodeSpawn)(command, [...prefix, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group on POSIX so Abort reaches whisper-cli and the sherpa worker too.
    detached: process.platform !== "win32",
    env: process.env,
  });
  installExitHook();
  running.add(child);

  return new Promise<CliRun>((resolve, reject) => {
    let stdout = "";
    let stderrTail = "";
    let pending = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        stderrTail = `${stderrTail}\n${text}`.slice(-2000);
        onProgress?.(text);
      }
    });

    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const settle = () => {
      running.delete(child);
      signal.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
    };
    child.on("error", (err) => {
      settle();
      reject(err);
    });
    child.on("close", (code) => {
      settle();
      if (signal.aborted) {
        // The CLI is gone; make sure nothing it started (whisper-cli, the sherpa worker) outlives it.
        killTree(child, "SIGKILL");
        reject(abortError(signal));
      } else {
        resolve({ code, json: lastJsonObject(stdout), stderrTail: stderrTail.trim() });
      }
    });
  });
}

function failureMessage(what: string, run: CliRun): string {
  if (typeof run.json?.error === "string") return run.json.error;
  const how = run.code === null ? "was stopped by a signal" : `exited with code ${run.code}`;
  return `${what} ${how}${run.stderrTail ? `: ${run.stderrTail.split("\n").at(-1)}` : ""}`;
}

/** A `{skipped: true}` result: a setup condition (no recognizer, unsupported platform, offline). */
function unavailableReason(run: CliRun, what: string): string | null {
  if (run.json?.skipped !== true) return null;
  if (typeof run.json.error === "string") return run.json.error;
  return `${what} is unavailable on this machine (${String(run.json.reason ?? "skipped")})`;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** The normalized words the transcribe command left in `<dir>/transcript.json`. */
function readWords(path: string): SpeechTranscription["words"] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(parsed)) throw new Error("transcript.json is not a word list");
  const items: unknown[] = parsed;
  const words: SpeechTranscription["words"] = [];
  for (const item of items) {
    const rawText = field(item, "text");
    const text = typeof rawText === "string" ? rawText.trim() : "";
    const start = field(item, "start");
    const end = field(item, "end");
    if (text && finiteNumber(start) && finiteNumber(end) && end >= start) {
      words.push({ text, start, end });
    }
  }
  return words;
}

function producerOf(json: Record<string, unknown>): string {
  const model = typeof json.model === "string" ? json.model : null;
  if (json.engine === "whisper") return `whisper.cpp ${model ?? WHISPER_MODEL}`;
  return model ?? (typeof json.engine === "string" ? json.engine : "cli transcribe");
}

export async function transcribeMediaViaCli(
  opts: {
    inputPath: string;
    language?: string;
    signal: AbortSignal;
    onProgress?: (message: string) => void;
  },
  deps: SpeechAdapterDeps = {},
): Promise<SpeechTranscription | { unavailable: string }> {
  const dir = (deps.makeTempDir ?? (() => mkdtempSync(join(tmpdir(), "openvids-asr-"))))();
  try {
    opts.onProgress?.("Transcribing with the local speech recognizer...");
    const run = await runCli(
      [
        "transcribe",
        opts.inputPath,
        "--dir",
        dir,
        "--json",
        "--model",
        WHISPER_MODEL,
        ...(opts.language ? ["--language", opts.language] : []),
      ],
      opts,
      deps,
    );
    const unavailable = unavailableReason(run, "The speech recognizer");
    if (unavailable !== null) return { unavailable };
    if (run.code !== 0 || run.json?.ok !== true) {
      throw new Error(`Transcription failed: ${failureMessage("transcribe", run)}`);
    }
    const language =
      typeof run.json.language === "string" && run.json.language ? run.json.language : null;
    return {
      words: readWords(join(dir, "transcript.json")),
      language,
      producer: producerOf(run.json),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function diarizeMediaViaCli(
  opts: { inputPath: string; signal: AbortSignal; onProgress?: (message: string) => void },
  deps: SpeechAdapterDeps = {},
): Promise<SpeakerDiarization | { unavailable: string }> {
  const run = await runCli(["diarize", opts.inputPath, "--json"], opts, deps);
  const unavailable = unavailableReason(run, "Speaker diarization");
  if (unavailable !== null) return { unavailable };
  const turns = run.json?.turns;
  if (run.code !== 0 || run.json?.ok !== true || !Array.isArray(turns)) {
    throw new Error(`Speaker diarization failed: ${failureMessage("diarize", run)}`);
  }
  const items: unknown[] = turns;
  const checked = items.map((turn) => {
    const speaker = field(turn, "speaker");
    const start = field(turn, "start");
    const end = field(turn, "end");
    if (
      typeof speaker !== "number" ||
      !Number.isInteger(speaker) ||
      !finiteNumber(start) ||
      !finiteNumber(end) ||
      end <= start
    ) {
      throw new Error(`Speaker diarization returned a bad turn: ${JSON.stringify(turn)}`);
    }
    return { speaker, start, end };
  });
  const producer = typeof run.json.producer === "string" ? run.json.producer : "sherpa-onnx";
  return { turns: checked, producer };
}
