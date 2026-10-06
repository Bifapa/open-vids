import { isRecord } from "./validate.js";
import type { AgentId, ModelSelection, UsageTotals } from "./types.js";
import { AGENT_DISPLAY_NAMES } from "./types.js";

/**
 * Project usage: the journal the runtime keeps in `.hyperframes/agent/usage.jsonl` and the `GET …/agent/usage` report
 * folded from it. Costs are the providers' own figures for the models' calls; nothing else in OpenVids prices work
 * (speech, transcription and stock libraries run locally or are free), so the report is "Agent costs".
 */

/** Runs the runtime starts itself, outside what the user or the Director asked for: they get their own report row. */
export const USAGE_INTERNAL_KINDS = ["render_qa"] as const;
export type UsageInternalKind = (typeof USAGE_INTERNAL_KINDS)[number];

/** One report row's agent: a chat agent, or the runtime-started Render QA review (a Vision run on its own row). */
export type UsageAgentKey = AgentId | UsageInternalKind;

/** The agents whose usage is overhead of the product rather than something the user asked for. */
export function isInternalUsageAgent(key: UsageAgentKey): boolean {
  return key === "jev" || key === "render_qa";
}

/**
 * One journal line: what one agent of one turn used (the Director's own share when `runId` is null, else one run).
 * Written when the turn ends, so the figures are final; a line is identified by `turnId` + `runId`.
 */
export interface UsageEntry {
  chatId: string;
  /** The chat's title when the line was written, so a deleted chat can still be named. */
  chatTitle: string;
  turnId: string;
  runId: string | null;
  agent: AgentId;
  /** Set on runs the runtime started itself; they are reported apart from the agent that ran them. */
  internal?: UsageInternalKind;
  /** The model the agent ran on; null when the runtime did not say. */
  model: ModelSelection | null;
  usage: UsageTotals;
  /** Epoch ms the turn ended (the period filter looks at it). */
  at: number;
}

/** The key that makes a journal line unique: a repeated line (crash recovery) replaces the earlier one. */
export function usageEntryKey(entry: Pick<UsageEntry, "turnId" | "runId">): string {
  return `${entry.turnId}\u0000${entry.runId ?? ""}`;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function isUsageTotals(value: unknown): value is UsageTotals {
  return (
    isRecord(value) &&
    finite(value.input) &&
    finite(value.output) &&
    finite(value.cacheRead) &&
    finite(value.cacheWrite) &&
    finite(value.totalTokens) &&
    (value.cost === null || finite(value.cost))
  );
}

function isModelSelection(value: unknown): value is ModelSelection {
  return isRecord(value) && typeof value.provider === "string" && typeof value.modelId === "string";
}

function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && Object.hasOwn(AGENT_DISPLAY_NAMES, value);
}

/** A journal line as read back from disk; null for anything else (a torn or foreign line is skipped, never fatal). */
export function parseUsageEntry(value: unknown): UsageEntry | null {
  if (!isRecord(value)) return null;
  const { chatId, chatTitle, turnId, runId, agent, internal, model, usage, at } = value;
  if (typeof chatId !== "string" || typeof turnId !== "string" || !finite(at)) return null;
  if (runId !== null && typeof runId !== "string") return null;
  if (!isAgentId(agent) || !isUsageTotals(usage)) return null;
  if (model !== null && !isModelSelection(model)) return null;
  const kind = USAGE_INTERNAL_KINDS.find((candidate) => candidate === internal);
  if (internal !== undefined && kind === undefined) return null;
  return {
    chatId,
    chatTitle: typeof chatTitle === "string" ? chatTitle : "",
    turnId,
    runId,
    agent,
    ...(kind && { internal: kind }),
    model,
    usage,
    at,
  };
}

// ── The report ───────────────────────────────────────────────────────────────

/**
 * What a group of entries used. `usage.cost` adds only the costs the providers reported (null when none did);
 * `unpricedTokens` counts the tokens of entries without a reported cost, so a cost with `unpricedTokens > 0` is a
 * lower bound, and a null cost is "tokens only", never zero.
 */
export interface UsageSlice {
  usage: UsageTotals;
  unpricedTokens: number;
}

export interface UsageAgentSlice extends UsageSlice {
  agent: UsageAgentKey;
  /** Jev and the Render QA review: shown apart from the agents the user works with. */
  internal: boolean;
}

export interface UsageModelSlice extends UsageSlice {
  /** Null: entries whose model the runtime did not report. */
  model: ModelSelection | null;
}

export interface UsageChatSlice extends UsageSlice {
  chatId: string;
  title: string;
  /** The chat no longer exists; its usage still counts. */
  deleted: boolean;
}

export interface UsageReport {
  /** The period that was asked for (`null`: open end). */
  period: { since: number | null; until: number | null };
  total: UsageSlice;
  byAgent: UsageAgentSlice[];
  byModel: UsageModelSlice[];
  byChat: UsageChatSlice[];
  /** A turn is running: the figures include what it has used so far and keep growing. */
  live: boolean;
}

/** `GET …/agent/usage` query: epoch milliseconds, either end optional (inclusive `since`, exclusive `until`). */
export interface UsageQuery {
  since: number | null;
  until: number | null;
}

export type UsageQueryResult = { ok: true; value: UsageQuery } | { ok: false; message: string };

export function parseUsageQuery(params: URLSearchParams): UsageQueryResult {
  const read = (
    name: string,
  ): { ok: true; value: number | null } | { ok: false; message: string } => {
    const raw = params.get(name);
    if (raw === null || raw === "") return { ok: true, value: null };
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0)
      return { ok: false, message: `${name} must be a non-negative number of milliseconds` };
    return { ok: true, value };
  };
  const since = read("since");
  if (!since.ok) return since;
  const until = read("until");
  if (!until.ok) return until;
  if (since.value !== null && until.value !== null && since.value >= until.value)
    return { ok: false, message: "since must be before until" };
  return { ok: true, value: { since: since.value, until: until.value } };
}

function isSlice(value: unknown): value is UsageSlice {
  return isRecord(value) && isUsageTotals(value.usage) && finite(value.unpricedTokens);
}

export function isUsageReport(value: unknown): value is UsageReport {
  if (!isRecord(value) || !isRecord(value.period) || !isSlice(value.total)) return false;
  const { since, until } = value.period;
  if ((since !== null && !finite(since)) || (until !== null && !finite(until))) return false;
  return (
    typeof value.live === "boolean" &&
    Array.isArray(value.byAgent) &&
    value.byAgent.every(
      (slice) =>
        isSlice(slice) &&
        isRecord(slice) &&
        isAgentKey(slice.agent) &&
        typeof slice.internal === "boolean",
    ) &&
    Array.isArray(value.byModel) &&
    value.byModel.every(
      (slice) =>
        isSlice(slice) &&
        isRecord(slice) &&
        (slice.model === null || isModelSelection(slice.model)),
    ) &&
    Array.isArray(value.byChat) &&
    value.byChat.every(
      (slice) =>
        isSlice(slice) &&
        isRecord(slice) &&
        typeof slice.chatId === "string" &&
        typeof slice.title === "string" &&
        typeof slice.deleted === "boolean",
    )
  );
}

function isAgentKey(value: unknown): value is UsageAgentKey {
  return isAgentId(value) || USAGE_INTERNAL_KINDS.some((kind) => kind === value);
}
