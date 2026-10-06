import type {
  AgentId,
  AgentRun,
  AssistantMessage,
  ModelSelection,
  TaskMessage,
  ThinkingEffort,
  WorkerAgentId,
} from "@hyperframes/agent-protocol";
import { renderAutonomyBlock } from "../autonomy.js";
import { renderResearchBlock, websiteAccessLine } from "../research/prompt.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import type { RunRecord } from "./runRecord.js";
import { renderSpecialistTask } from "./taskText.js";

/** What it takes to start one run. */
export interface RunInput {
  agent: WorkerAgentId;
  title: string;
  titleCode?: string;
  titleParams?: Record<string, string | number>;
  task: string;
  from: AgentId;
  parentRunId: string | null;
  parentMessageId: string;
  model: ModelSelection | null;
  thinking: ThinkingEffort | null;
  routed: boolean;
  /** A run the runtime started itself: the Director never has to collect it and it is no step of the user's plan. */
  internal?: boolean;
}

/** What the run is given to begin with: the task with the user's words, the editor context and the turn's policies. */
function taskTextFor(deps: OrchestratorDeps, input: RunInput): string {
  const { setup, chats, chatId, turn } = deps;
  const text = renderSpecialistTask({
    title: input.title,
    from: input.from,
    task: input.task,
    messages: chats.get(chatId)?.messages ?? [],
    turnId: turn.id,
    ...(setup.editorContext && { editorContext: setup.editorContext }),
    ...(setup.userLanguage && { userLanguage: setup.userLanguage }),
  });
  // The agents that write compositions (and Jev, which edits files) are told which design system the project carries.
  const writesCompositions =
    input.agent === "editor" || input.agent === "motion" || input.agent === "jev";
  const design = writesCompositions ? (setup.designBlock ?? null) : null;
  if (input.agent === "jev") return [text, design].filter(Boolean).join("\n\n");
  // Research works under the user's Asset Search policy; it is stated with every task it gets. Every specialist is told
  // what the user's Autonomy settings mean for locked material (and Research for downloads).
  const research =
    input.agent === "research" && turn.storyAction !== "rebuild"
      ? renderResearchBlock(setup.research, setup.execution.budget.researchCandidates)
      : null;
  // Motion may read a linked site itself; it is told when full access is off so it asks the user instead of failing.
  const website = input.agent === "motion" ? websiteAccessLine(setup.research) : null;
  const autonomy = renderAutonomyBlock(setup.autonomy, input.agent);
  return [text, design, research, website, autonomy].filter(Boolean).join("\n\n");
}

/** The run, its first messages and its record, ready to be announced to the chat. */
export function createRun(
  deps: OrchestratorDeps,
  input: RunInput,
  queued: boolean,
): { record: RunRecord; taskMessage: TaskMessage; assistantMessage: AssistantMessage } {
  const { chatId, turn, now, ids } = deps;
  const startedAt = now();
  const run: AgentRun = {
    id: ids(),
    turnId: turn.id,
    agent: input.agent,
    parentRunId: input.parentRunId,
    title: input.title,
    ...(input.titleCode !== undefined && { titleCode: input.titleCode }),
    ...(input.titleParams !== undefined && { titleParams: input.titleParams }),
    status: queued ? "queued" : "running",
    model: input.model,
    thinking: input.thinking,
    routedByDirector: input.routed,
    taskMessageId: ids(),
    assistantMessageId: ids(),
    startedAt,
    summary: null,
  };
  const taskMessage: TaskMessage = {
    id: run.taskMessageId,
    chatId,
    turnId: turn.id,
    createdAt: startedAt,
    role: "task",
    runId: run.id,
    agent: input.agent,
    from: input.from,
    parts: [{ type: "text", id: ids(), text: input.task }],
    steering: false,
  };
  const assistantMessage: AssistantMessage = {
    id: run.assistantMessageId,
    chatId,
    turnId: turn.id,
    createdAt: startedAt,
    role: "assistant",
    parts: [],
    status: "streaming",
    model: input.model,
    runId: run.id,
    agent: input.agent,
  };
  const internal = input.internal ?? false;
  const record: RunRecord = {
    run,
    controller: new AbortController(),
    session: null,
    done: Promise.resolve(),
    report: null,
    reported: internal,
    cancelled: false,
    cancelledBy: null,
    cancelReason: null,
    finished: false,
    internal,
    slot: null,
    stalled: null,
    started: false,
    queuedMessages: [],
    taskText: taskTextFor(deps, input),
    watchdog: null,
  };
  return { record, taskMessage, assistantMessage };
}
