import { isDesignSystemId, type ChatState, type TurnSummary } from "@hyperframes/agent-protocol";

/** The activity the runtime reports for a `save_design_system` call (`labelParams`: `id`, `name`). */
const SAVE_ACTIVITY_CODE = "saving_design_system";

export interface SavedDesign {
  id: string;
  name: string;
}

/**
 * The library systems a turn saved: one entry per `save_design_system` call that succeeded (its activity is `done`),
 * in the order they happened. In an edit turn the runtime forces the system the user chose, so that id wins over
 * whatever the model passed.
 */
export function savedDesignsOfTurn(chat: ChatState, turn: TurnSummary): SavedDesign[] {
  const editedId = turn.designAction === "edit" ? turn.designOptions?.systemId : undefined;
  const saved: SavedDesign[] = [];
  for (const message of chat.messages) {
    if (message.role !== "assistant" || message.turnId !== turn.id) continue;
    for (const part of message.parts) {
      if (part.type !== "activity") continue;
      const { labelCode, labelParams, status } = part.activity;
      if (labelCode !== SAVE_ACTIVITY_CODE || status !== "done") continue;
      const named = labelParams?.id;
      const id = editedId ?? (isDesignSystemId(named) ? named : null);
      if (!id) continue;
      const name = labelParams?.name;
      const entry = { id, name: typeof name === "string" && name.length > 0 ? name : id };
      const known = saved.findIndex((candidate) => candidate.id === id);
      if (known >= 0) saved[known] = entry;
      else saved.push(entry);
    }
  }
  return saved;
}
