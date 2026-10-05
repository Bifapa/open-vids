import type { AgentIntake } from "@hyperframes/agent-protocol";
import type { AgentClient } from "./agentClient";
import type { AgentStore } from "./agentStore";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { showMediaChat } from "../media/mediaWorkspaceStore";

/** Where a project started from the Projects page chat lands: the Media workspace, its Chat column. */
export function revealIntakeChat(): void {
  useDockLayoutStore.getState().activatePanel("media");
  showMediaChat();
}

/**
 * Intakes the server handed out whose store went away before it could start them, by project. The server gives an
 * intake out once, so the next store of the same project starts it instead of finding nothing. `chatId` is the chat a
 * cut-short start already made: the retry reuses it rather than leaving an empty chat behind.
 */
const stranded = new Map<string, { intake: AgentIntake; chatId?: string }>();

export interface ConsumeIntakeOptions {
  projectId: string;
  /** True once the store's project view is gone (the project was closed or switched). */
  isCancelled?: () => boolean;
  reveal?: () => void;
}

/**
 * At project open, once the agent is ready: claims the start-from-chat intake (the server hands it out once, so a
 * reload never runs it again) and starts its chat. An agent that is not ready leaves the intake in place for the
 * next open. Once claimed, the intake is never dropped: it is started, or — when the start fails — put back in the
 * composer by the store, or — when the store went away — kept for the project's next store.
 */
export async function consumeIntake(
  store: AgentStore,
  client: AgentClient,
  { projectId, isCancelled = () => false, reveal = revealIntakeChat }: ConsumeIntakeOptions,
): Promise<void> {
  if (store.getState().availability !== "ready") return;
  const resumed = stranded.get(projectId) ?? null;
  stranded.delete(projectId);
  let intake = resumed?.intake ?? null;
  let chatId = resumed?.chatId;
  if (!intake) {
    try {
      intake = await client.claimIntake();
    } catch {
      // A broken or unreadable intake must not keep the project from opening.
      return;
    }
  }
  if (!intake) return;
  if (isCancelled()) {
    stranded.set(projectId, { intake, ...(chatId && { chatId }) });
    return;
  }
  // The store keeps the intake in the new-chat draft if any step of the start fails.
  const started = store.getState().startFromIntake(intake, {
    ...(chatId && { chatId }),
    onChatCreated: (id) => {
      chatId = id;
    },
  });
  reveal();
  const result = await started;
  if (!result.ok && isCancelled()) {
    stranded.set(projectId, { intake, ...(chatId && { chatId }) });
  }
}
