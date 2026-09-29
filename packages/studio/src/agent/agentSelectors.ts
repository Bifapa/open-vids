import type {
  AgentModelCatalog,
  AgentModelInfo,
  ChatState,
  ModelSelection,
  ThinkingEffort,
  TurnSummary,
} from "@hyperframes/agent-protocol";

/** The turn currently running in a chat, if any. */
export function runningTurn(chat: ChatState | null): TurnSummary | null {
  if (!chat) return null;
  for (let index = chat.turns.length - 1; index >= 0; index -= 1) {
    const turn = chat.turns[index];
    if (turn?.status === "running") return turn;
  }
  return null;
}

export function findModel(
  catalog: AgentModelCatalog | null,
  selection: ModelSelection | null,
): AgentModelInfo | null {
  if (!catalog || !selection) return null;
  return (
    catalog.models.find(
      (model) => model.provider === selection.provider && model.modelId === selection.modelId,
    ) ?? null
  );
}

export interface ResolvedModel {
  /** What the chat runs with: its own choice, else the runtime default. */
  selection: ModelSelection | null;
  /** The catalog entry for `selection`; null when the catalog does not list it. */
  info: AgentModelInfo | null;
  /** True when the chat has no explicit model and the runtime default applies. */
  isDefault: boolean;
}

export function resolveModel(
  explicit: ModelSelection | null,
  catalog: AgentModelCatalog | null,
): ResolvedModel {
  const selection = explicit ?? catalog?.defaultModel ?? null;
  return { selection, info: findModel(catalog, selection), isDefault: explicit === null };
}

/** Efforts the picker offers: Off plus whatever the model accepts. Empty when it has no control. */
export function effortChoices(info: AgentModelInfo | null): ThinkingEffort[] {
  if (!info || info.efforts.length === 0) return [];
  return ["off", ...info.efforts.filter((effort) => effort !== "off")];
}

export function displayModelName(
  selection: ModelSelection | null,
  info: AgentModelInfo | null,
): string {
  return info?.name ?? selection?.modelId ?? "No model";
}
