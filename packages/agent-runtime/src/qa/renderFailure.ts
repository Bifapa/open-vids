import { EditingError } from "../editing/host.js";
import { errorMessage } from "../errors.js";

/**
 * Why a QA render failed: `environment` — this machine or Studio could not render at all (no ffmpeg, a full disk, the
 * browser or the sidecar gone), which no edit of the project can fix; `project` — the composition or its media broke
 * the render, so a correction may fix it.
 */
export interface RenderFailure {
  kind: "environment" | "project";
  reason: string;
}

/** Messages that name the machine rather than the composition. */
const ENVIRONMENT =
  /ffmpeg|ffprobe|enospc|no space left|disk (?:is )?full|out of (?:disk|memory)|cannot allocate|enomem|chrome|chromium|puppeteer|browser (?:could not|failed|not found|has (?:closed|crashed))|target closed|spawn |econnrefused|econnreset|epipe|eacces|eperm|not reachable|fetch failed|socket hang up|timed? ?out|progress stream ended|could not report render progress|file was not found/i;

/**
 * Classifies a render error. Transport failures (`unavailable`) and the render host's own plumbing errors are
 * environmental; a message that names a missing tool, a full disk or a dead browser is too. Everything else is read as
 * the project's (the Director investigates it), because blaming the machine for a broken composition would hide a
 * defect nobody then fixes.
 */
export function classifyRenderFailure(error: unknown): RenderFailure {
  const reason = errorMessage(error, "The render failed");
  if (error instanceof EditingError && error.code === "unavailable")
    return { kind: "environment", reason };
  return { kind: ENVIRONMENT.test(reason) ? "environment" : "project", reason };
}
