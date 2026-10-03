import {
  PLAN_STEP_STATUSES,
  SPECIALIST_IDS,
  THINKING_EFFORTS,
  isRecord,
  isSpecialistId,
  isThinkingEffort,
  type AgentId,
  type ChatIntent,
  type ChatMode,
  type PlanStepStatus,
  type SpecialistId,
  type StoryAction,
  type StoryOfferChapter,
  type ThinkingEffort,
} from "@hyperframes/agent-protocol";
import type { HostTool, HostToolResult } from "../backend.js";
import { buildAnalysisTools } from "../analysis/tools.js";
import { buildEditingTools } from "../editing/tools.js";
import { buildStoryTools, timelineWritesAllowed, type StoryTurnMode } from "../story/tools.js";
import { buildResearchTools, type KnownCandidate } from "../research/tools.js";
import { changesProject } from "../intent.js";
import { buildQaTools } from "../qa/tools.js";

export const TOOL_NAMES = {
  propose: "propose_plan",
  offerStory: "offer_story_mode",
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
  storyChapters: 12,
  chapterTitleChars: 120,
  chapterSummaryChars: 400,
  chapterMaterialChars: 200,
} as const;

export type ToolExecutor = (
  name: string,
  args: unknown,
  signal: AbortSignal,
  progress?: (percent: number) => void,
) => Promise<HostToolResult>;

/** What a turn makes available; decides which tools an agent gets and what their schemas allow. */
export interface ToolAvailability {
  enabled: SpecialistId[];
  jev: boolean;
  /** The runtime has an editing host: agents get the editing tools their role allows. */
  editing: boolean;
  /** The runtime has an analysis host: agents get the analysis tools their role allows. */
  analysis: boolean;
  /** Ranges of a plan this turn has planned, for the label of build_rough_cut's activity row. */
  planClips?: (plan: string) => number | undefined;
  /** The runtime has a story host: agents get the story tools their role and the turn's mode allow. */
  story?: boolean;
  /** The turn's mode (default `normal`). A story-mode turn without a build action never writes the timeline. */
  mode?: ChatMode;
  /** The Story workspace action of the turn (`review`, `build`, `rebuild`), if any. */
  storyAction?: StoryAction | null;
  /** What the user wants from the turn (default `edit`). An Ask turn gets no project-changing tools. */
  intent?: ChatIntent;
  /**
   * The Director may propose a plan this turn (an Edit turn that is not a story-mode or execute-plan turn, with the
   * user's plan approval on `big` or `always`): it gets `propose_plan`, and the turn's prompt states when to use it.
   */
  planProposal?: boolean;
  /**
   * The Director may offer Story Mode this turn (a normal-mode Edit turn, not an execute-plan turn, in a chat that
   * has not declined one, while the project's Story graph has no chapters): it gets `offer_story_mode`, and the
   * turn's prompt states when to use it. Accepting the offer writes the chapters through the story host.
   */
  storyOffer?: boolean;
  /**
   * The runtime has a research host and the user's Asset Search policy could be read: Research gets the search and
   * import tools and the Director the read-only sources tool (whichever the chat's team and the turn allow).
   */
  research?: boolean;
  /**
   * The runtime has a research host: the Director, Motion and Research get `read_website` (a site the user linked) even
   * when Research is off in the chat or the Asset Search policy could not be read.
   */
  websites?: boolean;
  /**
   * The user's Asset Search policy currently has full access to linked sites on. `get_website_file` and
   * `record_website` are offered whenever a research host exists; this only tells their results the setting is on
   * (a call whose setting is off asks the user in chat).
   */
  websiteFiles?: boolean;
  /** A candidate the turn's searches returned, for the activity label of an import. */
  researchCandidate?: (id: string) => KnownCandidate | undefined;
  /** The display name of a trusted source in the user's policy, for the activity label of a search. */
  researchSourceName?: (id: string) => string | undefined;
  /** The turn's budget of candidates per search (Execution Quality): the default and the maximum `limit` of search_assets. */
  researchCandidates?: number;
  /** The runtime runs Render QA this turn: Vision gets the render-review tools (they work only inside a review). */
  qa?: boolean;
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
  const turn: StoryTurnMode = {
    mode: availability.mode ?? "normal",
    action: availability.storyAction ?? null,
  };
  // A story-mode turn that does not build the story never writes the timeline: no edit_timeline, render_video or
  // build_rough_cut for anyone (analysis and planning tools stay).
  const timelineWrites = timelineWritesAllowed(turn);
  const editing = availability.editing
    ? buildEditingTools(agent, availability.enabled, execute, { timelineWrites })
    : [];
  const analysis = availability.analysis
    ? buildAnalysisTools(
        agent,
        availability.enabled,
        {
          editing: availability.editing && timelineWrites,
          ...(availability.planClips && { planClips: availability.planClips }),
        },
        execute,
      )
    : [];
  const story = availability.story
    ? buildStoryTools(agent, availability.enabled, turn, execute)
    : [];
  const research =
    availability.research || availability.websites
      ? buildResearchTools(agent, availability.enabled, turn, execute, {
          access: {
            assets: availability.research === true,
            websites: availability.websites === true,
            websiteFiles: availability.websiteFiles === true,
          },
          ...(availability.researchCandidate && { candidate: availability.researchCandidate }),
          ...(availability.researchSourceName && { sourceName: availability.researchSourceName }),
          ...(availability.researchCandidates !== undefined && {
            candidateLimit: availability.researchCandidates,
          }),
        })
      : [];
  const qa = availability.qa ? buildQaTools(agent, execute) : [];
  const allTools =
    agent === "director"
      ? directorTools(availability, execute, [...editing, ...analysis, ...story, ...research])
      : [
          ...editing,
          ...analysis,
          ...story,
          ...research,
          ...qa,
          ...(availability.jev ? [jevTool(execute)] : []),
        ];
  // A Plan or Ask turn never changes the project: its project-changing tools are not offered at all.
  if ((availability.intent ?? "edit") === "edit") return allTools;
  return allTools.filter((tool) => !changesProject(tool.name));
}

