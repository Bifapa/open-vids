import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { SourceFingerprint } from "@hyperframes/agent-protocol";

/** Size of each sampled chunk (head, middle, tail). Files up to three chunks are hashed whole. */
export const SAMPLE_BYTES = 1024 * 1024;

/** The dense sample: this many evenly spaced chunks of this size across a file bigger than the three chunks above. */
export const DENSE_SAMPLES = 32;
export const DENSE_SAMPLE_BYTES = 128 * 1024;

type Reader = (position: number, length: number) => Promise<Buffer>;

/** Runs `use` with a positional reader of the file; the handle is always closed. */
async function withReader<T>(abs: string, use: (read: Reader) => Promise<T>): Promise<T> {
  const handle = await open(abs, "r");
  try {
    return await use(async (position, length) => {
      const buffer = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    });
  } finally {
    await handle.close();
  }
}

/** `sha256:<hex>` over the byte size and the head, middle and tail chunks of a file (all of it when it is small). */
export async function sampledHash(abs: string, size: number): Promise<string> {
  const hash = createHash("sha256").update(`size:${size}\n`);
  await withReader(abs, async (read) => {
    if (size <= SAMPLE_BYTES * 3) {
      hash.update(await read(0, size));
    } else {
      hash.update(await read(0, SAMPLE_BYTES));
      hash.update(await read(Math.floor((size - SAMPLE_BYTES) / 2), SAMPLE_BYTES));
      hash.update(await read(size - SAMPLE_BYTES, SAMPLE_BYTES));
    }
  });
  return `sha256:${hash.digest("hex")}`;
}

/**
 * `sha256:<hex>` over {@link DENSE_SAMPLES} evenly spaced chunks of a file larger than the head/middle/tail samples
 * cover: an edit in the middle of a big file that those three miss still changes it. Undefined for a smaller file,
 * which {@link sampledHash} already reads whole.
 */
export async function denseHash(abs: string, size: number): Promise<string | undefined> {
  if (size <= SAMPLE_BYTES * 3) return undefined;
  const hash = createHash("sha256").update(`dense:${size}\n`);
  await withReader(abs, async (read) => {
    const span = size - DENSE_SAMPLE_BYTES;
    for (let index = 0; index < DENSE_SAMPLES; index += 1) {
      hash.update(await read(Math.floor((span * index) / (DENSE_SAMPLES - 1)), DENSE_SAMPLE_BYTES));
    }
  });
  return `sha256:${hash.digest("hex")}`;
}

/** What two fingerprints must share to describe the same bytes: size, sampled hash, and the dense hash when both have one. */
export function sameContent(
  a: Pick<SourceFingerprint, "bytes" | "hash" | "denseHash">,
  b: Pick<SourceFingerprint, "bytes" | "hash" | "denseHash">,
): boolean {
  return (
    a.bytes === b.bytes &&
    a.hash === b.hash &&
    (a.denseHash === undefined || b.denseHash === undefined || a.denseHash === b.denseHash)
  );
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

/** Compares a file with its stored fingerprint: a stat check first, sampled content hashes only when the stat moved. */
export async function checkFingerprint(
  abs: string,
  path: string,
  previous: SourceFingerprint | null,
): Promise<FingerprintCheck> {
  const info = await stat(abs);
  if (previous && previous.bytes === info.size && previous.mtimeMs === info.mtimeMs) {
    return { change: "unchanged", fingerprint: { ...previous, path } };
  }
  const [hash, dense] = await Promise.all([sampledHash(abs, info.size), denseHash(abs, info.size)]);
  const now = { bytes: info.size, hash, ...(dense !== undefined && { denseHash: dense }) };
  const same = previous !== null && sameContent(previous, now);
  return {
    change: previous === null ? "new" : same ? "touched" : "changed",
    fingerprint: {
      path,
      bytes: info.size,
      mtimeMs: info.mtimeMs,
      hash,
      ...(dense !== undefined && { denseHash: dense }),
      duration: same ? previous.duration : null,
    },
  };
}
