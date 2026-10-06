import {
  usageEntryKey,
  type ModelSelection,
  type UsageAgentKey,
  type UsageAgentSlice,
  type UsageChatSlice,
  type UsageEntry,
  type UsageModelSlice,
  type UsageQuery,
  type UsageReport,
  type UsageSlice,
} from "@hyperframes/agent-protocol";
import { isInternalUsageAgent } from "@hyperframes/agent-protocol";

/** Costs are summed as whole nano-dollars, so a total and the sum of its parts agree exactly (floats would not). */
const NANO = 1e9;

class Accumulator {
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  totalTokens = 0;
  nano: number | null = null;
  unpricedTokens = 0;

  add(entry: UsageEntry): void {
    const { usage } = entry;
    this.input += usage.input;
    this.output += usage.output;
    this.cacheRead += usage.cacheRead;
    this.cacheWrite += usage.cacheWrite;
    this.totalTokens += usage.totalTokens;
    if (usage.cost === null) this.unpricedTokens += usage.totalTokens;
    else this.nano = (this.nano ?? 0) + Math.round(usage.cost * NANO);
  }

  slice(): UsageSlice {
    return {
      usage: {
        input: this.input,
        output: this.output,
        cacheRead: this.cacheRead,
        cacheWrite: this.cacheWrite,
        totalTokens: this.totalTokens,
        cost: this.nano === null ? null : this.nano / NANO,
      },
      unpricedTokens: this.unpricedTokens,
    };
  }
}

function group<K>(entries: readonly UsageEntry[], keyOf: (entry: UsageEntry) => K) {
  const groups = new Map<K, Accumulator>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const accumulator = groups.get(key) ?? new Accumulator();
    accumulator.add(entry);
    groups.set(key, accumulator);
  }
  return groups;
}

const byTokens = <T extends UsageSlice>(left: T, right: T) =>
  right.usage.totalTokens - left.usage.totalTokens;

const agentKeyOf = (entry: UsageEntry): UsageAgentKey => entry.internal ?? entry.agent;
const modelKeyOf = (model: ModelSelection | null) =>
  model ? `${model.provider}/${model.modelId}` : "";

export interface UsageReportInput {
  /** The journal's entries. */
  journal: readonly UsageEntry[];
  /** What the running turn has used so far; an entry the journal already has is ignored. */
  live: readonly UsageEntry[];
  /** A turn is running (its figures are in `live`, or it has not reported any yet). */
  turnRunning: boolean;
  query: UsageQuery;
  /** Titles of the chats that still exist; a chat missing here is reported as deleted, with the title it had. */
  chatTitles: ReadonlyMap<string, string>;
}

/**
 * Folds the journal (and the running turn) into the report slices. One entry per `turnId` + `runId`: a repeated line
 * (crash recovery) counts once, and the same turn found in two chats (a copied chat) counts once too. Chats play no
 * part in the totals, so deleting one leaves them as they were.
 */
export function buildUsageReport(input: UsageReportInput): UsageReport {
  const unique = new Map<string, UsageEntry>();
  for (const entry of input.journal) unique.set(usageEntryKey(entry), entry);
  for (const entry of input.live) {
    const key = usageEntryKey(entry);
    if (!unique.has(key)) unique.set(key, entry);
  }
  const { since, until } = input.query;
  const entries = [...unique.values()].filter(
    (entry) => (since === null || entry.at >= since) && (until === null || entry.at < until),
  );

  const total = new Accumulator();
  for (const entry of entries) total.add(entry);

  const byAgent: UsageAgentSlice[] = [...group(entries, agentKeyOf)].map(([agent, sum]) => ({
    agent,
    internal: isInternalUsageAgent(agent),
    ...sum.slice(),
  }));

  const models = new Map<string, ModelSelection | null>();
  for (const entry of entries) models.set(modelKeyOf(entry.model), entry.model);
  const byModel: UsageModelSlice[] = [...group(entries, (entry) => modelKeyOf(entry.model))].map(
    ([key, sum]) => ({ model: models.get(key) ?? null, ...sum.slice() }),
  );

  const latest = new Map<string, UsageEntry>();
  for (const entry of entries) {
    const seen = latest.get(entry.chatId);
    if (!seen || entry.at >= seen.at) latest.set(entry.chatId, entry);
  }
  const byChat: UsageChatSlice[] = [...group(entries, (entry) => entry.chatId)].map(
    ([chatId, sum]) => {
      const title = input.chatTitles.get(chatId);
      return {
        chatId,
        title: title ?? latest.get(chatId)?.chatTitle ?? "",
        deleted: title === undefined,
        ...sum.slice(),
      };
    },
  );

  return {
    period: { since, until },
    total: total.slice(),
    byAgent: byAgent.sort(byTokens),
    byModel: byModel.sort(byTokens),
    byChat: byChat.sort(byTokens),
    live: input.turnRunning,
  };
}
