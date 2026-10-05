import { isRecord } from "@hyperframes/agent-protocol";
import type { UsageTotals } from "@hyperframes/agent-protocol";
import type { BackendEvent, BackendToolKind, HostTool } from "../backend.ts";
import { projectRelativeTargets } from "./path-guard.ts";
import { toolFailureMessage } from "./provider-errors.ts";

type UnknownRecord = Record<string, unknown>;

function getString(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function getToolKind(name: string): BackendToolKind {
  switch (name) {
    case "read":
      return "inspect";
    case "grep":
    case "glob":
    case "find":
      return "search";
    case "edit":
    case "write":
      return "edit";
    default:
      return "other";
  }
}

/**
 * `hostTools`: the runtime-implemented tools of the session (delegation, plan, Jev, editing), by name. Their calls are
 * not file activity: the runtime reports orchestration itself, and a host tool that declares an `activity` gets one
 * labelled row per call. An unmatched `tool.end` is ignored downstream.
 */
export function translateOmpEvent(
  event: unknown,
  projectDir: string,
  hostTools: ReadonlyMap<string, HostTool> = new Map(),
): BackendEvent | null {
  if (!isRecord(event)) return null;

  if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
    const update = event.assistantMessageEvent;
    if (
      (update.type === "text_delta" || update.type === "thinking_delta") &&
      typeof update.delta === "string"
    ) {
      return update.type === "text_delta"
        ? { type: "text.delta", delta: update.delta }
        : { type: "thinking.delta", delta: update.delta };
    }
    if (update.type === "thinking_end") return { type: "thinking.end" };
    return null;
  }

  if (event.type === "tool_execution_start") {
    const toolCallId = getString(event, "toolCallId");
    const toolName = getString(event, "toolName");
    if (!toolCallId || !toolName) return null;
    const hostTool = hostTools.get(toolName);
    if (hostTool) {
      const activity = hostTool.activity?.(event.args);
      if (!activity) return null;
      return {
        type: "tool.start",
        toolCallId,
        kind: activity.category,
        targets: [],
        label: activity.label,
        ...(activity.labelCode !== undefined && { labelCode: activity.labelCode }),
        ...(activity.labelParams !== undefined && { labelParams: activity.labelParams }),
      };
    }
    return {
      type: "tool.start",
      toolCallId,
      kind: getToolKind(toolName),
      targets: projectRelativeTargets(projectDir, event.args),
    };
  }

  if (event.type === "tool_execution_end") {
    const toolCallId = getString(event, "toolCallId");
    if (!toolCallId) return null;
    const failed = event.isError === true;
    const error = failed ? toolResultText(event.result) : "";
    return {
      type: "tool.end",
      toolCallId,
      ok: !failed,
      ...(error && { error: toolFailureMessage(error) }),
    };
  }

  // Each finished model call: its usage (the failed ones of a retry cost tokens too).
  if (event.type === "message_end" && isRecord(event.message)) {
    const usage = usageOf(event.message);
    return usage ? { type: "usage", usage } : null;
  }

  return null;
}

/** The text of a tool result (`{ content: [{ type: "text", text }] }`, or a bare string) for a failed row. */
function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  return result.content
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join(" ");
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** What an assistant message's `usage` says, as the protocol's totals; null for any other message. */
function usageOf(message: UnknownRecord): UsageTotals | null {
  if (message.role !== "assistant" || !isRecord(message.usage)) return null;
  const { usage } = message;
  const input = count(usage.input);
  const output = count(usage.output);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  const total = count(usage.totalTokens) || input + output + cacheRead + cacheWrite;
  const cost = isRecord(usage.cost) ? count(usage.cost.total) : 0;
  if (total === 0 && cost === 0) return null;
  return { input, output, cacheRead, cacheWrite, totalTokens: total, cost: cost > 0 ? cost : null };
}

export interface TerminalEventResult {
  aborted: boolean;
  error: string | null;
}

export function terminalEventResult(event: unknown): TerminalEventResult | null {
  if (!isRecord(event) || event.type !== "agent_end") return null;
  if (event.isTerminal === false) return null;

  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // OMP agent messages carry `role`, not `type`; a provider failure is an assistant message with stopReason "error".
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (message.stopReason === "aborted") return { aborted: true, error: null };
    if (message.stopReason !== "error") continue;

    const errorMessage = getString(message, "errorMessage");
    const error = getString(message, "error");
    return {
      aborted: false,
      error: errorMessage ?? error ?? "The OMP provider request failed.",
    };
  }

  return { aborted: false, error: null };
}

export function humanReadableError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isRecord(error)) {
    const message = getString(error, "message");
    if (message?.trim()) return message.trim();
  }
  return "The OMP agent failed unexpectedly.";
}
