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
import { projectAttachment } from "./composerAttachments";
import { NEW_CHAT_DRAFT, type DraftChoices } from "./agentDraftChat";
import { i18n, t } from "../i18n";
import { describeAgentError } from "./agentErrors";
import { findModel, runningTurn } from "./agentSelectors";
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
  /** The chat's intent (Edit / Ask) for its next turns; persisted on the chat. */
  setIntent(intent: ChatIntent): Promise<ActionResult>;
  /**
   * "Carry out the plan": starts the turn that executes the approved proposal of this chat. The visible prompt is
   * the localized "Carry out the plan"; the runtime attaches the approved steps itself.
   */
  startPlanExecution(turnId: string): Promise<ActionResult>;
  /**
   * A project started from the Projects page chat: a new chat with the intake's model, thinking, agents and
   * intent, opened, and its first turn started with the prompt and the imported files as references.
   */
  startFromIntake(intake: AgentIntake, resume?: IntakeResume): Promise<ActionResult>;
}

/**
 * A retry of an intake whose first start was cut short: `chatId` is the chat that start already made, reused instead
 * of making another; `onChatCreated` hands out the id of a chat this start makes, for a retry that might follow.
 */
export interface IntakeResume {
  chatId?: string;
  onChatCreated?: (chatId: string) => void;
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

/**
 * The state that puts an intake back in a composer box: the prompt in front of whatever the box holds by now, the
 * files (already in the project) as chips, and — in the new-chat draft — the intake's model, thinking, agents and
 * intent as the chips' choices, with the user's own picks since staying on top.
 */
function putBackIntake(
  state: Pick<AgentState, "drafts" | "attachments" | "draftChoices">,
  intake: AgentIntake,
  chatId: string | null,
): Pick<AgentState, "drafts" | "attachments" | "draftChoices"> {
  const key = chatId ?? NEW_CHAT_DRAFT;
  const files = intake.files
    .slice(0, LIMITS.references)
    .map((file) => projectAttachment({ path: file.path, sizeBytes: file.size }));
  return {
    drafts: {
      ...state.drafts,
      [key]: [intake.prompt, state.drafts[key] ?? ""]
        .filter((text) => text.trim() !== "")
        .join("\n\n"),
    },
    attachments: {
      ...state.attachments,
      [key]: [...files, ...(state.attachments[key] ?? [])].slice(0, LIMITS.references),
    },
    draftChoices:
      chatId === null
        ? {
            model: intake.model,
            thinking: intake.thinking,
            enabledAgents: intake.agents,
            intent: intake.intent,
            ...(intake.agentOverrides && { agentOverrides: intake.agentOverrides }),
            ...state.draftChoices,
          }
        : state.draftChoices,
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

    async startPlanExecution(turnId) {
      const { chatId, chat, pending } = get();
      if (!chatId || !chat) return { ok: false, message: t("agent.chat.openFirst") };
      if (pending || runningTurn(chat)) return { ok: false, message: t("agent.chat.busyOther") };
      set({ pending: "send", notice: null });
      try {
        await client.startTurn(chatId, {
          prompt: t("chat.plan.executePrompt"),
          executePlan: { turnId },
          userLanguage: i18n.language,
        });
        // The turn arrives on the stream; a stream that is not up yet catches up from the snapshot.
        if (!isDisposed() && get().streamStatus !== "open") await get().openChat(chatId);
        return { ok: true };
      } catch (error) {
        const message = describeAgentError(error);
        if (!isDisposed()) set({ notice: { message } });
        return { ok: false, message };
      } finally {
        if (!isDisposed()) set({ pending: null });
      }
    },

    async startFromIntake(intake, resume = {}) {
      set({ pending: "create", notice: null });
      let chatId: string | null = resume.chatId ?? null;
      try {
        if (chatId === null) {
          const created = await client.createChat({
            model: intake.model,
            thinking: intake.thinking,
          });
          chatId = created.id;
          resume.onChatCreated?.(created.id);
        }
        await client.updateChat(chatId, {
          enabledAgents: intake.agents,
          intent: intake.intent,
          ...(intake.agentOverrides && { agentOverrides: intake.agentOverrides }),
        });
        if (isDisposed()) return { ok: false, message: t("agent.chat.projectClosed") };
        await get().openChat(chatId);
        const request = intakeTurnRequest(intake);
        if (!request) return { ok: true };
        set({ pending: "send" });
        await client.startTurn(chatId, { ...request, userLanguage: i18n.language });
        // The turn arrives on the stream; a stream that is not up yet catches up from the snapshot.
        if (!isDisposed() && get().streamStatus !== "open") await get().openChat(chatId);
        return { ok: true };
      } catch (error) {
        const message = describeAgentError(error);
        if (isDisposed()) return { ok: false, message };
        // Nothing is lost: the prompt and files wait in the box of the chat that was made, or else in the new-chat
        // draft (the intake is already gone from the server, so this is the only copy left).
        set((state) => putBackIntake(state, intake, chatId));
        if (chatId) {
          if (get().chatId !== chatId) await get().openChat(chatId);
        } else if (get().chatId === null) {
          set({ view: "chat" });
        }
        set({ notice: { message } });
        return { ok: false, message };
      } finally {
        if (!isDisposed()) set({ pending: null });
      }
    },
  };
}
