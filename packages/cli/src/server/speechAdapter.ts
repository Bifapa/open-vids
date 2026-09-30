/**
 * The Studio server's speech capabilities (`transcribeMedia`, `diarizeMedia`), implemented by running this CLI's own
 * `transcribe` / `diarize` commands as child processes. The whisper path is synchronous (execFileSync), so it must
 * never run inside the server process; a child also keeps the native sherpa-onnx addon and the recognizer's memory
 * out of the server, and lets Abort stop the whole tree.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeakerDiarization, SpeechTranscription } from "@hyperframes/studio-server";
import { failureMessage, runCli, type CliChildDeps, type CliRun } from "./cliChild.js";

/** Multilingual, so the language is detected (the user base speaks more than English). */
const WHISPER_MODEL = "small";

export interface SpeechAdapterDeps extends CliChildDeps {
  /** Where the transcribe command writes; removed afterwards. */
  makeTempDir?: () => string;
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
