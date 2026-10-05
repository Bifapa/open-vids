import { STORY_ACTIONS, type AgentId, type SpecialistId } from "@hyperframes/agent-protocol";
import type { BackendSession, HostTool, OpenBackendSessionInput } from "../backend.js";
import type { TurnAgentSetup } from "../agents/orchestrator.js";
import { directorInstructions, jevInstructions, specialistInstructions } from "../agents/roles.js";
import { buildHostTools, type ToolAvailability } from "../agents/tools.js";
import type { RunSlot, TurnContext } from "./context.js";
import { askBeforeLockedEdits, fileWriteRefusal, noteFileWrite } from "./gates.js";
import { dispatchTool } from "./dispatch.js";

type PerTurn = Pick<
  ToolAvailability,
  "mode" | "storyAction" | "intent" | "planProposal" | "storyOffer"
>;

/**
 * Every shape of turn the tool lists differ by: an Ask or Edit turn, a normal or story-mode one, each Story action,
 * with and without the plan and Story Mode offers.
 */
const SHAPE_FLAGS = { intent: "edit", planProposal: true, storyOffer: true } as const;
const TURN_SHAPES: PerTurn[] = [
  { mode: "normal", storyAction: null, ...SHAPE_FLAGS },
  { mode: "story", storyAction: null, ...SHAPE_FLAGS },
  ...STORY_ACTIONS.map(
    (action): PerTurn => ({ mode: "story", storyAction: action, ...SHAPE_FLAGS }),
  ),
];

/**
 * The tools a session is opened with: the union of what any kind of turn would give this agent, in a fixed order. A
 * session keeps the tools it was opened with, and reopening it whenever a turn differs (Ask after Edit, a Story offer
 * that is no longer eligible) would discard the harness's warm state for nothing. The runtime enforces the actual
 * turn at dispatch instead: each call is checked against the turn's intent, phase, mode and the agent's own tool
 * set, and a refusal says why the tool is unavailable now.
 */
export function stableHostTools(
  agent: AgentId,
  availability: ToolAvailability,
  execute: Parameters<typeof buildHostTools>[2],
): HostTool[] {
  const merged = new Map<string, HostTool>();
  for (const shape of TURN_SHAPES) {
    for (const tool of buildHostTools(agent, { ...availability, ...shape }, execute)) {
      if (!merged.has(tool.name)) merged.set(tool.name, tool);
    }
  }
  return [...merged.values()];
}

function instructionsOf(agent: AgentId, enabled: readonly SpecialistId[]): string {
  if (agent === "director") return directorInstructions(enabled);
  if (agent === "jev") return jevInstructions();
  return specialistInstructions(agent);
}

/** The run a specialist session is opened for: `parallel` is an additional, ephemeral session of a busy specialist. */
export interface SessionRun {
  id: string;
  parallel: boolean;
}

/**
 * The chat's resumable session for the Director or a specialist. With a `parallel` run it is a second, ephemeral
 * session for a specialist that runs two tasks at once; the caller owns and disposes it. A specialist's session knows
 * the run it serves: tool calls and file writes made through it belong to that run, however many runs of the same
 * specialist are going.
 */
export async function agentSession(
  ctx: TurnContext,
  chatId: string,
  agent: "director" | SpecialistId,
  availability: ToolAvailability,
  run?: SessionRun,
): Promise<BackendSession> {
  const slot = slotFor(ctx, chatId, agent, run);
  const hostTools = stableHostTools(agent, availability, (name, args, signal, progress) =>
    dispatchTool(ctx, chatId, agent, name, args, signal, progress, slot.runId),
  );
  const instructions = instructionsOf(agent, availability.enabled);
  const contextHash = await ctx.backend.contextHash?.(ctx.chats.scope.projectDir);
  const parallel = run?.parallel === true;
  const open = async (): Promise<OpenBackendSessionInput> => ({
    chatId,
    agent,
    projectDir: ctx.chats.scope.projectDir,
    stateDir: parallel
      ? null
      : agent === "director"
        ? await ctx.store.stateDir(chatId)
        : await ctx.store.agentStateDir(chatId, agent),
    instructions,
    hostTools,
    ...guards(ctx, chatId, agent, slot),
  });
  if (parallel) return ctx.backend.openSession(await open());
  return ctx.sessions.get({
    chatId,
    agent,
    signature: JSON.stringify([
      instructions,
      hostTools.map((tool) => [tool.name, tool.description, tool.parameters]),
      contextHash ?? null,
    ]),
    open,
  });
}

/**
 * Which run a session's closures work for. The Director serves none; an ephemeral (parallel) session keeps its run for
 * good; the resumable session of a specialist is one object per chat and agent that every new run is bound to, so the
 * closures a long-lived session was opened with always see the run that has it now.
 */
function slotFor(
  ctx: TurnContext,
  chatId: string,
  agent: "director" | SpecialistId,
  run: SessionRun | undefined,
): RunSlot {
  if (!run) return { runId: null };
  if (run.parallel) return { runId: run.id };
  const key = `${chatId}|${agent}`;
  const slot = ctx.runSlots.get(key) ?? { runId: null };
  slot.runId = run.id;
  ctx.runSlots.set(key, slot);
  return slot;
}

/** Jev: a fresh in-memory session per call, with the read-only host tools and without any project-changing ones. */
export function jevSession(
  ctx: TurnContext,
  chatId: string,
  setup: TurnAgentSetup,
  availability: ToolAvailability,
  runId: string,
): Promise<BackendSession> {
  const credentials = setup.jev?.credentials;
  return ctx.backend.openSession({
    chatId,
    agent: "jev",
    projectDir: ctx.chats.scope.projectDir,
    stateDir: null,
    instructions: jevInstructions(),
    hostTools: stableHostTools("jev", availability, (name, args, signal, progress) =>
      dispatchTool(ctx, chatId, "jev", name, args, signal, progress, runId),
    ),
    ...guards(ctx, chatId, "jev", { runId }),
    ...(credentials && { credentials }),
  });
}

/**
 * What the harness asks the runtime before it writes a file itself (edit/write) or meets a locked clip. A write takes
 * the lease of the run the session serves — a Jev run writes under the lease of the specialist that called it — and
 * the Director only checks the leases of others.
 */
function guards(
  ctx: TurnContext,
  chatId: string,
  agent: AgentId,
  slot: RunSlot,
): Pick<
  OpenBackendSessionInput,
  "fileWriteRefusal" | "askBeforeLockedEdits" | "claimWriteFiles" | "noteFileWrite"
> {
  return {
    fileWriteRefusal: (toolName: string) => fileWriteRefusal(ctx, chatId, toolName),
    askBeforeLockedEdits: () => askBeforeLockedEdits(ctx, chatId),
    claimWriteFiles: (files: string[]) => {
      const writer =
        slot.runId === null ? null : (ctx.active?.orchestrator?.leaseWriterOf(slot.runId) ?? null);
      return ctx.leases.claim(writer ?? { agent, runId: null }, files);
    },
    noteFileWrite: (toolName: string) => noteFileWrite(ctx, chatId, toolName),
  };
}
