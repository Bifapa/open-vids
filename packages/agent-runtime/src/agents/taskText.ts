import {
  AGENT_DISPLAY_NAMES,
  type AgentId,
  type ChatMessage,
  type EditorContext,
  type MessageReference,
} from "@hyperframes/agent-protocol";
import { renderPromptContext } from "../promptContext.js";

/** How much of the user's own words one task carries: each message, and all of them together. */
const USER_TEXT_CHARS = 4_000;
const USER_TOTAL_CHARS = 10_000;

/** The user's messages of one turn (the prompt and what they steered with), oldest first, with their attachments. */
export function userRequestOf(
  messages: readonly ChatMessage[],
  turnId: string,
): { block: string | null; references: MessageReference[] } {
  const references: MessageReference[] = [];
  const lines: string[] = [];
  let budget = USER_TOTAL_CHARS;
  let omitted = 0;
  for (const message of messages) {
    if (message.role !== "user" || message.turnId !== turnId) continue;
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
      .filter(Boolean)
      .join("\n");
    for (const part of message.parts) {
      if (part.type === "reference") references.push(part.reference);
    }
    if (!text) continue;
    const shown = text.slice(0, Math.min(USER_TEXT_CHARS, budget));
    omitted += text.length - shown.length;
    budget -= shown.length;
    lines.push(`${message.steering ? "- (sent while working)" : "- (request)"} ${shown}`);
  }
  if (lines.length === 0) return { block: null, references };
  const cut =
    omitted > 0 ? `\n[${omitted} more characters of the user's messages were left out here]` : "";
  return {
    block: `<user-request>\nThe user's own words this turn, for context. Your task is the one above; do not widen it.\n${lines.join("\n")}${cut}\n</user-request>`,
    references,
  };
}

/**
 * What a specialist is handed to start a task: the Director's task, the user's own words and attachments of the turn,
 * the part of the editor context that matters to it and the reply language. The Director carries the full editor
 * context once; a specialist gets the selection in words and the light JSON.
 */
export function renderSpecialistTask(input: {
  title: string;
  from: AgentId;
  task: string;
  messages: readonly ChatMessage[];
  turnId: string;
  editorContext?: EditorContext;
  userLanguage?: string;
}): string {
  const { block, references } = userRequestOf(input.messages, input.turnId);
  const task = `<task title=${JSON.stringify(input.title)} from=${JSON.stringify(AGENT_DISPLAY_NAMES[input.from])}>\n${input.task}\n</task>`;
  return renderPromptContext(
    block ? `${task}\n\n${block}` : task,
    input.editorContext,
    references,
    input.userLanguage,
    { editorJson: "relevant" },
  );
}

/** Corrections the Director sent before the run began, placed in front of its task. */
export function withQueuedMessages(taskText: string, queued: readonly string[]): string {
  if (queued.length === 0) return taskText;
  const lines = queued.map((message) => `- ${message}`).join("\n");
  return `<corrections>\nThe Director sent these after the task below was written and before you began; they take precedence over it.\n${lines}\n</corrections>\n\n${taskText}`;
}
