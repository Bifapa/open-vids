import {
  PLAN_STEP_STATUSES,
  QUESTION_MAX_OPTIONS,
  QUESTION_OPTION_MAX_CHARS,
  SPECIALIST_IDS,
  THINKING_EFFORTS,
  type DesignAction,
  type AgentId,
  type ChatIntent,
  type ChatMode,
  type SpecialistId,
  type StoryAction,
} from "@hyperframes/agent-protocol";
import type { HostTool, HostToolResult, ToolProgress } from "../backend.js";
import { buildAnalysisTools } from "../analysis/tools.js";
import { buildEditingTools } from "../editing/tools.js";
import { buildDesignTools } from "../design/tools.js";
import { buildStoryTools, timelineWritesAllowed, type StoryTurnMode } from "../story/tools.js";
import { buildResearchTools, type KnownCandidate } from "../research/tools.js";
import { changesProject } from "../intent.js";
import { buildFrameTools } from "../editing/frames.tools.js";
import { buildCrossProjectTools } from "../crossProject/tools.js";
import { buildQaTools } from "../qa/tools.js";
import { buildVoiceTools } from "../voice/tools.js";

export const TOOL_NAMES = {
  propose: "propose_plan",
  offerStory: "offer_story_mode",
  plan: "update_plan",
  delegate: "delegate",
  wait: "wait_for_agents",
  cancel: "cancel_agent",
  message: "message_agent",
  jev: "jev",
  input: "request_input",
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
  /** request_input: the question's length, and how many suggested answers (each at most QUESTION_OPTION_MAX_CHARS). */
  questionChars: 600,
  /** wait_for_agents: the bounds of one call's timeout hint, and its default, in seconds. */
  waitMinSeconds: 5,
  waitMaxSeconds: 600,
  waitDefaultSeconds: 120,
} as const;

