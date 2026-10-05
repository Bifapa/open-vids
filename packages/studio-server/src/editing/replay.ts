import { existsSync, readFileSync } from "node:fs";
import type { ApplyEditsResponse } from "@hyperframes/agent-protocol";
import { resolveWithinProject } from "../helpers/safePath.js";
import { editingVersion } from "./timeline.js";

/** Answers kept per project for repeated request ids. */
const REMEMBERED_PER_PROJECT = 100;
const REMEMBERED_MS = 30 * 60 * 1000;

interface Remembered {
  at: number;
  response: ApplyEditsResponse;
  /** Content version of every file the batch wrote, as it was right after the commit. */
  versions: Map<string, string>;
}

const applied = new Map<string, Map<string, Remembered>>();
const running = new Map<string, AbortController>();

const keyOf = (projectDir: string, composition: string, requestId: string) =>
  `${projectDir}\0${composition}\0${requestId}`;

function versionOnDisk(projectDir: string, file: string): string | null {
  const abs = resolveWithinProject(projectDir, file);
  if (!abs || !existsSync(abs)) return null;
  return editingVersion(readFileSync(abs, "utf-8"));
}

/**
 * The stored answer of a batch already applied under this request id. It is replayed only while every file that
 * batch wrote still has the content the batch left; once any of them changed, the same id is a new application.
 */
export function recallApplied(
  projectDir: string,
  composition: string,
  requestId: string,
): ApplyEditsResponse | null {
  const entries = applied.get(projectDir);
  const found = entries?.get(`${composition}\0${requestId}`);
  if (!entries || !found) return null;
  if (Date.now() - found.at > REMEMBERED_MS) {
    entries.delete(`${composition}\0${requestId}`);
    return null;
  }
  for (const [file, version] of found.versions) {
    if (versionOnDisk(projectDir, file) !== version) return null;
  }
  return found.response;
}

/** Remembers the answer of a committed batch with the content version each of `files` has on disk now. */
export function rememberApplied(
  projectDir: string,
  composition: string,
  requestId: string,
  response: ApplyEditsResponse,
  files: readonly string[],
): void {
  const versions = new Map<string, string>();
  for (const file of new Set([composition, ...files])) {
    const version = versionOnDisk(projectDir, file);
    if (version !== null) versions.set(file, version);
  }
  const entries = applied.get(projectDir) ?? new Map<string, Remembered>();
  applied.set(projectDir, entries);
  entries.set(`${composition}\0${requestId}`, { at: Date.now(), response, versions });
  for (const stale of entries.keys()) {
    if (entries.size <= REMEMBERED_PER_PROJECT) break;
    entries.delete(stale);
  }
}

/** Registers a running apply so a cancel request can reach it; call the returned function when it ends. */
export function trackRunning(
  projectDir: string,
  composition: string,
  requestId: string,
): { controller: AbortController; done: () => void } {
  const key = keyOf(projectDir, composition, requestId);
  const controller = new AbortController();
  running.set(key, controller);
  return {
    controller,
    done: () => {
      if (running.get(key) === controller) running.delete(key);
    },
  };
}

/** Asks a running (or queued) apply to stop before it writes; false when no such request is running. */
export function cancelRunning(projectDir: string, requestId: string): boolean {
  let cancelled = false;
  for (const [key, controller] of running) {
    const [dir, , id] = key.split("\0");
    if (dir === projectDir && id === requestId) {
      controller.abort();
      cancelled = true;
    }
  }
  return cancelled;
}
