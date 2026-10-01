import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { guardLockedClips } from "./lock-guard.ts";
import { guardToolCallPaths } from "./path-guard.ts";

interface GuardedToolCall {
  toolName: string;
  input: unknown;
}

/** Asked per call; a string refuses it (the runtime's per-turn rules, e.g. a Plan or Ask turn writes nothing). */
export type ToolCallRefusal = (toolName: string) => string | null;

/**
 * The decision made for every tool call of an OMP session: the turn's own refusal first, then the project boundary,
 * then the timeline lock on composition HTML that `edit`/`write` would otherwise rewrite behind the editing service.
 * `undefined` lets the call run.
 */
export function projectToolCallGuard(
  projectDir: string,
  refusal?: ToolCallRefusal,
  askBeforeLockedEdits?: () => boolean,
): (event: GuardedToolCall) => Promise<{ block: true; reason: string } | undefined> {
  return async (event) => {
    const reason =
      refusal?.(event.toolName) ??
      (await guardToolCallPaths(projectDir, event.input, event.toolName)) ??
      (await guardLockedClips(
        projectDir,
        event.input,
        event.toolName,
        askBeforeLockedEdits?.() ?? true,
      ));
    return reason ? { block: true, reason } : undefined;
  };
}

export function projectBoundaryExtension(
  projectDir: string,
  refusal?: ToolCallRefusal,
  askBeforeLockedEdits?: () => boolean,
): ExtensionFactory {
  const guard = projectToolCallGuard(projectDir, refusal, askBeforeLockedEdits);
  return (pi) => {
    pi.on("tool_call", guard);
  };
}