export type ToolExecutor = (
  name: string,
  args: unknown,
  signal: AbortSignal,
  progress?: ToolProgress,
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
  /**
   * The Design Systems action of the turn (`create`, `edit`), if any: the Director gets the design tools, and nobody
   * writes the timeline (a design turn writes the design library, never compositions).
   */
  designAction?: DesignAction | null;
  /**
   * The runtime has a design host (Design Systems is on): the Director gets the design tools — all of them in a design
   * turn, the typed-request subset (list, read, extract, save, attach) in an ordinary one.
   */
  design?: boolean;
  /**
   * The runtime has a voice host (Voiceover is on): Audio gets `request_voice_setup` and `generate_voiceover`, the
   * Director `request_voice_setup` and, while Audio is off in the chat, `generate_voiceover` too.
   */
  voice?: boolean;
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
   * import tools, the Director the read-only sources tool and, while Research is off in the chat, the search and
   * import tools too (whichever the turn allows).
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
  /** The runtime has a frames host: the agents that judge the picture get `inspect_composition`. */
  frames?: boolean;
  /**
   * The runtime has a cross-project host and the user attached at least one other project in this chat: the agents
   * that place media get `import_from_project` (the executor re-checks the attachment on every call).
   */
  crossProject?: boolean;
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

function inputTool(execute: ToolExecutor): HostTool {
  return {
    name: TOOL_NAMES.input,
    description:
      "Ask the user one question and wait for the answer, without ending the turn. Use it only when a missing decision would materially change the result and you cannot settle it from the project, the brief or sensible defaults (which of two different cuts to keep, a format the brief does not imply, an irreversible choice). Do not use it to ask for permission to do what the user already asked, to confirm the obvious or to report progress. Offer up to six short options when the answer is a choice; the user can always type their own. The call returns the user's answer; if the turn ends before they answer, it returns that no answer came. Ask once, with everything you need, not a series of questions.",
    parameters: {
      type: "object",
      properties: {
        question: stringProperty(
          "The question, in the user's language, self-contained and short.",
          LIMITS.questionChars,
        ),
        options: {
          type: "array",
          maxItems: QUESTION_MAX_OPTIONS,
          items: {
            type: "string",
            maxLength: QUESTION_OPTION_MAX_CHARS,
          },
          description: "Suggested answers shown as buttons (optional).",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    execute: (args, signal) => execute(TOOL_NAMES.input, args, signal),
  };
}

/**
 * The runtime-implemented tools of one agent. Specialists and Jev never get delegation tools (one level only). Jev gets
 * the read-only project, timeline, story and analysis readers and nothing that changes the project. A disabled
 * specialist's tools are the Director's: every family applies the inheritance rule inside its own `...ToolsFor`.
 */
export function buildHostTools(
  agent: AgentId,
  availability: ToolAvailability,
  execute: ToolExecutor,
): HostTool[] {
  const turn: StoryTurnMode = {
    mode: availability.mode ?? "normal",
    action: availability.storyAction ?? null,
  };
  // A story-mode turn that does not build the story, and a design turn, never write the timeline: no edit_timeline,
  // render_video or build_rough_cut for anyone (analysis and planning tools stay).
  const designAction = availability.designAction ?? null;
  const timelineWrites = timelineWritesAllowed(turn) && designAction === null;
  const editing = availability.editing
    ? buildEditingTools(agent, availability.enabled, execute, {
        timelineWrites,
        voice: availability.voice === true,
      })
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
    ? buildStoryTools(agent, availability.enabled, turn, execute, {
        voice: availability.voice === true,
      })
    : [];
  const researchFamily = agent !== "jev" && (availability.research || availability.websites);
  const research = researchFamily
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
  const qa =
    availability.qa && agent !== "jev" ? buildQaTools(agent, availability.enabled, execute) : [];
  const frames =
    availability.frames && agent !== "jev"
      ? buildFrameTools(agent, availability.enabled, execute)
      : [];
  const crossProject =
    availability.crossProject && agent !== "jev"
      ? buildCrossProjectTools(agent, availability.enabled, turn, execute)
      : [];
  const design = buildDesignTools(
    agent,
    { available: availability.design === true, action: designAction },
    execute,
  );
  const voice =
    availability.voice && agent !== "jev"
      ? buildVoiceTools(agent, availability.enabled, execute)
      : [];
  const projectTools = [
    ...editing,
    ...analysis,
    ...story,
    ...design,
    ...voice,
    ...research,
    ...frames,
    ...crossProject,
    ...qa,
  ];
  const allTools =
    agent === "director"
      ? directorTools(availability, execute, projectTools)
      : [...projectTools, ...(availability.jev && agent !== "jev" ? [jevTool(execute)] : [])];
  const withInput = agent === "jev" ? allTools : [...allTools, inputTool(execute)];
  // A Plan or Ask turn never changes the project: its project-changing tools are not offered at all.
  if ((availability.intent ?? "edit") === "edit") return withInput;
  return withInput.filter((tool) => !changesProject(tool.name));
}

/**
 * What a specialist's work comes with in this turn, for the Director that does it when the specialist is off: the
 * specialist's own project tools that the Director has now and would not have with the whole team enabled. Derived
 * from the tool families for the turn that runs, so a tool the turn refuses (the story build outside a build turn)
 * is never named. Names only; nothing is executed.
 */
export function inheritedToolsOf(
  availability: ToolAvailability,
): (specialist: SpecialistId) => string[] {
  const names = (agent: AgentId, enabled: SpecialistId[]) =>
    buildHostTools(agent, { ...availability, enabled }, async () => ({
      text: "",
      isError: true,
    })).map((tool) => tool.name);
  const everyone = [...SPECIALIST_IDS];
  const directorNow = new Set(names("director", availability.enabled));
  const directorAlways = new Set(names("director", everyone));
  // A specialist's tools are asked for as if it were on: a family offers a specialist nothing in a chat that disabled it.
  return (specialist) =>
    names(specialist, everyone).filter(
      (name) => directorNow.has(name) && !directorAlways.has(name),
    );
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
          "Start an enabled specialist on one self-contained task (a specialist that is off is not offered here: do its work yourself). Returns immediately with a run id; collect the result with wait_for_agents. The specialist cannot see the conversation beyond the user's own words of this turn, so include everything it needs.",
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
        description: `Wait for delegated runs and return their reports. Without runIds it waits for every run you started that has not been reported yet. It returns when they have finished (until "any": when the first has), when the user sends a new instruction, or after timeoutSeconds (default ${LIMITS.waitDefaultSeconds}) with a progress note, so a long wait costs one call, not many.`,
        parameters: {
          type: "object",
          properties: {
            runIds: { type: "array", items: { type: "string" } },
            until: {
              type: "string",
              enum: ["all", "any"],
              description:
                "Return when all of the runs have finished (default) or as soon as one has.",
            },
            timeoutSeconds: {
              type: "number",
              minimum: LIMITS.waitMinSeconds,
              maximum: LIMITS.waitMaxSeconds,
              description: "Longest this call may block before it reports what is still going.",
            },
          },
          additionalProperties: false,
        },
        execute: (args, signal) => execute(TOOL_NAMES.wait, args, signal),
      },
      {
        name: TOOL_NAMES.message,
        description:
          "Send a correction or extra instruction to a specialist run that is running or still queued (a queued run sees it in front of its task).",
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
