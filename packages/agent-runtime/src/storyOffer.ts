import type { StoryOfferChapter, StoryOperation } from "@hyperframes/agent-protocol";

/**
 * The blocks and the deterministic graph write of the Story Mode offer (the Director's `offer_story_mode` tool and
 * the card it puts in the chat). The offer itself is an ordinary Edit turn's proposal: no model runs on the answer,
 * and an accepted offer becomes the chapters of the Story Graph exactly as the user described them.
 */

/** The block of an Edit turn whose Director may offer Story Mode (the offer tool and the block go together). */
export function renderStoryOfferBlock(): string {
  return [
    "<story-offer>",
    "The user may be describing the video itself as an ordered structure of content parts. When their request IS such a structure — three or more scenes, sections or chapters, «сначала … потом … затем …», a numbered list of the video's parts — call offer_story_mode instead of building anything and instead of propose_plan: it puts the chapters you name in front of the user, with a button that opens the Story workspace and one that declines. This takes precedence over the plan-approval rules.",
    "Take the chapters from the user's own words, in their own order, 3 to 12 of them. A list of editing operations is NOT a story (cut the pauses, then add captions, then grade the colour — do those directly, or propose a plan when the plan-approval rules ask for one).",
    "offer_story_mode publishes a card in the chat and every project-changing tool is refused for the rest of this turn. After calling it, write one or two sentences about what Story Mode would do with these chapters (in the user's language) and end the turn. Never call it together with propose_plan, and never twice in a turn.",
    "</story-offer>",
  ].join("\n");
}

/**
 * The block that tells the Director the user declined Story Mode in this chat (the flag is durable): the offer is
 * never made again, and the short message that follows a decline is the interface's — the request to carry out is
 * the one before it.
 */
export function renderStoryDeclinedBlock(): string {
  return [
    "<story-declined>",
    "The user declined Story Mode for this chat, so it is never offered here again: edit the video directly and do not mention the offer.",
    "When the message you are answering is the decline itself (written by the interface, not typed by the user), carry out the request they made just before it, in their own words and order.",
    "</story-declined>",
  ].join("\n");
}

/**
 * The batch that turns an accepted offer into the first chapters of the graph: AI-authored chapter nodes in the
 * user's order, linked by sequence edges. Positions are the service's (agents never place nodes).
 */
export function storyOfferOperations(chapters: readonly StoryOfferChapter[]): StoryOperation[] {
  const operations: StoryOperation[] = chapters.map((chapter, index) => ({
    op: "add_node",
    ref: `chapter-${index + 1}`,
    node: {
      kind: "chapter",
      title: chapter.title,
      ...(chapter.summary ? { description: chapter.summary } : {}),
      ...(chapter.durationSeconds !== undefined
        ? { estimatedDuration: chapter.durationSeconds }
        : {}),
      ...(chapter.material ? { bRoll: chapter.material } : {}),
    },
  }));
  for (let index = 1; index < chapters.length; index += 1) {
    operations.push({
      op: "connect",
      from: `@chapter-${index}`,
      to: `@chapter-${index + 1}`,
    });
  }
  return operations;
}
