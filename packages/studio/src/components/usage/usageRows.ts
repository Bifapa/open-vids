import type {
  ModelSelection,
  UsageAgentSlice,
  UsageChatSlice,
  UsageModelSlice,
  UsageReport,
  UsageSlice,
} from "@hyperframes/agent-protocol";
import { t, type TranslationKey } from "../../i18n";
import { AGENT_NAME_KEYS } from "../chat/agentLabels";

export const USAGE_VIEWS = ["agents", "models", "chats"] as const;
export type UsageView = (typeof USAGE_VIEWS)[number];

export interface UsageRow {
  key: string;
  label: string;
  /** Shown as a tooltip on the label (the full model id, a deleted chat's note). */
  hint?: string;
  slice: UsageSlice;
  /** Jev and the Render QA review: listed under their own heading. */
  internal: boolean;
}

const modelId = (model: ModelSelection | null) =>
  model ? `${model.provider}/${model.modelId}` : null;

function agentLabel(slice: UsageAgentSlice): string {
  if (slice.agent === "render_qa") return t("shell.usage.agent.render_qa");
  const key: TranslationKey = AGENT_NAME_KEYS[slice.agent];
  return t(key);
}

function modelRow(slice: UsageModelSlice): UsageRow {
  const id = modelId(slice.model);
  return {
    key: id ?? "unknown",
    label: slice.model?.modelId ?? t("shell.usage.model.unknown"),
    ...(id && { hint: id }),
    slice,
    internal: false,
  };
}

function chatRow(slice: UsageChatSlice): UsageRow {
  const title = slice.title || t("shell.usage.chat.untitled");
  return {
    key: slice.chatId,
    label: slice.deleted ? `${title} (${t("shell.usage.chat.deleted")})` : title,
    slice,
    internal: false,
  };
}

/** The report's slice for the chosen view, as rows: agents keep Jev and Render QA apart (`internal`). */
export function usageRows(report: UsageReport, view: UsageView): UsageRow[] {
  if (view === "models") return report.byModel.map(modelRow);
  if (view === "chats") return report.byChat.map(chatRow);
  return report.byAgent.map((slice) => ({
    key: slice.agent,
    label: agentLabel(slice),
    slice,
    internal: slice.internal,
  }));
}

/** The share of all tokens a slice used, 0–1. */
export function tokenShare(slice: UsageSlice, total: UsageSlice): number {
  return total.usage.totalTokens > 0 ? slice.usage.totalTokens / total.usage.totalTokens : 0;
}
