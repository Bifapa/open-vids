/**
 * Offline speaker diarization with sherpa-onnx: pyannote segmentation 3.0 finds who is active in each window, a
 * speaker-embedding model describes every stretch of speech, and threshold clustering decides how many voices
 * there are (or `--speakers N` fixes it).
 *
 * It reuses the Parakeet runtime install (`SHERPA_RUNTIME_DIR`) and, like the Parakeet decode, runs in a child
 * process: the native addon never loads into the CLI or the Studio server, and an onnxruntime abort takes only the
 * worker down.
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadToFile } from "../utils/httpsDownload.js";
import { isInstalled } from "../utils/optionalPackages.js";
import { stoppedByCancelSignal } from "../utils/renderCancellation.js";
import { SHERPA_RESULT_PREFIX } from "./parakeet.js";
import {
  DecodeCancelled,
  ensureModelFiles,
  failureReason,
  installSherpaRuntime,
  SHERPA_RUNTIME_DIR,
  sherpaUnsupportedReason,
  type ModelFile,
} from "./sherpa.js";
import { getPreparedWavDurationSeconds } from "./transcribe.js";

/** What `diarize --json` reports as `producer`. */
export const DIARIZATION_MODEL_LABEL = "sherpa-onnx pyannote-segmentation-3.0 + nemo-titanet-small";

export const DIARIZATION_MODEL_DIR = join(homedir(), ".cache", "hyperframes", "diarization");

export interface DiarizationModelFile extends ModelFile {
  url: string;
}

/**
 * The segmentation model is the release's `model.onnx` (k2-fsa/sherpa-onnx tag `speaker-segmentation-models`),
 * fetched unpacked from a pinned revision of its huggingface.co mirror: same bytes, no bzip2 needed. The embedding
 * model is a release asset of tag `speaker-recongition-models` (sic). Order matters: segmentation, embedding.
 */
export const DIARIZATION_MODEL_FILES: readonly DiarizationModelFile[] = [
  {
    name: "pyannote-segmentation-3-0.onnx",
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/model.onnx",
    bytes: 5_992_913,
    sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
  },
  {
    name: "nemo_en_titanet_small.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx",
    bytes: 40_257_283,
    sha256: "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e",
  },
];

/** Clustering distance threshold when the speaker count is unknown; 0.3–0.7 gave the same counts on test voices. */
const CLUSTER_THRESHOLD = 0.5;
/** Speech shorter than this is a breath or click, not a turn; gaps shorter than this do not split a turn. */
const MIN_DURATION_ON_SECONDS = 0.3;
const MIN_DURATION_OFF_SECONDS = 0.5;
export const MAX_SPEAKERS = 32;

/** At least 10 minutes, and once the audio length for slow CPUs (it runs ~30x realtime on Apple Silicon). */
const diarizeTimeoutMs = (audioSeconds: number) =>
  Math.max(600_000, Math.ceil(audioSeconds * 1000));

/** Diarization cannot run here (unsupported platform, or the runtime/models cannot be fetched offline). */
export class DiarizationUnavailableError extends Error {
  readonly code = "DIARIZATION_UNAVAILABLE" as const;
  constructor(message: string) {
    super(message);
    this.name = "DiarizationUnavailableError";
  }
}

export function isDiarizationUnavailable(err: unknown): err is DiarizationUnavailableError {
  if (err instanceof DiarizationUnavailableError) return true;
  return err instanceof Error && "code" in err && err.code === "DIARIZATION_UNAVAILABLE";
}

/** Why diarization cannot run here, or null. Same platforms as the sherpa-onnx runtime. */
export function diarizationUnsupportedReason(): string | null {
  const why = sherpaUnsupportedReason();
  return why === null ? null : why.replace(/^Parakeet/, "Speaker diarization");
}

/** Sizes only (install verified the hashes). */
export function diarizationModelsInstalled(
  dir = DIARIZATION_MODEL_DIR,
  files: readonly ModelFile[] = DIARIZATION_MODEL_FILES,
): boolean {
  return files.every(
    (f) => statSync(join(dir, f.name), { throwIfNoEntry: false })?.size === f.bytes,
  );
}

export function diarizationInstalled(): boolean {
  return isInstalled(SHERPA_RUNTIME_DIR, "sherpa-onnx-node") && diarizationModelsInstalled();
}

const OFFLINE =
  /ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|network|Could not download/i;

interface InstallOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  dir?: string;
  files?: readonly DiarizationModelFile[];
  download?: typeof downloadToFile;
}

/**
 * Makes the runtime and both models available: false when everything was already there. Throws
 * DiarizationUnavailableError when the platform is unsupported or the fetch failed for lack of a network.
 */
