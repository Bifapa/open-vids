import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { guardLockedClips } from "./lock-guard.ts";
import { guardToolCallPaths } from "./path-guard.ts";

interface GuardedToolCall {
  toolName: string;
  input: unknown;
}

/**
 * The decision made for every tool call of an OMP session: the project boundary first, then the
 * timeline lock on composition HTML that `edit`/`write` would otherwise rewrite behind the editing
 * service. `undefined` lets the call run.
 */
export function projectToolCallGuard(
  projectDir: string,
): (event: GuardedToolCall) => Promise<{ block: true; reason: string } | undefined> {
  return async (event) => {
    const reason =
      (await guardToolCallPaths(projectDir, event.input, event.toolName)) ??
      (await guardLockedClips(projectDir, event.input, event.toolName));
    return reason ? { block: true, reason } : undefined;
  };
}

export function projectBoundaryExtension(projectDir: string): ExtensionFactory {
  const guard = projectToolCallGuard(projectDir);
  return (pi) => {
    pi.on("tool_call", guard);
  };
}
