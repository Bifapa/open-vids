import type { ChatState, UsageEntry, UsageInternalKind } from "@hyperframes/agent-protocol";

/** `titleCode` of the Vision run the runtime starts for one Render QA pass (see `qa/review.ts`). */
const RENDER_QA_TITLE_CODE = "render_qa_pass";

/**
 * What one turn of a chat used, one entry for the Director and one per run, as the chat's state holds it now. Agents
 * that used nothing are left out. A turn that is still running yields its figures so far.
 */
export function usageEntriesOfTurn(state: ChatState, turnId: string): UsageEntry[] {
  const turn = state.turns.find((candidate) => candidate.id === turnId);
  if (!turn) return [];
  const runs = state.runs.filter((run) => run.turnId === turnId);
  const at = Math.max(
    turn.endedAt ?? turn.startedAt,
    turn.startedAt,
    ...runs.map((run) => run.endedAt ?? run.startedAt),
  );
  const base = { chatId: state.chat.id, chatTitle: state.chat.title, turnId, at };
  const entries: UsageEntry[] = [];
  if (turn.directorUsage) {
    entries.push({
      ...base,
      runId: null,
      agent: "director",
      model: turn.model,
      usage: turn.directorUsage,
    });
  }
  for (const run of runs) {
    if (!run.usage) continue;
    const internal: UsageInternalKind | undefined =
      run.titleCode === RENDER_QA_TITLE_CODE ? "render_qa" : undefined;
    entries.push({
      ...base,
      runId: run.id,
      agent: run.agent,
      ...(internal && { internal }),
      model: run.model,
      usage: run.usage,
    });
  }
  return entries.filter((entry) => entry.usage.totalTokens > 0 || (entry.usage.cost ?? 0) > 0);
}
