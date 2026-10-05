import {
  isQuestionRequest,
  isRecord,
  type AnswerQuestionResponse,
  type AssistantPart,
  type QuestionPart,
} from "@hyperframes/agent-protocol";

/**
 * A message part that is a well-formed question card. The card reads `options` and looks `state` up as a key, so a
 * question the runtime worded differently (a newer runtime, a damaged log) is dropped instead of crashing the chat.
 */
export function isQuestionPart(part: AssistantPart): part is QuestionPart {
  return part.type === "question" && isQuestionRequest(part.question);
}

export function isAnswerQuestionResponse(value: unknown): value is AnswerQuestionResponse {
  return isRecord(value) && isQuestionRequest(value.question);
}
