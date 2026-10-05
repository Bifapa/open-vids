import path from "node:path";
import { realpath } from "node:fs/promises";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type { AgentId } from "@hyperframes/agent-protocol";
import { AGENT_DISPLAY_NAMES } from "@hyperframes/agent-protocol";
import { guardLockedClips } from "./lock-guard.ts";
import { guardToolCallPaths, resolveProjectFileTargets } from "./path-guard.ts";

interface GuardedToolCall {
  toolName: string;
  input: unknown;
}

/** Asked per call; a string refuses it (the runtime's per-turn rules, e.g. a Plan or Ask turn writes nothing). */
export type ToolCallRefusal = (toolName: string) => string | null;

/** What a session's guard knows besides the project: who it guards, and what it may reach beyond the project. */
export interface ToolGuardOptions {
  /** The agent the session runs; Vision and Research may not change files at all. */
  agent?: AgentId;
  /** Directories outside the project that `read`/`grep`/`glob`/`find` may look into (never write). */
  readOnlyRoots?: readonly string[];
  /** Asked with the project-relative composition files an `edit`/`write` would change; a string refuses the call. */
  claimWriteFiles?: (files: string[]) => string | null;
  /** Told with the tool name when an `edit`/`write` passed the whole chain and is about to run. */
  noteFileWrite?: (toolName: string) => void;
}

/** Roles that only look: their file writes are refused whatever the turn allows. */
const READ_ONLY_ROLES: Partial<Record<AgentId, string>> = {
  vision:
    "Vision only reviews: it cannot edit or write project files. Describe the problem precisely in your report, and the Director or the Editor will fix it.",
  research:
    "Research only finds and imports material: it cannot edit or write project files. Use the research tools to import assets, and leave composition changes to the Editor or the Director.",
};

const WRITING_TOOLS: Record<string, true> = { edit: true, write: true };
const COMPOSITION_EXTENSIONS: Record<string, true> = { ".html": true, ".htm": true };

/** The refusal for a file write by a role that may not write; null for every other call. */
export function roleWriteRefusal(agent: AgentId | undefined, toolName: string): string | null {
  if (agent === undefined || !Object.hasOwn(WRITING_TOOLS, toolName)) return null;
  const reason = READ_ONLY_ROLES[agent];
  return reason ? `${AGENT_DISPLAY_NAMES[agent]} is read-only here. ${reason}` : null;
}

/** The composition files (project-relative, `/`-separated) an `edit`/`write` call would change. */
async function compositionTargets(projectDir: string, input: unknown): Promise<string[]> {
  const targets = await resolveProjectFileTargets(projectDir, input);
  if (targets.length === 0) return [];
  const root = await realpath(projectDir);
  return targets
    .filter((target) => Object.hasOwn(COMPOSITION_EXTENSIONS, path.extname(target).toLowerCase()))
    .map((target) => path.relative(root, target).split(path.sep).join("/"));
}

/**
 * The decision made for every tool call of an OMP session: the turn's own refusal first, then the role's, then the
 * project boundary (with the bundled skills readable), then the timeline lock on composition HTML that `edit`/`write`
 * would otherwise rewrite behind the editing service, and last the per-file write lease. `undefined` lets the call run.
 */
export function projectToolCallGuard(
  projectDir: string,
  refusal?: ToolCallRefusal,
  askBeforeLockedEdits?: () => boolean,
  options: ToolGuardOptions = {},
): (event: GuardedToolCall) => Promise<{ block: true; reason: string } | undefined> {
  return async (event) => {
    const reason =
      refusal?.(event.toolName) ??
      roleWriteRefusal(options.agent, event.toolName) ??
      (await guardToolCallPaths(projectDir, event.input, event.toolName, options.readOnlyRoots)) ??
      (await guardLockedClips(
        projectDir,
        event.input,
        event.toolName,
        askBeforeLockedEdits?.() ?? true,
      )) ??
      (await leaseRefusal(projectDir, event, options.claimWriteFiles));
    if (reason) return { block: true, reason };
    if (Object.hasOwn(WRITING_TOOLS, event.toolName)) options.noteFileWrite?.(event.toolName);
    return undefined;
  };
}

async function leaseRefusal(
  projectDir: string,
  event: GuardedToolCall,
  claim: ToolGuardOptions["claimWriteFiles"],
): Promise<string | null> {
  if (!claim || !Object.hasOwn(WRITING_TOOLS, event.toolName)) return null;
  const files = await compositionTargets(projectDir, event.input);
  return files.length > 0 ? claim(files) : null;
}

export function projectBoundaryExtension(
  projectDir: string,
  refusal?: ToolCallRefusal,
  askBeforeLockedEdits?: () => boolean,
  options: ToolGuardOptions = {},
): ExtensionFactory {
  const guard = projectToolCallGuard(projectDir, refusal, askBeforeLockedEdits, options);
  return (pi) => {
    pi.on("tool_call", guard);
  };
}