export async function installDiarization({
  signal,
  onProgress,
  dir = DIARIZATION_MODEL_DIR,
  files = DIARIZATION_MODEL_FILES,
  download,
}: InstallOptions = {}): Promise<boolean> {
  const unsupported = diarizationUnsupportedReason();
  if (unsupported) throw new DiarizationUnavailableError(unsupported);
  try {
    if (!isInstalled(SHERPA_RUNTIME_DIR, "sherpa-onnx-node")) {
      onProgress?.("Installing the sherpa-onnx runtime (once)...");
    }
    const runtime = await installSherpaRuntime({ signal });
    let lastPct = -1;
    const models = await ensureModelFiles({
      dir,
      files,
      urlFor: (file) => file.url,
      download,
      signal,
      onBytes: (done, total) => {
        const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
        if (pct === lastPct || pct % 10 !== 0) return;
        lastPct = pct;
        onProgress?.(`Downloading the diarization models... ${pct}%`);
      },
    });
    return runtime || models;
  } catch (err) {
    if (signal?.aborted || err instanceof DecodeCancelled) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (OFFLINE.test(message)) {
      throw new DiarizationUnavailableError(
        `Speaker diarization needs a one-time download and it failed: ${message.split("\n")[0]}`,
      );
    }
    throw err;
  }
}

export interface SpeakerTurn {
  speaker: number;
  start: number;
  end: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Worker output to turns: finite, non-negative, ordered by time, ms precision; anything else is a broken worker. */
export function parseTurns(raw: unknown): SpeakerTurn[] {
  if (!Array.isArray(raw)) throw new Error("the diarizer returned no segment list");
  const segments: unknown[] = raw;
  const turns: SpeakerTurn[] = [];
  for (const seg of segments) {
    const bad = `the diarizer returned an invalid segment ${JSON.stringify(seg)}`;
    if (typeof seg !== "object" || seg === null) throw new Error(bad);
    const speaker = "speaker" in seg ? seg.speaker : undefined;
    const start = "start" in seg ? seg.start : undefined;
    const end = "end" in seg ? seg.end : undefined;
    if (
      typeof speaker !== "number" ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isInteger(speaker) ||
      speaker < 0 ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start
    ) {
      throw new Error(bad);
    }
    turns.push({ speaker, start: round3(start), end: round3(end) });
  }
  return turns.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function diarizationConfig(
  dir: string,
  speakers?: number,
  files: readonly ModelFile[] = DIARIZATION_MODEL_FILES,
): object {
  const [segmentation, embedding] = files.map((f) => join(dir, f.name));
  return {
    segmentation: {
      pyannote: { model: segmentation },
      numThreads: 4,
      debug: 0,
      provider: "cpu",
    },
    embedding: { model: embedding, numThreads: 4, debug: 0, provider: "cpu" },
    clustering: { numClusters: speakers ?? -1, threshold: CLUSTER_THRESHOLD },
    minDurationOn: MIN_DURATION_ON_SECONDS,
    minDurationOff: MIN_DURATION_OFF_SECONDS,
  };
}

/** Diarizes a 16 kHz mono 16-bit WAV in a child process. The caller owns the WAV and the cancellation scope. */
export function diarizeWav(
  wavPath: string,
  options: { signal: AbortSignal; speakers?: number; dir?: string },
): Promise<SpeakerTurn[]> {
  const sourceMode = import.meta.url.endsWith(".ts");
  const worker = new URL(sourceMode ? "./diarizeWorker.ts" : "./diarizeWorker.js", import.meta.url);
  const args = [...(sourceMode ? ["--import", "tsx"] : []), fileURLToPath(worker)];
  const input = {
    wavPath,
    runtimeDir: SHERPA_RUNTIME_DIR,
    config: diarizationConfig(options.dir ?? DIARIZATION_MODEL_DIR, options.speakers),
  };
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        env: { ...process.env, HYPERFRAMES_DIARIZE_INPUT: JSON.stringify(input) },
        maxBuffer: 64 * 1024 * 1024,
        timeout: diarizeTimeoutMs(getPreparedWavDurationSeconds(wavPath) ?? 0),
        signal: options.signal,
      },
      (err, stdout, stderr) => {
        if (options.signal.aborted || (err && stoppedByCancelSignal(err))) {
          reject(new DecodeCancelled("Diarization cancelled"));
          return;
        }
        const line = stdout.split("\n").find((l) => l.startsWith(SHERPA_RESULT_PREFIX));
        if (err || !line) {
          reject(new Error(`Speaker diarizer ${failureReason(err, stderr)}`));
          return;
        }
        try {
          resolve(parseTurns(JSON.parse(line.slice(SHERPA_RESULT_PREFIX.length))));
        } catch (parseErr) {
          reject(
            new Error(
              `Speaker diarizer ${parseErr instanceof Error ? parseErr.message : parseErr}`,
            ),
          );
        }
      },
    );
  });
}
