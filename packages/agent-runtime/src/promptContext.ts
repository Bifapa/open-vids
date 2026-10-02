import type { EditorContext, MessageReference } from "@hyperframes/agent-protocol";

/**
 * The block that makes an agent answer in the user's UI language. System prompts stay English; this one
 * sentence rides with every prompt the user's language applies to. English (or an unknown tag) adds nothing,
 * so an English UI produces the exact prompt it always did.
 */
export function renderUserLanguageBlock(userLanguage: string | undefined): string | null {
  if (!userLanguage) return null;
  const base = userLanguage.split("-")[0]?.toLowerCase();
  if (!base || base === "en") return null;
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames(["en"], { type: "language" }).of(userLanguage);
  } catch {
    name = undefined;
  }
  // An unknown tag echoes back as itself (`zz (ZZZZ)`): no instruction then, rather than a nonsense sentence.
  // An unknown tag echoes back as itself (`zz`, `zz (Unknown Script)`): no instruction then.
  if (
    !name ||
    name.toLowerCase().startsWith(base + " ") ||
    name.toLowerCase() === base ||
    /unknown/i.test(name)
  )
    return null;
  return `<user-language>${userLanguage}</user-language>\nThe user reads the interface in ${name}. Reply to the user in ${name}; keep tool calls, file contents, code and identifiers unchanged.`;
}

/**
 * The block that says the frame format is still open (the project started with "Auto") and how to settle it before
 * building. It rides on the Director's first prompt; once the Director sets the canvas, the timeline it builds and
 * every specialist task it delegates already belong to that format.
 */
export function renderCanvasAutoBlock(): string {
  return `<canvas-auto>
The user started this project with the frame format on Auto: the composition's current size is only a placeholder, not a decision. Decide the format before you build the timeline and set it with edit_timeline {op: "set_canvas", width, height} (even pixels) before adding clips, then build for that format.
Read it from the brief (Reels, TikTok, Shorts or Stories → 9:16; YouTube, a presentation or TV → 16:9; an Instagram feed post → 1:1 or 4:5) and from the material (inspect the imported footage with inspect_project: mostly vertical clips → 9:16, mostly widescreen → 16:9, a portrait photo series → 4:5). When nothing indicates otherwise use 16:9.
Say in your reply which format you chose and why.
</canvas-auto>`;
}

/**
 * The plan/intake variant: nothing is built in this turn, but the choice cannot be deferred past the build, so the
 * plan states it. The flag stays on the chat until an edit actually sets the canvas.
 */
export function renderCanvasAutoPlanBlock(): string {
  return `<canvas-auto>
The user started this project with the frame format on Auto and it is still to be decided: the composition's current size is only a placeholder. Decide now which format the video should have and state it in your plan or reply — a later edit turn sets it with edit_timeline {op: "set_canvas", width, height} (even pixels) before any clip is added, and everything you plan (framing, text placement, overlays) must assume that format.
Read it from the brief (Reels, TikTok, Shorts or Stories → 9:16; YouTube, a presentation or TV → 16:9; an Instagram feed post → 1:1 or 4:5) and from the material (inspect the imported footage with inspect_project: mostly vertical clips → 9:16, mostly widescreen → 16:9, a portrait photo series → 4:5). When nothing indicates otherwise use 16:9.
</canvas-auto>`;
}

/** Adds Studio-captured editor context, typed references and the user's language to the text received by a backend. */
export function renderPromptContext(
  prompt: string,
  editorContext?: EditorContext,
  references: readonly MessageReference[] = [],
  userLanguage?: string,
): string {
  const blocks = [prompt];
  if (editorContext) {
    blocks.push(`<editor-context>\n${JSON.stringify(editorContext, null, 2)}\n</editor-context>`);
  }
  if (references.length > 0) {
    const rendered = references.map((reference) => JSON.stringify(reference)).join("\n");
    blocks.push(`<references>\n${rendered}\n</references>`);
  }
  const language = renderUserLanguageBlock(userLanguage);
  if (language) blocks.push(language);
  return blocks.join("\n\n");
}
