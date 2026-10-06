import type { ChatEvent } from "./events.js";
import {
  isAgentRunTerminal,
  type AgentRun,
  type AssistantMessage,
  type AssistantPart,
  type ChatMessage,
  type ChatState,
  type ChatSummary,
  type PlanStep,
  type TurnSummary,
} from "./types.js";
import { sumUsage } from "./usage.js";
import type { TurnQaState } from "./qa.js";

/** A chat before its first event: the state `chat.created` is folded into. */
export function emptyChatState(chat: ChatSummary): ChatState {
  return { chat, messages: [], turns: [], runs: [], lastSeq: 0 };
}

/** True when `event` is the next event the state expects (no gap, no replay). */
export function isNextEvent(state: ChatState, event: ChatEvent): boolean {
  return event.seq === state.lastSeq + 1;
}

function isAssistant(message: ChatMessage): message is AssistantMessage {
  return message.role === "assistant";
}

function mapAssistant(
  messages: ChatMessage[],
  messageId: string,
  update: (message: AssistantMessage) => AssistantMessage,
): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === messageId);
  const target = messages[index];
  if (index < 0 || !target || !isAssistant(target)) return messages;
  const next = messages.slice();
  next[index] = update(target);
  return next;
}

function upsertPart(parts: AssistantPart[], part: AssistantPart): AssistantPart[] {
  const index = parts.findIndex((existing) => existing.id === part.id);
  if (index < 0) return [...parts, part];
  const next = parts.slice();
  next[index] = part;
  return next;
}

/**
 * Replaces a turn by id. Terminal turn events do not repeat the plan, so a known plan is kept; once the turn has
 * ended no step can still be running or pending: a completed turn finished its running steps and skipped the rest,
 * any other end skipped both. The same holds for render QA: a session still running when the turn ended was stopped.
 */
function upsertTurn(turns: TurnSummary[], turn: TurnSummary): TurnSummary[] {
  const index = turns.findIndex((existing) => existing.id === turn.id);
  if (index < 0) return [...turns, turn];
  const known = turn.plan ?? turns[index]?.plan;
  const plan =
    known && turn.status !== "running"
      ? known.proposal
        ? // A plan proposal waits for the user: its pending steps are not settled by the turn ending.
          known
        : {
            ...known,
            steps: known.steps.map((step): PlanStep => {
              if (step.status === "running")
                return { ...step, status: turn.status === "completed" ? "done" : "skipped" };
              if (step.status === "pending") return { ...step, status: "skipped" };
              return step;
            }),
          }
      : known;
  const knownQa = turn.qa ?? turns[index]?.qa;
  const qa = knownQa && turn.status !== "running" ? settleQa(knownQa) : knownQa;
  const previous = turns[index];
  const usage = turn.usage ?? previous?.usage;
  const directorUsage = turn.directorUsage ?? previous?.directorUsage;
  const directorContext = turn.directorContext ?? previous?.directorContext;
  const changes = turn.changes ?? previous?.changes;
  const next = turns.slice();
  next[index] = {
    ...turn,
    ...(plan && { plan }),
    ...(qa && { qa }),
    ...(usage && { usage }),
    ...(directorUsage && { directorUsage }),
    ...(changes && { changes }),
    ...(directorContext && { directorContext }),
  };
  return next;
}

function settleQa(qa: TurnQaState): TurnQaState {
  if (qa.status !== "running") return qa;
  return {
    ...qa,
    status: "aborted",
    passes: qa.passes.map((pass) =>
      pass.phase === "done" || pass.phase === "corrected" || pass.phase === "failed"
        ? pass
        : { ...pass, phase: "aborted" },
    ),
  };
}

function upsertRun(runs: AgentRun[], run: AgentRun): AgentRun[] {
  const index = runs.findIndex((existing) => existing.id === run.id);
  if (index < 0) return [...runs, run];
  const previous = runs[index];
  const next = runs.slice();
  // Run lifecycle events do not repeat the usage reports, so what is known is kept.
  const usage = run.usage ?? previous?.usage;
  const context = run.context ?? previous?.context;
  next[index] = { ...run, ...(usage && { usage }), ...(context && { context }) };
  return next;
}

/** A turn ended without closing some of its runs (only a crashed runtime does that): they cannot still be running. */
function settleTurnRuns(runs: AgentRun[], turn: TurnSummary): AgentRun[] {
  const status = turn.status === "interrupted" ? "interrupted" : "aborted";
  return runs.map((run) =>
    run.turnId === turn.id && !isAgentRunTerminal(run.status)
      ? { ...run, status, endedAt: turn.endedAt ?? run.startedAt }
      : run,
  );
}

