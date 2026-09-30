import { defineCommand } from "citty";
import * as clack from "@clack/prompts";
import type { Example } from "./_examples.js";
import { c } from "../ui/colors.js";
import { formatBytes } from "../ui/format.js";
import { failCommand, setCommandExitCode } from "../utils/commandResult.js";
import { createRenderCancellationScope } from "../utils/renderCancellation.js";
import { PARAKEET_MODEL_LABEL } from "../whisper/parakeet.js";

export const examples: Example[] = [
  [
    "Download the Parakeet speech model that transcribe uses",
    "hyperframes models install parakeet",
  ],
  [
    "Download the speaker diarization models that diarize uses",
    "hyperframes models install diarization",
  ],
];

function fail(message: string, json: boolean): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(c.error(message));
  failCommand();
}

/** A cancel is the user's choice, not a command failure: exit 130 without a cli_error. */
function reportCancel(json: boolean, what = "Parakeet"): void {
  const message = `${what} install cancelled; nothing partial was kept.`;
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(c.warn(message));
  setCommandExitCode(130);
}

function downloadProgress(spin: Spinner) {
  let lastPct = -1;
  return (done: number, total: number) => {
    const pct = Math.floor((done / total) * 100);
    if (pct <= lastPct) return;
    lastPct = pct;
    spin?.message(
      `Downloading Parakeet TDT 0.6B v3 — ${c.progress(pct + "%")} ${c.dim("(" + formatBytes(done) + " / " + formatBytes(total) + ")")}`,
    );
  };
}

type Sherpa = typeof import("../whisper/sherpa.js");
type Spinner = ReturnType<typeof clack.spinner> | null;

/** Installs what is missing; true when anything changed. */
async function installMissing(sherpa: Sherpa, spin: Spinner, signal: AbortSignal) {
  const runtimeInstalled = await sherpa.installSherpaRuntime({ signal });
  spin?.message("Verifying the Parakeet model...");
  const modelFetched = await sherpa.ensureParakeetModel({
    signal,
    onBytes: downloadProgress(spin),
  });
  return runtimeInstalled || modelFetched;
}

/** A synchronous child's Ctrl-C shows as its error before the scope's listener runs. */
const wasCancelled = (err: unknown, signal: AbortSignal, sherpa: Sherpa) =>
  signal.aborted || err instanceof sherpa.DecodeCancelled;

async function installParakeet(json: boolean): Promise<void> {
  const sherpa = await import("../whisper/sherpa.js");
  const unsupported = sherpa.sherpaUnsupportedReason();
  if (unsupported) fail(unsupported, json);

  const spin = json ? null : clack.spinner({ output: process.stderr });
  // Ctrl-C must stop a 650 MB download, not just print "Canceled" over it.
  const cancellation = createRenderCancellationScope();
  spin?.start("Checking the sherpa-onnx runtime (installing it from npm if it does not load)...");
  try {
    const changed = await installMissing(sherpa, spin, cancellation.signal);
    spin?.stop(c.success(changed ? "Parakeet installed" : "Parakeet is already installed"));
    if (json) {
      const { SHERPA_RUNTIME_DIR: runtimeDir, PARAKEET_MODEL_DIR: modelDir } = sherpa;
      console.log(
        JSON.stringify({ ok: true, model: PARAKEET_MODEL_LABEL, changed, runtimeDir, modelDir }),
      );
    }
  } catch (err) {
    const cancelled = wasCancelled(err, cancellation.signal, sherpa);
    spin?.stop(
      cancelled ? c.warn("Parakeet install cancelled") : c.error("Parakeet install failed"),
    );
    if (cancelled) return reportCancel(json);
    fail(err instanceof Error ? err.message : String(err), json);
  } finally {
    cancellation.dispose();
  }
}

/** Downloads the sherpa-onnx runtime plus the pinned segmentation and speaker-embedding models. */
async function installDiarizationModels(json: boolean): Promise<void> {
  // Lazy on purpose: installing Parakeet must not load the diarization module, nor sherpa for a bad argument.
  const diarize = await import("../whisper/diarize.js");
  const sherpa = await import("../whisper/sherpa.js");
  const unsupported = diarize.diarizationUnsupportedReason();
  if (unsupported) fail(unsupported, json);

  const spin = json ? null : clack.spinner({ output: process.stderr });
  const cancellation = createRenderCancellationScope();
  spin?.start("Checking the sherpa-onnx runtime and the diarization models...");
  try {
    const changed = await diarize.installDiarization({
      signal: cancellation.signal,
      onProgress: (message) => spin?.message(message),
    });
    spin?.stop(
      c.success(
        changed ? "Speaker diarization installed" : "Speaker diarization is already installed",
      ),
    );
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          model: diarize.DIARIZATION_MODEL_LABEL,
          changed,
          modelDir: diarize.DIARIZATION_MODEL_DIR,
        }),
      );
    }
  } catch (err) {
    const cancelled = wasCancelled(err, cancellation.signal, sherpa);
    spin?.stop(
      cancelled
        ? c.warn("Speaker diarization install cancelled")
        : c.error("Speaker diarization install failed"),
    );
    if (cancelled) return reportCancel(json, "Speaker diarization");
    fail(err instanceof Error ? err.message : String(err), json);
  } finally {
    cancellation.dispose();
  }
}

export default defineCommand({
  meta: {
    name: "models",
    description: "Download on-device models (models install parakeet | diarization)",
  },
  args: {
    action: { type: "positional", description: "install", required: true },
    name: {
      type: "positional",
      description: "Model to install: parakeet or diarization",
      required: true,
    },
    json: { type: "boolean", description: "Print one JSON result, no progress", default: false },
  },
  async run({ args }) {
    if (args.action === "install" && args.name === "parakeet") return installParakeet(args.json);
    if (args.action === "install" && args.name === "diarization") {
      return installDiarizationModels(args.json);
    }
    fail(
      `Unknown: models ${args.action} ${args.name}. Try: hyperframes models install parakeet (or diarization)`,
      args.json,
    );
  },
});
