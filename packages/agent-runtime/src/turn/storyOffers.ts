import {
  isChapter,
  type AnswerStoryOfferResponse,
  type ChatState,
  type StoryOffer,
  type StoryOfferDecision,
  type StoryOfferPart,
} from "@hyperframes/agent-protocol";
import { RuntimeError, errorMessage } from "../errors.js";
import { StoryToolError } from "../story/host.js";
import { storyOfferOperations } from "../storyOffer.js";
import { busyError, type TurnContext } from "./context.js";

/** Where a turn's Story Mode offer card lives and what it says; unknown turns and offers are refused. */
function storyOfferTarget(
  state: ChatState,
  turnId: string,
  offerId: string,
): { messageId: string; offer: StoryOffer } {
  const turn = state.turns.find((entry) => entry.id === turnId);
  if (!turn) throw new RuntimeError("turn_not_found", "Turn was not found", 404);
  const message = state.messages.find((entry) => entry.id === turn.assistantMessageId);
  if (message?.role !== "assistant")
    throw new RuntimeError("invalid_request", "This turn has no such Story Mode offer", 400);
  const part = message.parts.find(
    (entry): entry is StoryOfferPart => entry.type === "story-offer" && entry.id === offerId,
  );
  if (!part)
    throw new RuntimeError("invalid_request", "This turn has no such Story Mode offer", 400);
  return { messageId: message.id, offer: part.offer };
}

/** A story failure of the offer write, as the runtime answers it: a graph that moved on is a conflict. */
function storyOfferFailure(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) return error;
  if (error instanceof StoryToolError) {
    if (error.code === "conflict")
      return new RuntimeError(
        "story_offer_conflict",
        "The story changed while the offer was waiting, so it cannot be applied.",
        409,
      );
    if (error.code === "unavailable" || error.code === "aborted")
      return new RuntimeError(
        "runtime_unavailable",
        errorMessage(error, "The story service could not be reached"),
        503,
      );
    return new RuntimeError("story_offer_conflict", error.message, 409);
  }
  return new RuntimeError(
    "runtime_unavailable",
    errorMessage(error, "The story service could not be reached"),
    503,
  );
}

/**
 * The user's answer to a Story Mode offer card. Unlike a permission, the offer stays answerable after its own turn
 * ended, so it is read from the chat and only a turn running right now is refused. `accept` writes the chapters
 * into the Story Graph through the story service (no model) and marks the offer accepted — refused when the graph
 * changed meanwhile or already has chapters; `decline` records the decline on the chat, so it is never offered
 * there again, and marks the offer declined.
 */
export async function answerStoryOffer(
  ctx: TurnContext,
  chatId: string,
  turnId: string,
  offerId: string,
  decision: StoryOfferDecision,
  signal?: AbortSignal,
): Promise<AnswerStoryOfferResponse> {
  const state = ctx.chats.get(chatId);
  if (!state) throw new RuntimeError("chat_not_found", "Chat was not found", 404);
  const found = storyOfferTarget(state, turnId, offerId);
  if (found.offer.state !== "pending")
    throw new RuntimeError("turn_not_active", "This Story Mode offer was already answered", 409);
  const busy = busyError(ctx, chatId);
  if (busy) throw busy;
  if (decision === "decline") {
    await ctx.chats.setStoryDeclined(chatId);
    const declined: StoryOffer = { ...found.offer, state: "declined", answeredAt: ctx.now() };
    await ctx.chats.emit(chatId, {
      type: "storyOffer.updated",
      messageId: found.messageId,
      offer: declined,
    });
    return { offer: declined };
  }
  const storyFactory = ctx.options.story;
  if (!storyFactory)
    throw new RuntimeError("invalid_request", "Story Mode is not available in this runtime", 400);
  const host = storyFactory(ctx.chats.scope);
  const callSignal = signal ?? new AbortController().signal;
  let accepted: StoryOffer;
  try {
    const view = await host.view(callSignal);
    if (view.graph?.nodes.some(isChapter))
      throw new RuntimeError(
        "story_offer_conflict",
        "The story gained chapters while the offer was waiting, so it cannot be applied.",
        409,
      );
    await host.edit(
      {
        ...(view.version !== null && { baseVersion: view.version }),
        operations: storyOfferOperations(found.offer.chapters),
      },
      callSignal,
    );
    accepted = { ...found.offer, state: "accepted", answeredAt: ctx.now() };
  } catch (error) {
    throw storyOfferFailure(error);
  }
  await ctx.chats.emit(chatId, {
    type: "storyOffer.updated",
    messageId: found.messageId,
    offer: accepted,
  });
  return { offer: accepted };
}

/**
 * Expires every pending Story Mode offer of a chat that has no running turn. Called when a new user turn starts:
 * that is what makes a pending offer unanswerable, while the end of its own turn leaves it pending.
 */
export async function expireStoryOffers(ctx: TurnContext, chatId: string): Promise<void> {
  const state = ctx.chats.get(chatId);
  if (!state) return;
  for (const message of state.messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "story-offer" || part.offer.state !== "pending") continue;
      const expired: StoryOffer = { ...part.offer, state: "expired", answeredAt: ctx.now() };
      await ctx.chats
        .emit(chatId, { type: "storyOffer.updated", messageId: message.id, offer: expired })
        .catch(() => undefined);
    }
  }
}