/**
 * Recomputes the usage totals after a change: each turn's `usage` is its Director bucket plus every run of the turn,
 * the chat's `usage` is the sum over its turns. Totals nothing reported stay as the event carried them (a chat
 * summary may bring a total for turns this state has not folded).
 */
function refreshUsage(
  turns: TurnSummary[],
  runs: AgentRun[],
  chat: ChatSummary,
): { turns: TurnSummary[]; chat: ChatSummary } {
  const nextTurns = turns.map((turn): TurnSummary => {
    const usage = sumUsage([
      turn.directorUsage,
      ...runs.filter((run) => run.turnId === turn.id).map((run) => run.usage),
    ]);
    return usage ? { ...turn, usage } : turn;
  });
  const total = sumUsage(nextTurns.map((turn) => turn.usage));
  return { turns: nextTurns, chat: total ? { ...chat, usage: total } : chat };
}

/** Marks every still-streaming assistant message of a turn as ended. */
function settleTurnMessages(
  messages: ChatMessage[],
  turn: TurnSummary,
  status: "complete" | "aborted" | "failed",
): ChatMessage[] {
  return messages.map((message) =>
    isAssistant(message) && message.turnId === turn.id && message.status === "streaming"
      ? { ...message, status, parts: message.parts.map(settleOpenPart) }
      : message,
  );
}

function settleOpenPart(part: AssistantPart): AssistantPart {
  if (part.type === "thinking" && !part.done) return { ...part, done: true };
  if (part.type === "activity" && part.activity.status === "running") {
    return { ...part, activity: { ...part.activity, status: "done" } };
  }
  if (part.type === "permission" && part.permission.state === "pending") {
    return { ...part, permission: { ...part.permission, state: "expired" } };
  }
  if (part.type === "question" && part.question.state === "pending") {
    return { ...part, question: { ...part.question, state: "expired" } };
  }
  if (part.type === "voice-setup" && part.setup.state === "pending") {
    return { ...part, setup: { ...part.setup, state: "expired" } };
  }
  if (part.type === "voice-pilot" && part.pilot.state === "pending") {
    return { ...part, pilot: { ...part.pilot, state: "expired" } };
  }
  return part;
}

/**
 * Folds one event into a chat's state. Pure; events at or below `lastSeq` are
 * ignored so replays and overlapping snapshot/stream windows are harmless. A
 * gap (see {@link isNextEvent}) is still applied — the caller decides whether
 * to resync from a fresh snapshot.
 */