function directorTools(
  availability: ToolAvailability,
  execute: ToolExecutor,
  projectTools: HostTool[],
): HostTool[] {
  const planAgents: AgentId[] = ["director", ...availability.enabled];
  if (availability.jev) planAgents.push("jev");
  const tools: HostTool[] = [];
  if (availability.planProposal) {
    tools.push({
      name: TOOL_NAMES.propose,
      description:
        "Propose a plan and stop before changing anything (the user's plan-approval setting says when this is required). Publish 3–7 short product-level steps in the order you will do them. After this call every project-changing tool is refused for the rest of this turn: end with a short summary of the plan.",
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
                agent: {
                  type: "string",
                  enum: planAgents,
                  description: "Who does this step, if known.",
                },
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
        },
        required: ["steps"],
        additionalProperties: false,
      },
      execute: (args, signal) => execute(TOOL_NAMES.propose, args, signal),
    });
  }
  if (availability.storyOffer) {
    tools.push({
      name: TOOL_NAMES.offerStory,
      description:
        "Offer Story Mode when the user describes the video itself as an ordered structure of three or more content parts (scenes, chapters, «сначала … потом … затем …», a numbered list of parts): pass the chapters in their own words and order. Do not use it for a list of editing operations, and not for fewer than three parts. After this call every project-changing tool is refused for the rest of this turn: reply in one or two sentences about what the story would do with these chapters and end the turn.",
      parameters: {
        type: "object",
        properties: {
          chapters: {
            type: "array",
            minItems: 3,
            maxItems: LIMITS.storyChapters,
            items: {
              type: "object",
              properties: {
                title: stringProperty(
                  "The part's title, in the user's words.",
                  LIMITS.chapterTitleChars,
                ),
                summary: stringProperty(
                  "One short line about what this part shows, when the user said it.",
                  LIMITS.chapterSummaryChars,
                ),
                durationSeconds: {
                  type: "number",
                  description: "Intended length in seconds, when the user said it.",
                },
                material: stringProperty(
                  "The footage or material this part needs, when the user said it.",
                  LIMITS.chapterMaterialChars,
                ),
              },
              required: ["title"],
              additionalProperties: false,
            },
          },
        },
        required: ["chapters"],
        additionalProperties: false,
      },
      execute: (args, signal) => execute(TOOL_NAMES.offerStory, args, signal),
    });
  }
  tools.push({
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
  });

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
  tools.push(...projectTools);
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

