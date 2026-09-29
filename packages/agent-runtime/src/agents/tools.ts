import {
  PLAN_STEP_STATUSES,
  SPECIALIST_IDS,
  THINKING_EFFORTS,
  isRecord,
  isSpecialistId,
  isThinkingEffort,
  type AgentId,
  type PlanStepStatus,
  type SpecialistId,
  type ThinkingEffort,
} from "@hyperframes/agent-protocol";
import type { HostTool, HostToolResult } from "../backend.js";

export const TOOL_NAMES = {
  plan: "update_plan",
  delegate: "delegate",
  wait: "wait_for_agents",
  cancel: "cancel_agent",
  message: "message_agent",
  jev: "jev",
} as const;

export const LIMITS = {
  planSteps: 12,
  stepTitleChars: 120,
  runTitleChars: 80,
  taskChars: 20_000,
} as const;

export type ToolExecutor = (
  name: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<HostToolResult>;

/** What a turn makes available; decides which tools an agent gets and what their schemas allow. */
export interface ToolAvailability {
  enabled: SpecialistId[];
  jev: boolean;
}

const stringProperty = (description: string, maxLength?: number) => ({
  type: "string",
  description,
  ...(maxLength !== undefined && { maxLength }),
});

function jevTool(execute: ToolExecutor): HostTool {
  return {
    name: TOOL_NAMES.jev,
    description:
      "Run a small, well-defined micro-task on Jev, the fast low-cost worker (it can read and edit project files). Blocks until Jev answers and returns its reply. Use it for quick lookups or mechanical edits that do not need deep reasoning.",
    parameters: {
      type: "object",
      properties: {
        title: stringProperty(
          "Short label for the task (shown to the user).",
          LIMITS.runTitleChars,
        ),
        task: stringProperty("Exact, self-contained instructions.", LIMITS.taskChars),
      },
      required: ["title", "task"],
      additionalProperties: false,
    },
    execute: (args, signal) => execute(TOOL_NAMES.jev, args, signal),
  };
}

/** The runtime-implemented tools of one agent. Specialists and Jev never get delegation tools (one level only). */
export function buildHostTools(
  agent: AgentId,
  availability: ToolAvailability,
  execute: ToolExecutor,
): HostTool[] {
  if (agent === "jev") return [];
  if (agent !== "director") return availability.jev ? [jevTool(execute)] : [];

  const planAgents: AgentId[] = ["director", ...availability.enabled];
  if (availability.jev) planAgents.push("jev");
  const tools: HostTool[] = [
    {
      name: TOOL_NAMES.plan,
      description:
        "Publish or replace the compact execution plan shown to the user (3–7 short product-level steps). Call it again to update step statuses.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            minItems: 1,
            maxItems: LIMITS.planSteps,
            items: {
              type: "object",
              properties: {
                title: stringProperty("Short step title.", LIMITS.stepTitleChars),
                status: { type: "string", enum: [...PLAN_STEP_STATUSES] },
                agent: {
                  type: "string",
                  enum: planAgents,
                  description: "Who does this step, if known.",
                },
              },
              required: ["title", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["steps"],
        additionalProperties: false,
      },
      execute: (args, signal) => execute(TOOL_NAMES.plan, args, signal),
    },
  ];

  if (availability.enabled.length > 0) {
    tools.push(
      {
        name: TOOL_NAMES.delegate,
        description:
          "Start an enabled specialist on one self-contained task. Returns immediately with a run id; collect the result with wait_for_agents. The specialist cannot see the conversation, so include everything it needs.",
        parameters: {
          type: "object",
          properties: {
            agent: { type: "string", enum: [...availability.enabled] },
            title: stringProperty(
              "Short task title shown to the user, e.g. 'Build the intro title card'.",
              LIMITS.runTitleChars,
            ),
            task: stringProperty("Complete instructions for the specialist.", LIMITS.taskChars),
            model: stringProperty(
              "Optional 'provider/modelId' for this task only; must be one of the models allowed for the specialist.",
            ),
            thinking: {
              type: "string",
              enum: [...THINKING_EFFORTS],
              description:
                "Optional lower thinking effort for a simple task; cannot exceed the configured effort.",
            },
          },
          required: ["agent", "title", "task"],
          additionalProperties: false,
        },
        execute: (args, signal) => execute(TOOL_NAMES.delegate, args, signal),
      },
      {
        name: TOOL_NAMES.wait,
        description:
          "Wait until delegated runs finish and return their reports. Without runIds it waits for every run you started that has not been reported yet. Returns early when the user sends a new instruction.",
        parameters: {
          type: "object",
          properties: { runIds: { type: "array", items: { type: "string" } } },
          additionalProperties: false,
        },
        execute: (args, signal) => execute(TOOL_NAMES.wait, args, signal),
      },
      {
        name: TOOL_NAMES.message,
        description:
          "Send a correction or extra instruction to a specialist run that is still running.",
        parameters: {
          type: "object",
          properties: {
            runId: stringProperty("The run to message."),
            text: stringProperty("The instruction.", LIMITS.taskChars),
          },
          required: ["runId", "text"],
          additionalProperties: false,
        },
        execute: (args, signal) => execute(TOOL_NAMES.message, args, signal),
      },
      {
        name: TOOL_NAMES.cancel,
        description: "Stop a delegated run that is no longer needed.",
        parameters: {
          type: "object",
          properties: {
            runId: stringProperty("The run to stop."),
            reason: stringProperty("Why, for the log.", 200),
          },
          required: ["runId"],
          additionalProperties: false,
        },
        execute: (args, signal) => execute(TOOL_NAMES.cancel, args, signal),
      },
    );
  }
  if (availability.jev) tools.push(jevTool(execute));
  return tools;
}

// ── Argument parsing (models send loosely typed JSON) ────────────────────────

export type ParsedArgs<T> = { ok: true; value: T } | { ok: false; message: string };

function text(value: unknown, field: string, max: number): ParsedArgs<string> {
  if (typeof value !== "string" || !value.trim())
    return { ok: false, message: `${field} is required` };
  const trimmed = value.trim();
  return trimmed.length > max
    ? { ok: false, message: `${field} is longer than ${max} characters` }
    : { ok: true, value: trimmed };
}

export interface PlanArgs {
  steps: Array<{ title: string; status: PlanStepStatus; agent: AgentId | null }>;
}

export function parsePlanArgs(args: unknown): ParsedArgs<PlanArgs> {
  if (!isRecord(args) || !Array.isArray(args.steps) || args.steps.length === 0)
    return { ok: false, message: "steps must be a non-empty array" };
  if (args.steps.length > LIMITS.planSteps)
    return { ok: false, message: `at most ${LIMITS.planSteps} steps` };
  const steps: PlanArgs["steps"] = [];
  for (const raw of args.steps) {
    if (!isRecord(raw)) return { ok: false, message: "each step must be an object" };
    const title = text(raw.title, "step title", LIMITS.stepTitleChars);
    if (!title.ok) return title;
    const status = PLAN_STEP_STATUSES.find((known) => known === raw.status);
    if (!status)
      return { ok: false, message: `step status must be one of ${PLAN_STEP_STATUSES.join(", ")}` };
    const agent =
      raw.agent === "director" || raw.agent === "jev" || isSpecialistId(raw.agent)
        ? raw.agent
        : null;
    steps.push({ title: title.value, status, agent });
  }
  return { ok: true, value: { steps } };
}

export interface DelegateArgs {
  agent: SpecialistId;
  title: string;
  task: string;
  model?: string;
  thinking?: ThinkingEffort;
}

export function parseDelegateArgs(args: unknown): ParsedArgs<DelegateArgs> {
  if (!isRecord(args)) return { ok: false, message: "arguments must be an object" };
  if (!isSpecialistId(args.agent))
    return { ok: false, message: `agent must be one of ${SPECIALIST_IDS.join(", ")}` };
  const title = text(args.title, "title", LIMITS.runTitleChars);
  if (!title.ok) return title;
  const task = text(args.task, "task", LIMITS.taskChars);
  if (!task.ok) return task;
  if (args.model !== undefined && typeof args.model !== "string")
    return { ok: false, message: "model must be 'provider/modelId'" };
  if (args.thinking !== undefined && !isThinkingEffort(args.thinking))
    return { ok: false, message: `thinking must be one of ${THINKING_EFFORTS.join(", ")}` };
  return {
    ok: true,
    value: {
      agent: args.agent,
      title: title.value,
      task: task.value,
      ...(typeof args.model === "string" && args.model.trim() && { model: args.model.trim() }),
      ...(isThinkingEffort(args.thinking) && { thinking: args.thinking }),
    },
  };
}

export function parseWaitArgs(args: unknown): ParsedArgs<{ runIds: string[] | null }> {
  if (args === undefined || args === null) return { ok: true, value: { runIds: null } };
  if (!isRecord(args)) return { ok: false, message: "arguments must be an object" };
  if (args.runIds === undefined) return { ok: true, value: { runIds: null } };
  if (!Array.isArray(args.runIds) || !args.runIds.every((id) => typeof id === "string"))
    return { ok: false, message: "runIds must be an array of run ids" };
  return { ok: true, value: { runIds: args.runIds.length > 0 ? args.runIds : null } };
}

export function parseRunArgs(
  args: unknown,
  withText: boolean,
): ParsedArgs<{ runId: string; text: string | null }> {
  if (!isRecord(args) || typeof args.runId !== "string" || !args.runId)
    return { ok: false, message: "runId is required" };
  if (!withText) return { ok: true, value: { runId: args.runId, text: null } };
  const message = text(args.text, "text", LIMITS.taskChars);
  return message.ok ? { ok: true, value: { runId: args.runId, text: message.value } } : message;
}

export function parseJevArgs(args: unknown): ParsedArgs<{ title: string; task: string }> {
  if (!isRecord(args)) return { ok: false, message: "arguments must be an object" };
  const title = text(args.title, "title", LIMITS.runTitleChars);
  if (!title.ok) return title;
  const task = text(args.task, "task", LIMITS.taskChars);
  return task.ok ? { ok: true, value: { title: title.value, task: task.value } } : task;
}
