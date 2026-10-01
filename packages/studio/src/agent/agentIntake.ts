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
 * At project open, once the agent is ready: claims the start-from-chat intake (the server hands it out once, so a
 * reload never runs it again) and starts its chat. A store that was disposed or found the agent unavailable
 * leaves the intake in place for the next open.
 */
export async function consumeIntake(
  store: AgentStore,
  client: AgentClient,
  reveal: () => void = revealIntakeChat,
): Promise<void> {
  if (store.getState().availability !== "ready") return;
  let intake: AgentIntake | null;
  try {
    intake = await client.claimIntake();
  } catch {
    // A broken or unreadable intake must not keep the project from opening.
    return;
  }
  if (!intake || store.getState().availability !== "ready") return;
  reveal();
  await store.getState().startFromIntake(intake);
}
