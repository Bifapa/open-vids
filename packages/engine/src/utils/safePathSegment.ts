import { createHash } from "node:crypto";
/**
 * An author-controlled id, made safe to put in a filename.
 *
 * Element, render and group ids reach the engine straight from the document —
 * the studio's `GROUP_ID_PATTERN` guards only ids the studio itself mints, and
 * a hand-authored or agent-written one is unvalidated. Interpolated raw it
 * could carry `/`, `..` or `:`, and a path join (or ffmpeg's own
 * `mkdirSync(recursive)`) would then write — and, for the extractor's cleanup,
 * `rmSync` — outside the render's work directory. Everything outside
 * [A-Za-z0-9_-] collapses to `_`, and every result gets a stable positional
 * suffix so distinct ids that sanitize alike cannot share one intermediate
 * file.
 */
export function safePathSegment(id: string, position: number, fallback = "item"): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "_");
  // Sanitisation is many-to-one (`bed/a` and `bed?a` both become `bed_a`).
  // The stable position keeps every authored id on a distinct path even when
  // their readable portions collide.
  return `${cleaned || fallback}-${position}`;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * A directory name for an id when no positional index is at hand.
 *
 * An already-safe id is returned unchanged, so ordinary renders keep their
 * existing on-disk layout. Anything else is sanitized and given a short hash of
 * the original id, which keeps `a/b` and `a:b` on distinct paths.
 */
export function safeIdPathName(id: string): string {
  if (SAFE_ID.test(id)) return id;
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return `${id.replace(/[^A-Za-z0-9_-]/g, "_") || "item"}-${digest}`;
}
