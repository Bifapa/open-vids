import type { StoreApi } from "zustand/vanilla";
import {
  LIMITS,
  isThinkingEffort,
  type AgentIntake,
  type AgentIntakeFile,
  type ChatIntent,
  type MessageReference,
  type ModelSelection,
  type StartTurnRequest,
  type ThinkingEffort,
  type UpdateChatRequest,
} from "@hyperframes/agent-protocol";
import type { AgentClient } from "./agentClient";
import type { DraftChoices } from "./agentDraftChat";
import { i18n, t } from "../i18n";
import { describeAgentError } from "./agentErrors";
import { findModel } from "./agentSelectors";
import type { ActionResult } from "./agentSettingsSlice";
import type { AgentState } from "./agentStore";

/**
 * What the composer adds to the store: Main's model and effort, the Mode chip, the new-chat draft's choices and the
 * start-from-chat intake. Every chip edit goes to the open chat, or to `draftChoices` in the new-chat draft.
 */
export interface AgentComposerSlice {
  /** The chips' choices while the new-chat draft has no chat yet; its first message creates the chat with them. */
  draftChoices: DraftChoices;
  setModel(model: ModelSelection | null): Promise<void>;
  setThinking(thinking: ThinkingEffort | null): Promise<void>;
  /** The chat's intent (Plan / Edit / Ask) for its next turns; persisted on the chat. */
  setIntent(intent: ChatIntent): Promise<ActionResult>;
  /**
   * A project started from the Projects page chat: a new chat with the intake's model, thinking, agents and
   * intent, opened, and its first turn started with the prompt and the imported files as references.
   */
  startFromIntake(intake: AgentIntake): Promise<ActionResult>;
}

export interface AgentComposerSliceDeps {
  client: AgentClient;
  set: StoreApi<AgentState>["setState"];
  get: StoreApi<AgentState>["getState"];
  isDisposed: () => boolean;
  updateOpenChat: (request: UpdateChatRequest) => Promise<ActionResult>;
}

/** Said when the intake carries files but no words: the files are the brief. */
const FILES_ONLY_PROMPT = "Start this project from the imported files.";

function intakeReference(file: AgentIntakeFile, index: number): MessageReference {
  const id = `intake-${index + 1}`;
  if (file.kind === "video" || file.kind === "audio" || file.kind === "image") {
    return {
      kind: file.kind,
      id,
      label: file.name,
      source: { type: "project-path", path: file.path },
    };
  }
  return { kind: "asset", id, label: file.name, path: file.path };
}

/** The first turn of an intake, or null when it has neither a prompt nor files (just the chat then). */
export function intakeTurnRequest(intake: AgentIntake): StartTurnRequest | null {
  const prompt = intake.prompt.trim() || (intake.files.length > 0 ? FILES_ONLY_PROMPT : "");
  if (!prompt) return null;
  const references = intake.files.slice(0, LIMITS.references).map(intakeReference);
  return {
    prompt,
    ...(references.length > 0 && { references }),
    intent: intake.intent,
    mode: "normal",
    ...(intake.format === "auto" && { canvas: "auto" }),
  };
}

export function createAgentComposerSlice({
  client,
  set,
  get,
  isDisposed,
  updateOpenChat,
}: AgentComposerSliceDeps): AgentComposerSlice {
  /** The model and effort controls show a failed edit inline in the composer. */
  const report = (result: ActionResult) => {
    if (!result.ok && !isDisposed()) set({ notice: { message: result.message } });
  };

  return {
    draftChoices: {},

    async setModel(model) {
      const { chatId, chat, models, draftChoices } = get();
      if (chatId && !chat) return;
      // A model that cannot take the current effort resets it to the default.
      const effort = chat ? chat.chat.thinking : (draftChoices.thinking ?? null);
      const info = findModel(models, model);
      const dropEffort = info && effort && effort !== "off" && !info.efforts.includes(effort);
      report(await updateOpenChat({ model, ...(dropEffort ? { thinking: null } : {}) }));
    },

    async setThinking(thinking) {
      if (thinking !== null && !isThinkingEffort(thinking)) return;
      report(await updateOpenChat({ thinking }));
    },

    async setIntent(intent) {
      const chat = get().chat;
      if (chat && (chat.chat.intent ?? "edit") === intent) return { ok: true };
      return updateOpenChat({ intent });
    },

    async startFromIntake(intake) {
      set({ pending: "create", notice: null });
      let chatId: string | null = null;
      try {
        const created = await client.createChat({ model: intake.model, thinking: intake.thinking });
        chatId = created.id;
        await client.updateChat(created.id, {
          enabledAgents: intake.agents,
          intent: intake.intent,
          ...(intake.agentOverrides && { agentOverrides: intake.agentOverrides }),
        });
        if (isDisposed()) return { ok: false, message: t("agent.chat.projectClosed") };
        await get().openChat(created.id);
        const request = intakeTurnRequest(intake);
        if (!request) return { ok: true };
        set({ pending: "send" });
        await client.startTurn(created.id, { ...request, userLanguage: i18n.language });
        // The turn arrives on the stream; a stream that is not up yet catches up from the snapshot.
        if (!isDisposed() && get().streamStatus !== "open") await get().openChat(created.id);
        return { ok: true };
      } catch (error) {
        const message = describeAgentError(error);
        if (isDisposed()) return { ok: false, message };
        // Nothing is lost: the prompt waits in the box of the chat that was made, if any.
        if (chatId) {
          const id = chatId;
          set((state) => ({ drafts: { ...state.drafts, [id]: intake.prompt } }));
          if (get().chatId !== id) await get().openChat(id);
        }
        set({ notice: { message } });
        return { ok: false, message };
      } finally {
        if (!isDisposed()) set({ pending: null });
      }
    },
  };
}
