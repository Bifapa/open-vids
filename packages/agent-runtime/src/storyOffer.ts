import {
  STORY_LIMITS,
  type StoryOfferChapter,
  type StoryOperation,
} from "@hyperframes/agent-protocol";

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
    "When a part needs music, sound effects or footage the user named, write them in that chapter's material in the user's words, one short phrase each (for example «спокойная музыка; звук запуска ракеты; кадры города ночью»): accepting the offer turns each into a Missing Asset node attached to the chapter, which Build later fills.",
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

interface MaterialNeed {
  mediaKind: "music" | "sfx" | "video";
  need: string;
  title: string;
}

/** What the user's words call a sound effect, music, or footage (English and Russian; `\b` is ASCII-only, so words start after a non-letter). */
const SFX_WORDS =
  /(?<![\p{L}\p{N}_])(?:sfx|sound\s?fx|sound effects?|whoosh|swoosh|applause|explosions?|звуков\p{L}*\s+эффект\p{L}*|эффект\p{L}*\s+звук\p{L}*|звук\p{L}*|шум\p{L}*|аплодисмент\p{L}*|взрыв\p{L}*)/iu;
const MUSIC_WORDS =
  /(?<![\p{L}\p{N}_])(?:music|soundtrack|songs?|bgm|background track|музык\p{L}*|мелоди\p{L}*|саундтрек\p{L}*|песн\p{L}*|трек\p{L}*)/iu;
const FOOTAGE_WORDS =
  /(?<![\p{L}\p{N}_])(?:footage|b-?roll|stock (?:video|clips?)|video clips?|clips? of|съ[её]мк\p{L}*|футаж\p{L}*|видеоряд\p{L}*|кадры)/iu;

/** The most material needs one chapter yields: the offer's card stays about the story, not a shopping list. */
const NEEDS_PER_CHAPTER = 3;
/** A clause this short names the kind only ("music"): the chapter gives it its subject. */
const BARE_CLAUSE_CHARS = 14;

/**
 * The material a chapter's own words clearly name: music, sound effects and footage. The text is split into clauses
 * (`;`, line breaks, commas, "and"/"и"); a clause that names one of the kinds becomes a need, anything else (a
 * picture, a graphic, a sentence about the chapter) stays only in the chapter's B-roll text.
 */
function materialNeeds(chapter: StoryOfferChapter): MaterialNeed[] {
  if (!chapter.material) return [];
  const seen = new Set<string>();
  const needs: MaterialNeed[] = [];
  for (const raw of chapter.material.split(/[;\n]+|,\s+|\s+(?:and|plus|и|а также)\s+/iu)) {
    const clause = raw.replace(/\s+/g, " ").trim();
    if (clause.length === 0) continue;
    const mediaKind = SFX_WORDS.test(clause)
      ? "sfx"
      : MUSIC_WORDS.test(clause)
        ? "music"
        : FOOTAGE_WORDS.test(clause)
          ? "video"
          : null;
    if (mediaKind === null) continue;
    const bare = clause.length <= BARE_CLAUSE_CHARS;
    const need = bare ? `${clause} (${chapter.title})` : clause;
    const key = `${mediaKind}:${need.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const named = bare ? `${clause} · ${chapter.title}` : clause;
    const title = named.length > 60 ? `${named.slice(0, 59)}…` : named;
    needs.push({ mediaKind, need, title: title.charAt(0).toUpperCase() + title.slice(1) });
    if (needs.length === NEEDS_PER_CHAPTER) break;
  }
  return needs;
}

const PLACEMENT = { music: "throughout", sfx: "start", video: "middle" } as const;

/**
 * The batch that turns an accepted offer into the first chapters of the graph: AI-authored chapter nodes in the
 * user's order, linked by sequence edges, and — for the music, sound effects and footage a chapter's material text
 * clearly names — Missing Asset nodes attached to that chapter (the chapter keeps the full text as its B-roll intent).
 * Positions are the service's (agents never place nodes). The batch stays within the service's operation cap: material
 * nodes are dropped, never chapters.
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
  let missing = 0;
  chapters.forEach((chapter, index) => {
    for (const { mediaKind, need, title } of materialNeeds(chapter)) {
      if (operations.length + 2 > STORY_LIMITS.operations) return;
      missing += 1;
      operations.push(
        {
          op: "add_node",
          ref: `need-${missing}`,
          node: {
            kind: "missing",
            title,
            mediaKind,
            need,
            ...(mediaKind === "music" && chapter.durationSeconds !== undefined
              ? { neededDuration: chapter.durationSeconds }
              : {}),
          },
        },
        {
          op: "attach",
          node: `@need-${missing}`,
          chapter: `@chapter-${index + 1}`,
          placement: PLACEMENT[mediaKind],
        },
      );
    }
  });
  return operations;
}