export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
  if (event.seq <= state.lastSeq) return state;
  const base = { ...state, lastSeq: event.seq };

  switch (event.type) {
    case "chat.created":
    case "chat.updated":
      return { ...base, ...refreshUsage(state.turns, state.runs, event.chat) };

    case "turn.started":
      return {
        ...base,
        turns: upsertTurn(state.turns, event.turn),
        messages: [...state.messages, event.promptMessage, event.assistantMessage],
      };

    case "message.appended":
      return { ...base, messages: [...state.messages, event.message] };

    case "assistant.text.delta":
      return {
        ...base,
        messages: mapAssistant(state.messages, event.messageId, (message) => {
          const existing = message.parts.find((part) => part.id === event.partId);
          const previous = existing?.type === "text" ? existing : null;
          return {
            ...message,
            parts: upsertPart(message.parts, {
              type: "text",
              id: event.partId,
              text: (previous?.text ?? "") + event.delta,
              ...(previous?.interim && { interim: true as const }),
            }),
          };
        }),
      };

    case "assistant.parts.interim":
      return {
        ...base,
        messages: mapAssistant(state.messages, event.messageId, (message) => ({
          ...message,
          parts: message.parts.map((part) =>
            part.type === "text" && event.partIds.includes(part.id)
              ? { ...part, interim: true as const }
              : part,
          ),
        })),
      };

    case "thinking.updated":
      return {
        ...base,
        messages: mapAssistant(state.messages, event.messageId, (message) => {
          const existing = message.parts.find((part) => part.id === event.partId);
          const previous = existing?.type === "thinking" ? existing : null;
          return {
            ...message,
            parts: upsertPart(message.parts, {
              type: "thinking",
              id: event.partId,
              text: (previous?.text ?? "") + event.delta,
              done: event.done,
              startedAt: previous?.startedAt ?? event.ts,
              ...(event.done ? { endedAt: event.ts } : {}),
            }),
          };
        }),
      };

    case "activity.updated":
      return {
        ...base,
        messages: mapAssistant(state.messages, event.messageId, (message) => ({
          ...message,
          parts: upsertPart(message.parts, {
            type: "activity",
            id: event.activity.id,
            activity: event.activity,
          }),
        })),
      };

    case "question.updated":
      return {
        ...base,
        messages: mapAssistant(state.messages, event.messageId, (message) => ({
          ...message,
          parts: upsertPart(message.parts, {
            type: "question",
            id: event.question.id,
            question: event.question,
          }),
        })),
      };

    case "permission.updated":
      return {
        ...base,
        messages: mapAssistant(state.messages, event.messageId, (message) => ({
          ...message,
          parts: upsertPart(message.parts, {
            type: "permission",
            id: event.permission.id,
            permission: event.permission,
          }),
        })),
      };

    case "storyOffer.updated":
      return {
        ...base,
        messages: mapAssistant(state.messages, event.messageId, (message) => ({
          ...message,
          parts: upsertPart(message.parts, {
            type: "story-offer",
            id: event.offer.id,
            offer: event.offer,
          }),
        })),
      };

    case "voiceSetup.updated":
      return {
        ...base,
        messages: mapAssistant(state.messages, event.messageId, (message) => ({
          ...message,
          parts: upsertPart(message.parts, {
            type: "voice-setup",
            id: event.setup.id,
            setup: event.setup,
          }),
        })),
      };

    case "voicePilot.updated":
      return {
        ...base,
        messages: mapAssistant(state.messages, event.messageId, (message) => ({
          ...message,
          parts: upsertPart(message.parts, {
            type: "voice-pilot",
            id: event.pilot.id,
            pilot: event.pilot,
          }),
        })),
      };

    case "message.completed":
      return {
        ...base,
        messages: mapAssistant(state.messages, event.messageId, (message) => ({
          ...message,
          status: event.status,
        })),
      };

    case "checkpoint.updated": {
      const turns = state.turns.map((turn) =>
        turn.id === event.turnId ? { ...turn, checkpoint: event.checkpoint } : turn,
      );
      return { ...base, turns };
    }

    case "plan.updated": {
      const turns = state.turns.map((turn) =>
        turn.id === event.turnId ? { ...turn, plan: event.plan } : turn,
      );
      return { ...base, turns };
    }

    case "qa.updated": {
      const turns = state.turns.map((turn) =>
        turn.id === event.turnId ? { ...turn, qa: event.qa } : turn,
      );
      return { ...base, turns };
    }

    case "agent.started": {
      const withDelegation = mapAssistant(state.messages, event.parentMessageId, (message) => ({
        ...message,
        parts: upsertPart(message.parts, {
          type: "delegation",
          id: event.run.id,
          runId: event.run.id,
        }),
      }));
      return {
        ...base,
        runs: upsertRun(state.runs, event.run),
        messages: [...withDelegation, event.taskMessage, event.assistantMessage],
      };
    }

    case "agent.updated":
      return { ...base, runs: upsertRun(state.runs, event.run) };

    case "agent.completed": {
      const status =
        event.run.status === "completed"
          ? "complete"
          : event.run.status === "failed"
            ? "failed"
            : "aborted";
      return {
        ...base,
        runs: upsertRun(state.runs, event.run),
        messages: mapAssistant(state.messages, event.run.assistantMessageId, (message) =>
          message.status === "streaming"
            ? { ...message, status, parts: message.parts.map(settleOpenPart) }
            : message,
        ),
      };
    }

    case "turn.completed":
    case "turn.failed":
    case "turn.aborted": {
      const turns = upsertTurn(state.turns, event.turn);
      const runs = settleTurnRuns(state.runs, event.turn);
      const status =
        event.type === "turn.completed"
          ? "complete"
          : event.type === "turn.failed"
            ? "failed"
            : "aborted";
      return {
        ...base,
        runs,
        messages: settleTurnMessages(state.messages, event.turn, status),
        ...refreshUsage(turns, runs, state.chat),
      };
    }

    case "usage.updated": {
      const turn = state.turns.find((existing) => existing.id === event.turnId);
      if (!turn) return base;
      let runs = state.runs;
      let turns = state.turns;
      if (event.runId === null) {
        turns = turns.map((existing) =>
          existing.id === turn.id
            ? {
                ...existing,
                directorUsage: event.usage,
                ...(event.context && { directorContext: event.context }),
              }
            : existing,
        );
      } else {
        const run = state.runs.find((existing) => existing.id === event.runId);
        if (!run || run.turnId !== turn.id) return base;
        runs = upsertRun(runs, {
          ...run,
          usage: event.usage,
          ...(event.context && { context: event.context }),
        });
      }
      return { ...base, runs, ...refreshUsage(turns, runs, state.chat) };
    }
  }
}

/** Folds a whole event log; the durable store loads chats this way. */
export function foldChatEvents(events: readonly ChatEvent[]): ChatState | null {
  const first = events[0];
  if (!first || first.type !== "chat.created") return null;
  let state = emptyChatState(first.chat);
  for (const event of events) state = applyChatEvent(state, event);
  return state;
}
