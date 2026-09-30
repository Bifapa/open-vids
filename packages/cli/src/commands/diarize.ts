import { defineCommand } from "citty";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import * as clack from "@clack/prompts";
import type { Example } from "./_examples.js";
import { c } from "../ui/colors.js";
import { failCommand, setCommandExitCode } from "../utils/commandResult.js";
import { normalizeErrorMessage } from "../utils/errorMessage.js";
import { createRenderCancellationScope } from "../utils/renderCancellation.js";
import {
  DIARIZATION_MODEL_LABEL,
  diarizationUnsupportedReason,
  diarizeWav,
  installDiarization,
  isDiarizationUnavailable,
  MAX_SPEAKERS,
} from "../whisper/diarize.js";
import { DecodeCancelled, prepareSherpaWav } from "../whisper/sherpa.js";

export const examples: Example[] = [
  ["Find who speaks when in a recording", "hyperframes diarize interview.mp4"],
  ["Machine-readable turns", "hyperframes diarize interview.mp4 --json"],
  ["Fix the number of speakers", "hyperframes diarize interview.mp4 --speakers 2"],
];

function failWith(message: string, json: boolean): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(c.error(message));
  failCommand(1, message);
}

export default defineCommand({
  meta: {
    name: "diarize",
    description:
      "Find who speaks when (offline speaker diarization). Installs the sherpa-onnx runtime and two small models on first use.",
  },
  args: {
    input: {
      type: "positional",
      description: "Audio/video file",
      required: true,
    },
    speakers: {
      type: "string",
      description: "Exact number of speakers (default: detected)",
      alias: "n",
    },
    json: {
      type: "boolean",
      description: "Print one JSON result; progress goes to stderr",
      default: false,
    },
  },
  async run({ args }) {
    const json = args.json;
    const inputPath = resolve(args.input);
    if (!existsSync(inputPath)) failWith(`File not found: ${args.input}`, json);

    let speakers: number | undefined;
    if (args.speakers !== undefined) {
      speakers = Number(args.speakers);
      if (!Number.isInteger(speakers) || speakers < 1 || speakers > MAX_SPEAKERS) {
        failWith(`--speakers must be a whole number from 1 to ${MAX_SPEAKERS}.`, json);
      }
    }

    const spin = json ? null : clack.spinner();
    const onProgress = (message: string) => {
      if (spin) spin.message(message);
      else console.error(message);
    };
    /** A setup condition, not a crash: the caller records a single-speaker map and moves on. */
    const skip = (message: string) => {
      if (json) {
        console.log(
          JSON.stringify({
            ok: false,
            skipped: true,
            reason: "diarization_unavailable",
            error: message,
          }),
        );
      } else if (spin) {
        spin.stop(c.warn(`Diarization skipped — ${message}`));
      } else {
        console.error(c.warn(`Diarization skipped — ${message}`));
      }
      setCommandExitCode(1);
    };

    const unsupported = diarizationUnsupportedReason();
    if (unsupported) return skip(unsupported);

    spin?.start("Preparing speaker diarization...");
    // Before audio prep: under --json no spinner listens for SIGINT, so Ctrl-C would kill Node.
    const cancellation = createRenderCancellationScope();
    let wavPath: string | null = null;
    try {
      await installDiarization({ signal: cancellation.signal, onProgress });
      wavPath = prepareSherpaWav(inputPath, onProgress);
      onProgress("Finding speakers...");
      const turns = await diarizeWav(wavPath, { signal: cancellation.signal, speakers });
      const speakerCount = new Set(turns.map((t) => t.speaker)).size;
      if (json) {
        console.log(
          JSON.stringify({ ok: true, turns, speakerCount, producer: DIARIZATION_MODEL_LABEL }),
        );
        return;
      }
      spin?.stop(
        c.success(
          `Found ${c.accent(String(speakerCount))} speaker${speakerCount === 1 ? "" : "s"} in ${turns.length} turns`,
        ),
      );
      for (const t of turns) {
        console.log(`  speaker ${t.speaker}  ${t.start.toFixed(2)}s – ${t.end.toFixed(2)}s`);
      }
    } catch (err) {
      if (err instanceof DecodeCancelled || cancellation.signal.aborted) {
        const message = "Diarization cancelled";
        if (json) console.log(JSON.stringify({ ok: false, error: message }));
        else spin?.stop(c.warn(message));
        setCommandExitCode(130);
        return;
      }
      if (isDiarizationUnavailable(err)) return skip(err.message);
      const message = normalizeErrorMessage(err);
      spin?.stop(c.error(`Diarization failed: ${message}`));
      // The spinner already printed the message in the interactive mode.
      if (json) console.log(JSON.stringify({ ok: false, error: message }));
      failCommand(1, err);
    } finally {
      cancellation.dispose();
      if (wavPath !== null && wavPath !== inputPath) rmSync(wavPath, { force: true });
    }
  },
});
