import type { StoreApi } from "zustand/vanilla";
import { LIMITS } from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import type { ComposerAttachment } from "./composerAttachments";
import type { AgentState } from "./agentStore";

/**
 * The files attached to the message being written, per draft (the open chat, or the new-chat draft), like the
 * prompt text in `drafts`. They go out as the message's `references` and are forgotten once the server took it.
 */
export interface AgentAttachmentSlice {
  attachments: Record<string, ComposerAttachment[]>;
  /**
   * Adds attachments to a draft, skipping a file the draft already carries and anything past the reference limit
   * (said in a notice). Returns the ones that were added.
   */
  addAttachments(draftKey: string, items: readonly ComposerAttachment[]): ComposerAttachment[];
  /** A finished or failed upload, or any other change to one chip. */
  patchAttachment(draftKey: string, id: string, patch: Partial<ComposerAttachment>): void;
  removeAttachment(draftKey: string, id: string): void;
}

export interface AgentAttachmentSliceDeps {
  set: StoreApi<AgentState>["setState"];
  get: StoreApi<AgentState>["getState"];
}

export function createAgentAttachmentSlice({
  set,
  get,
}: AgentAttachmentSliceDeps): AgentAttachmentSlice {
  return {
    attachments: {},

    addAttachments(draftKey, items) {
      const current = get().attachments[draftKey] ?? [];
      const added: ComposerAttachment[] = [];
      for (const item of items) {
        const duplicate = [...current, ...added].some(
          (existing) => item.path !== null && existing.path === item.path,
        );
        if (!duplicate && current.length + added.length < LIMITS.references) added.push(item);
      }
      const skipped = items.length - added.length;
      set((state) => ({
        attachments: {
          ...state.attachments,
          [draftKey]: [...(state.attachments[draftKey] ?? []), ...added],
        },
        notice:
          skipped > 0 && current.length + added.length >= LIMITS.references
            ? { message: t("chat.attach.tooMany", { max: LIMITS.references }) }
            : state.notice,
      }));
      return added;
    },

    patchAttachment(draftKey, id, patch) {
      set((state) => ({
        attachments: {
          ...state.attachments,
          [draftKey]: (state.attachments[draftKey] ?? []).map((attachment) =>
            attachment.id === id ? { ...attachment, ...patch } : attachment,
          ),
        },
      }));
    },

    removeAttachment(draftKey, id) {
      set((state) => ({
        attachments: {
          ...state.attachments,
          [draftKey]: (state.attachments[draftKey] ?? []).filter(
            (attachment) => attachment.id !== id,
          ),
        },
      }));
    },
  };
}
