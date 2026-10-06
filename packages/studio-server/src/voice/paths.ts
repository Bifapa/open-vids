import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The global voice directory: provider settings, keys, presets, the audio cache and the pricing override.
 * `$OPENVIDS_VOICE_DIR` else `~/.openvids/voice` (the Projects page, in Rust, resolves the same directory).
 */
export function voiceDir(): string {
  const override = process.env.OPENVIDS_VOICE_DIR;
  return override && override.length > 0 ? override : join(homedir(), ".openvids", "voice");
}
