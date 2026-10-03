import {
  STORY_OFFER_STATES,
  isRecord,
  type AnswerStoryOfferResponse,
  type AssistantPart,
  type StoryOffer,
  type StoryOfferChapter,
  type StoryOfferPart,
  type StoryOfferState,
} from "@hyperframes/agent-protocol";

function isOfferState(value: unknown): value is StoryOfferState {
  return typeof value === "string" && STORY_OFFER_STATES.some((state) => state === value);
}

function isChapter(value: unknown): value is StoryOfferChapter {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    (value.summary === undefined || typeof value.summary === "string") &&
    (value.material === undefined || typeof value.material === "string") &&
    (value.durationSeconds === undefined ||
      (typeof value.durationSeconds === "number" && Number.isFinite(value.durationSeconds)))
  );
}

/**
 * A Story offer as the card reads it. The card walks `chapters` and looks `state` up as a key, so an offer the
 * runtime worded differently (a newer runtime, a damaged log) is dropped instead of crashing the chat.
 */
export function isStoryOffer(value: unknown): value is StoryOffer {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isOfferState(value.state) &&
    typeof value.requestedAt === "number" &&
    Array.isArray(value.chapters) &&
    value.chapters.every(isChapter)
  );
}

/** A message part that is a well-formed Story offer card. */
export function isStoryOfferPart(part: AssistantPart): part is StoryOfferPart {
  return part.type === "story-offer" && isStoryOffer(part.offer);
}

export function isAnswerStoryOfferResponse(value: unknown): value is AnswerStoryOfferResponse {
  return isRecord(value) && isStoryOffer(value.offer);
}
