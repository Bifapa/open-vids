import {
  AGENT_DISPLAY_NAMES,
  isAgentRunTerminal,
  type AgentRun,
} from "@hyperframes/agent-protocol";
import type { BackendSession, HostToolResult } from "../backend.js";
import type { StallWatchdog } from "./stallWatchdog.js";
import { LIMITS } from "./tools.js";

export const done = (text: string): HostToolResult => ({ text });
export const refuse = (text: string): HostToolResult => ({ text, isError: true });

/** Who ended a run on purpose. */
export type CancelledBy = "director" | "user";

export interface RunRecord {
  run: AgentRun;
  controller: AbortController;
  session: BackendSession | null;
  done: Promise<void>;
  report: string | null;
  /** The Director has received this run's result (through wait_for_agents or a synchronous Jev call). */
  reported: boolean;
  cancelled: boolean;
  cancelledBy: CancelledBy | null;
  cancelReason: string | null;
  finished: boolean;
  /** A run the runtime started itself (a Render QA review): not part of the user-facing plan, never collected. */
  internal: boolean;
  /** The specialist's concurrency slot while the run holds one (0 = the resumable session). */
  slot: number | null;
  /** Set when the watchdog stopped the run: why. */
  stalled: string | null;
  /** The prompt is under way, so steering reaches the session; before that corrections wait in {@link queuedMessages}. */
  started: boolean;
  /** Corrections the Director sent before the run began; they are put in front of its task. */
  queuedMessages: string[];
  /** The task as the specialist gets it, built when the run was created. */
  taskText: string;
  watchdog: StallWatchdog | null;
}

const SUMMARY_CHARS = 280;

/** Reports reach the Director up to the size a task may have, so a report is never smaller than what was asked of it. */
export const REPORT_CHARS = LIMITS.taskChars;

/**
 * A one-line outcome for the main chat, from the run's final text segment (the report; earlier segments are
 * narration between tool calls). Markdown markers and label-only lines ("Report:") are dropped.
 */
export function summarizeReport(finalText: string | null): string | null {
  const lines = (finalText ?? "")
    .split("\n")
    .map((line) =>
      line
        .replace(/\*\*|__|`/g, "")
        .replace(/^\s*(?:[#>]+|[-*•]|\d+[.)])\s+/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line && !/^[\p{L}\p{N} ]{1,30}:$/u.test(line));
  const summary = lines.slice(0, 2).join(" ");
  if (!summary) return null;
  return summary.length > SUMMARY_CHARS
    ? `${summary.slice(0, SUMMARY_CHARS - 1).trimEnd()}…`
    : summary;
}

/** A report as the caller gets it; a cut is announced, never silent. */
export function clipReport(report: string | null): string {
  if (!report) return "(no reply)";
  if (report.length <= REPORT_CHARS) return report;
  return `${report.slice(0, REPORT_CHARS)}\n[Report cut here: ${REPORT_CHARS} of ${report.length} characters shown. Ask for what you still need in a new, narrower task.]`;
}

/** One run as the Director reads it in wait_for_agents; `now` dates a run that is still going. */
export function describeRun(record: RunRecord, now: number): string {
  const { run } = record;
  const header = `${AGENT_DISPLAY_NAMES[run.agent]} — "${run.title}" (run ${run.id}): ${run.status}`;
  if (!isAgentRunTerminal(run.status)) {
    const seconds = Math.max(0, Math.round((now - run.startedAt) / 1000));
    return `${header}, still ${run.status === "queued" ? "waiting for its turn" : "working"} (${seconds} s since it was started).`;
  }
  if (run.status === "cancelled") {
    const who =
      record.cancelledBy === "user"
        ? "stopped by the user. Do not start it again unless the user asks for it"
        : "stopped on your request";
    return `${header} — ${who}${record.cancelReason ? ` (${record.cancelReason})` : ""}.`;
  }
  const detail = run.error
    ? `Error: ${run.error.message}`
    : `Report:\n${clipReport(record.report)}`;
  return `${header}\n${detail}`;
}
