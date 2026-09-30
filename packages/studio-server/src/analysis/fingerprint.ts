import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { SourceFingerprint } from "@hyperframes/agent-protocol";

/** Size of each sampled chunk (head, middle, tail). Files up to three chunks are hashed whole. */
export const SAMPLE_BYTES = 1024 * 1024;

/** `sha256:<hex>` over the byte size and the head, middle and tail chunks of a file (all of it when it is small). */
export async function sampledHash(abs: string, size: number): Promise<string> {
  const hash = createHash("sha256").update(`size:${size}\n`);
  const handle = await open(abs, "r");
  try {
    const read = async (position: number, length: number) => {
      const buffer = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      hash.update(buffer.subarray(0, filled));
    };
    if (size <= SAMPLE_BYTES * 3) {
      await read(0, size);
    } else {
      await read(0, SAMPLE_BYTES);
      await read(Math.floor((size - SAMPLE_BYTES) / 2), SAMPLE_BYTES);
      await read(size - SAMPLE_BYTES, SAMPLE_BYTES);
    }
  } finally {
    await handle.close();
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * - `unchanged`: the stat matched the stored fingerprint, nothing was hashed.
 * - `touched`: the stat changed but the content hash did not (a copy, a `touch`, a re-save); artifacts stay valid.
 * - `changed`: the content is different.
 * - `new`: there was no stored fingerprint.
 */
export type FingerprintChange = "unchanged" | "touched" | "changed" | "new";

export interface FingerprintCheck {
  change: FingerprintChange;
  /** The file as it is now; `duration` is carried over from the stored one unless the content changed. */
  fingerprint: SourceFingerprint;
}

/** Compares a file with its stored fingerprint: a stat check first, a sampled content hash only when the stat moved. */
export async function checkFingerprint(
  abs: string,
  path: string,
  previous: SourceFingerprint | null,
): Promise<FingerprintCheck> {
  const info = await stat(abs);
  if (previous && previous.bytes === info.size && previous.mtimeMs === info.mtimeMs) {
    return { change: "unchanged", fingerprint: { ...previous, path } };
  }
  const hash = await sampledHash(abs, info.size);
  const same = previous !== null && previous.hash === hash && previous.bytes === info.size;
  return {
    change: previous === null ? "new" : same ? "touched" : "changed",
    fingerprint: {
      path,
      bytes: info.size,
      mtimeMs: info.mtimeMs,
      hash,
      duration: same ? previous.duration : null,
    },
  };
}
