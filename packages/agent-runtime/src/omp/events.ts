import { isRecord } from "@hyperframes/agent-protocol";
import type { BackendEvent, BackendToolKind } from "../backend.ts";
import { projectRelativeTargets } from "./path-guard.ts";

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

export function translateOmpEvent(event: unknown, projectDir: string): BackendEvent | null {
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
    return {
      type: "tool.end",
      toolCallId,
      ok: event.isError !== true,
    };
  }

  return null;
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
    if (!isRecord(message) || message.type !== "assistant") continue;
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
