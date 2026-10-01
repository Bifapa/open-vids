import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import type { HistoryWho } from "./historyLog.js";

/** What a window needs to be reopened by a later process: its writer and label, and when it last showed life. */
export interface OpenWindowRecord {
  id: string;
  who: HistoryWho;
  label: string;
  startedAt: number;
  lastWriteAt: number;
  renewedAt?: number;
  idleMs: number;
}

const FILE = "open-windows.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseRecord(value: unknown): OpenWindowRecord | null {
  if (!isRecord(value) || !isRecord(value.who)) return null;
  const { id, label, startedAt, lastWriteAt, renewedAt, idleMs, who } = value;
  const { kind, name } = who;
  if (typeof id !== "string" || typeof label !== "string") return null;
  if (typeof startedAt !== "number" || typeof lastWriteAt !== "number") return null;
  if (typeof idleMs !== "number" || !Number.isFinite(idleMs)) return null;
  if (kind !== "person" && kind !== "agent" && kind !== "outside") return null;
  if (typeof name !== "string") return null;
  return {
    id,
    label,
    startedAt,
    lastWriteAt,
    idleMs,
    who: { kind, name },
    ...(typeof renewedAt === "number" && { renewedAt }),
  };
}

/**
 * The windows a process died holding open (killed, crashed, power loss), or none. A graceful close ends every window
 * and clears the file, so what is left is exactly what a dead owner never committed.
 */
export function readOpenWindows(home: string): OpenWindowRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, FILE), "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => parseRecord(value) ?? []);
  } catch {
    return [];
  }
}

/** Records the open windows, or removes the record when none is open. */
export function writeOpenWindows(home: string, windows: readonly OpenWindowRecord[]): void {
  const file = join(home, FILE);
  if (windows.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  replaceFileAtomically(file, JSON.stringify(windows), 0o600);
}
