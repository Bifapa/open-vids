import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffprobeBinary } from "./ff-binaries.mjs";

// Local voiceover via the packaged Kokoro-82M TTS (the `hyperframes tts` CLI),
// the free/private default now that HeyGen TTS costs wallet credits. Kokoro runs
// on-device (CPU, faster-than-realtime, bundled voices, native word timestamps),
// so no key and no per-call charge. When Kokoro is not set up, this returns null
// and the registry falls through to the HeyGen TTS upsell.
//
// Delegated to the hyperframes CLI (same as transcribe / remove-background), not
// re-implemented here. ffprobe reads the duration back for the ledger.

function probeDurationSeconds(ffprobe, file) {
  try {
    const out = execFileSync(
      ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "--", file],
      { encoding: "utf8", timeout: 15000 },
    );
    const d = parseFloat(String(out).trim());
    return Number.isFinite(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

// The CLI that spawned this engine hands over its own invocation (runtime flags, then its entry
// file) as a JSON array in HYPERFRAMES_CLI_INVOCATION. Neither the packaged app nor a source
// checkout puts a `hyperframes` binary on PATH, so PATH is only the fallback for an engine run
// outside the CLI. A bare `hyperframes` resolves to `hyperframes.exe` on Windows; npm-style
// `.cmd` shims cannot be exec'd without a shell, which the entry hand-over avoids altogether.
export function cliInvocation(env = process.env) {
  try {
    const prefix = JSON.parse(env.HYPERFRAMES_CLI_INVOCATION ?? "null");
    if (
      Array.isArray(prefix) &&
      prefix.length > 0 &&
      prefix.every((part) => typeof part === "string")
    ) {
      return { cmd: process.execPath, prefix };
    }
  } catch {
    // malformed hand-over: use PATH
  }
  return { cmd: "hyperframes", prefix: [] };
}

// `execFn` (defaulting to the real execFileSync) lets tests observe the spawn
// without mocking node:child_process (its ESM exports are non-configurable).
export async function localTtsGenerate(intent, ctx, execFn = execFileSync, env = process.env) {
  const ffprobe = ffprobeBinary();
  const outPath = join(tmpdir(), `media-use-kokoro-${process.pid}-${Date.now()}.wav`);
  const argv = ["tts", intent, "--output", outPath];
  if (ctx?.voice) argv.push("--voice", ctx.voice);
  if (ctx?.lang && ctx.lang !== "en") argv.push("--lang", ctx.lang);
  const { cmd, prefix } = cliInvocation(env);
  try {
    execFn(cmd, [...prefix, ...argv], {
      encoding: "utf8",
      timeout: 300000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // `hyperframes tts` prints its "kokoro-onnx not installed" hint to stdout
    // (clack UI), so read both streams and surface the actionable enable-command
    // rather than a bare "Command failed": otherwise resolve silently falls
    // through to the PAID HeyGen TTS upsell when free local voice was one pip away.
    const out = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`.trim();
    const hint = /not installed|pip install kokoro/i.test(out)
      ? "install for free on-device voice: pip install kokoro-onnx soundfile (or set HYPERFRAMES_PYTHON to a venv that has it)"
      : out.slice(-200) || err.message;
    console.error(`media-use: local voice not enabled (kokoro). ${hint}`);
    return null;
  }
  if (!existsSync(outPath) || statSync(outPath).size === 0) return null;
  return {
    localPath: outPath,
    ext: ".wav",
    source: "generated",
    metadata: {
      description: intent,
      provider: "kokoro.local",
      duration: probeDurationSeconds(ffprobe, outPath),
      provenance: { engine: "kokoro-82m", prompt: intent },
    },
  };
}
