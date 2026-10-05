import type {
  ChatState,
  MessageReference,
  StartTurnRequest,
  TurnSummary,
} from "@hyperframes/agent-protocol";

/** The prompt of a turn and the files it carried, as the user sent them. */
interface SentPrompt {
  text: string;
  references: MessageReference[];
}

function sentPrompt(chat: ChatState, turn: TurnSummary): SentPrompt | null {
  const message = chat.messages.find((candidate) => candidate.id === turn.promptMessageId);
  if (message?.role !== "user") return null;
  const texts: string[] = [];
  const references: MessageReference[] = [];
  for (const part of message.parts) {
    if (part.type === "text") texts.push(part.text);
    else references.push(part.reference);
  }
  const text = texts.join("\n\n").trim();
  return text ? { text, references } : null;
}

/**
 * The plan proposal a turn carried out: the one the runtime recorded on the turn. A turn without the record never
 * counts as an execution, whatever its prompt says; a record naming a turn that is not a proposal here is no match.
 */
export function carriedOutProposal(chat: ChatState, turn: TurnSummary): TurnSummary | null {
  if (turn.executedPlanTurnId === undefined) return null;
  const proposal = chat.turns.find((candidate) => candidate.id === turn.executedPlanTurnId);
  return proposal?.plan?.proposal === true ? proposal : null;
}

/** The proposals of this chat a later turn carried out; the others still wait for the user (or were never acted on). */
export function carriedOutProposalIds(chat: ChatState): Set<string> {
  const ids = new Set<string>();
  for (const turn of chat.turns) {
    const proposal = carriedOutProposal(chat, turn);
    if (proposal) ids.add(proposal.id);
  }
  return ids;
}

/**
 * The request that runs a failed turn again: its prompt and files, in the mode and intent it had, carrying out the
 * same plan or Story action when that is what it was. Null when the prompt is not in the chat any more, or when the
 * turn carried out a plan whose proposal is gone (it would run as a plain message).
 */
export function retryTurnRequest(chat: ChatState, turn: TurnSummary): StartTurnRequest | null {
  const prompt = sentPrompt(chat, turn);
  if (!prompt) return null;
  const proposal = carriedOutProposal(chat, turn);
  if (turn.executedPlanTurnId !== undefined && !proposal) return null;
  return {
    prompt: prompt.text,
    ...(prompt.references.length > 0 && { references: prompt.references }),
    ...(turn.mode && { mode: turn.mode }),
    ...(turn.intent && !proposal && !turn.storyAction && { intent: turn.intent }),
    ...(proposal && { executePlan: { turnId: proposal.id } }),
    ...(turn.storyAction && { storyAction: turn.storyAction }),
    ...(turn.storyAction && turn.storyOptions && { storyOptions: turn.storyOptions }),
  };
}
