import {
  PLAN_STEP_STATUSES,
  QUESTION_MAX_OPTIONS,
  QUESTION_OPTION_MAX_CHARS,
  SPECIALIST_IDS,
  THINKING_EFFORTS,
  isRecord,
  isSpecialistId,
  isThinkingEffort,
  type AgentId,
  type PlanStepStatus,
  type SpecialistId,
  type StoryOfferChapter,
  type ThinkingEffort,
} from "@hyperframes/agent-protocol";
import { parseSpecialistName } from "./aliases.js";
import { LIMITS } from "./tools.js";

// ── Argument parsing (models send loosely typed JSON) ────────────────────────

export type ParsedArgs<T> = { ok: true; value: T } | { ok: false; message: string };

export function text(value: unknown, field: string, max: number): ParsedArgs<string> {
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
      ...(summary ? { summary: summary.slice(0, LIMITS.chapterSummaryChars) } : {}),
      ...(typeof raw.durationSeconds === "number" ? { durationSeconds: raw.durationSeconds } : {}),
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
  // Models write the specialist as `_editor`, `Editor`, `delegate_to_editor`: all of these name the Editor.
  const agent = parseSpecialistName(args.agent);
  if (!agent) return { ok: false, message: `agent must be one of ${SPECIALIST_IDS.join(", ")}` };
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
      agent,
      title: title.value,
      task: task.value,
      ...(typeof args.model === "string" && args.model.trim() && { model: args.model.trim() }),
      ...(isThinkingEffort(args.thinking) && { thinking: args.thinking }),
    },
  };
}

export interface WaitArgs {
  runIds: string[] | null;
  /** Return as soon as one waited run ends (default: when all of them have). */
  any: boolean;
  /** How long this call may block before it reports progress and returns; null = the default. */
  timeoutSeconds: number | null;
}

export function parseWaitArgs(args: unknown): ParsedArgs<WaitArgs> {
  const all: WaitArgs = { runIds: null, any: false, timeoutSeconds: null };
  if (args === undefined || args === null) return { ok: true, value: all };
  if (!isRecord(args)) return { ok: false, message: "arguments must be an object" };
  if (
    args.runIds !== undefined &&
    (!Array.isArray(args.runIds) || !args.runIds.every((id) => typeof id === "string"))
  )
    return { ok: false, message: "runIds must be an array of run ids" };
  if (args.until !== undefined && args.until !== "all" && args.until !== "any")
    return { ok: false, message: 'until must be "all" or "any"' };
  if (
    args.timeoutSeconds !== undefined &&
    (typeof args.timeoutSeconds !== "number" || !Number.isFinite(args.timeoutSeconds))
  )
    return { ok: false, message: "timeoutSeconds must be a number of seconds" };
  return {
    ok: true,
    value: {
      runIds: Array.isArray(args.runIds) && args.runIds.length > 0 ? args.runIds : null,
      any: args.until === "any",
      timeoutSeconds:
        typeof args.timeoutSeconds === "number"
          ? Math.min(LIMITS.waitMaxSeconds, Math.max(LIMITS.waitMinSeconds, args.timeoutSeconds))
          : null,
    },
  };
}

export function parseRunArgs(
  args: unknown,
  withText: boolean,
): ParsedArgs<{ runId: string; text: string | null; reason: string | null }> {
  if (!isRecord(args) || typeof args.runId !== "string" || !args.runId)
    return { ok: false, message: "runId is required" };
  const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : null;
  if (!withText) return { ok: true, value: { runId: args.runId, text: null, reason } };
  const message = text(args.text, "text", LIMITS.taskChars);
  return message.ok
    ? { ok: true, value: { runId: args.runId, text: message.value, reason } }
    : message;
}

export function parseJevArgs(args: unknown): ParsedArgs<{ title: string; task: string }> {
  if (!isRecord(args)) return { ok: false, message: "arguments must be an object" };
  const title = text(args.title, "title", LIMITS.runTitleChars);
  if (!title.ok) return title;
  const task = text(args.task, "task", LIMITS.taskChars);
  return task.ok ? { ok: true, value: { title: title.value, task: task.value } } : task;
}

export interface QuestionArgs {
  question: string;
  options: string[];
}

/**
 * `request_input`'s question and suggested answers. Options are trimmed and de-duplicated; more than the limit or an
 * over-long one is an error the model can correct (a button cut short would change its meaning).
 */
export function parseQuestionArgs(args: unknown): ParsedArgs<QuestionArgs> {
  if (!isRecord(args)) return { ok: false, message: "arguments must be an object" };
  const question = text(args.question, "question", LIMITS.questionChars);
  if (!question.ok) return question;
  const options: string[] = [];
  if (args.options !== undefined) {
    if (!Array.isArray(args.options)) return { ok: false, message: "options must be an array" };
    for (const raw of args.options) {
      if (typeof raw !== "string") return { ok: false, message: "each option must be a string" };
      const option = raw.trim();
      if (!option) continue;
      if (option.length > QUESTION_OPTION_MAX_CHARS)
        return {
          ok: false,
          message: `each option must be at most ${QUESTION_OPTION_MAX_CHARS} characters`,
        };
      if (!options.includes(option)) options.push(option);
    }
    if (options.length > QUESTION_MAX_OPTIONS)
      return { ok: false, message: `at most ${QUESTION_MAX_OPTIONS} options` };
  }
  return { ok: true, value: { question: question.value, options } };
}
