import type { ComposerAttachment } from "./composerAttachments";
import type { AgentState } from "./agentStore";

/** What a message took out of a composer draft: the box's text and the chips that were there at Send. */
export interface SentDraft {
  text: string;
  attachments: readonly ComposerAttachment[];
}

/**
 * What stays in a draft once `sent` went out. The box stays editable while the server answers, so the user may
 * have typed on after Send: that text, and any chip added since, is theirs and survives. A draft that was edited
 * inside the sent text is left whole — nothing is guessed about what part of it went out.
 */
export function unsentOf(
  state: Pick<AgentState, "drafts" | "attachments">,
  draftKey: string,
  sent: SentDraft,
): { text: string; attachments: ComposerAttachment[] } {
  const current = state.drafts[draftKey] ?? "";
  const typedAfter = current.startsWith(sent.text)
    ? current.slice(sent.text.length).trimStart()
    : current;
  const sentIds = new Set(sent.attachments.map((attachment) => attachment.id));
  return {
    text: typedAfter,
    attachments: (state.attachments[draftKey] ?? []).filter(
      (attachment) => !sentIds.has(attachment.id),
    ),
  };
}