export interface ProposalArgs {
  steps: Array<{ title: string; agent: AgentId | null }>;
}

export interface StoryOfferArgs {
  chapters: StoryOfferChapter[];
}

/**
 * `offer_story_mode`'s chapters: three or more parts of the video, in the user's order. Titles are required; the
 * rest is kept only when the model sent something usable (a whitespace-only summary is no summary).
 */
export function parseStoryOfferArgs(args: unknown): ParsedArgs<StoryOfferArgs> {
  if (!isRecord(args) || !Array.isArray(args.chapters))
    return { ok: false, message: "chapters must be an array of the video's parts" };
  if (args.chapters.length < 3)
    return {
      ok: false,
      message:
        "a Story Mode offer needs at least 3 chapters; offer only when the user described the video as an ordered structure of parts",
    };
  if (args.chapters.length > LIMITS.storyChapters)
    return { ok: false, message: `at most ${LIMITS.storyChapters} chapters` };
  const chapters: StoryOfferChapter[] = [];
  for (const raw of args.chapters) {
    if (!isRecord(raw)) return { ok: false, message: "each chapter must be an object" };
    const title = text(raw.title, "chapter title", LIMITS.chapterTitleChars);
    if (!title.ok) return title;
    if (raw.summary !== undefined && typeof raw.summary !== "string")
      return { ok: false, message: "chapter summary must be a string" };
    if (raw.material !== undefined && typeof raw.material !== "string")
      return { ok: false, message: "chapter material must be a string" };
    if (
      raw.durationSeconds !== undefined &&
      (typeof raw.durationSeconds !== "number" ||
        !Number.isFinite(raw.durationSeconds) ||
        raw.durationSeconds <= 0)
    )
      return { ok: false, message: "chapter durationSeconds must be a number of seconds > 0" };
    const summary = raw.summary?.trim();
    const material = raw.material?.trim();
    chapters.push({
      title: title.value,
      ...(summary
        ? { summary: summary.slice(0, LIMITS.chapterSummaryChars) }
        : {}),
      ...(typeof raw.durationSeconds === "number"
        ? { durationSeconds: raw.durationSeconds }
        : {}),
      ...(material ? { material: material.slice(0, LIMITS.chapterMaterialChars) } : {}),
    });
  }
  return { ok: true, value: { chapters } };
}

/** `propose_plan`'s steps become pending `PlanStep`s: the user approves titles, statuses arrive later. */
export function parseProposalArgs(args: unknown): ParsedArgs<ProposalArgs> {
  if (!isRecord(args) || !Array.isArray(args.steps) || args.steps.length === 0)
    return { ok: false, message: "steps must be a non-empty array" };
  if (args.steps.length > LIMITS.planSteps)
    return { ok: false, message: `at most ${LIMITS.planSteps} steps` };
  const steps: ProposalArgs["steps"] = [];
  for (const raw of args.steps) {
    if (!isRecord(raw)) return { ok: false, message: "each step must be an object" };
    const title = text(raw.title, "step title", LIMITS.stepTitleChars);
    if (!title.ok) return title;
    const agent =
      raw.agent === "director" || raw.agent === "jev" || isSpecialistId(raw.agent)
        ? raw.agent
        : null;
    steps.push({ title: title.value, agent });
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
