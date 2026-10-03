import type { StoreApi } from "zustand/vanilla";
import type { StoryOffer, StoryOfferDecision } from "@hyperframes/agent-protocol";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { i18n, t } from "../i18n";
import { studioStoryStore } from "../story/storyContext";
import { AgentApiError, type AgentClient } from "./agentClient";
import { describeAgentError, describeAgentFailure } from "./agentErrors";
import type { AgentState } from "./agentStore";

/** How the user's answer to a Story offer card ended: the offer as the runtime now has it, or why it failed. */
export type StoryOfferAnswer =
  | { ok: true; offer: StoryOffer }
  | {
      ok: false;
      message: string;
      /** The graph gained chapters while the offer waited: the chapters cannot be applied, Story can be opened. */
      conflict: boolean;
    };

/** The Story offer cards of the open chat. */
export interface AgentStoryOfferSlice {
  /**
   * Answers a pending Story offer of a turn. The chat stream carries the updated part (the source of truth); the
   * answer returned here only ends the card's busy state. Accepting also brings the user into the Story workspace
   * with the new chapters loaded and, when the project has media, starts the Review turn; declining sends the
   * "edit right away" message that makes the Director carry out the request. Never rejects.
   */
  answerStoryOffer(
    turnId: string,
    offerId: string,
    decision: StoryOfferDecision,
  ): Promise<StoryOfferAnswer>;
  /** Opens the Story workspace on the story as it is now (the offer's chapters are already there). */
  openStoryWorkspace(): Promise<void>;
}

export interface AgentStoryOfferSliceDeps {
  client: AgentClient;
  set: StoreApi<AgentState>["setState"];
  get: StoreApi<AgentState>["getState"];
  isDisposed: () => boolean;
  /** The project has pictures, video or audio a Review could look at. Read when an offer is accepted. */
  projectHasMedia: () => boolean;
}

export function createAgentStoryOfferSlice({
  client,
  set,
  get,
  isDisposed,
  projectHasMedia,
}: AgentStoryOfferSliceDeps): AgentStoryOfferSlice {
  const openStoryWorkspace = async () => {
    useDockLayoutStore.getState().setWorkspace("story");
    await studioStoryStore.getState().reload();
  };

  /** The message that follows a decline: the Director carries out the request made just before it. */
  const sendDeclineMessage = async (chatId: string) => {
    set({ pending: "send", notice: null });
    try {
      await client.startTurn(chatId, {
        prompt: t("chat.storyOffer.declinePrompt"),
        userLanguage: i18n.language,
      });
      // The turn arrives on the stream; a stream that is not up yet catches up from the snapshot.
      if (!isDisposed() && get().streamStatus !== "open") await get().openChat(chatId);
    } catch (error) {
      if (!isDisposed()) set({ notice: { message: describeAgentError(error) } });
    } finally {
      if (!isDisposed()) set({ pending: null });
    }
  };

  return {
    openStoryWorkspace,

    async answerStoryOffer(turnId, offerId, decision) {
      const chatId = get().chatId;
      if (!chatId) return { ok: false, message: describeAgentFailure("internal"), conflict: false };
      let offer: StoryOffer;
      try {
        ({ offer } = await client.answerStoryOffer(chatId, turnId, offerId, decision));
      } catch (error) {
        return {
          ok: false,
          message: describeAgentError(error),
          conflict: error instanceof AgentApiError && error.code === "story_offer_conflict",
        };
      }
      if (isDisposed()) return { ok: true, offer };
      if (offer.state === "accepted") {
        await openStoryWorkspace();
        if (projectHasMedia()) await get().runStoryAction("review");
      } else if (offer.state === "declined") {
        await sendDeclineMessage(chatId);
      }
      return { ok: true, offer };
    },
  };
}
