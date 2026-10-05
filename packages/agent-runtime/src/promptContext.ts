import type {
  EditorClipSummary,
  EditorContext,
  EditorPreviewElement,
  MessageReference,
} from "@hyperframes/agent-protocol";

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
The user started this project with the frame format on Auto: the composition's current size is only a placeholder, not a decision. Decide the format before you build the timeline and set it with edit_timeline {op: "set_canvas", width, height} (even pixels) before adding clips, then build for that format. When this turn instead proposes a plan (plan approval) and changes nothing, state the chosen format in the proposal; the turn that carries the plan out sets it before any clip is added, and everything you plan (framing, text placement, overlays) must assume that format.
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

const seconds = (value: number): string => String(Math.round(value * 100) / 100);

/** `"Title" (h1, hfId hf-12, selector #title) in compositions/intro.html` — every identifier Studio knew. */
export function describePreviewElement(element: EditorPreviewElement): string {
  const ids = [
    element.tagName,
    element.hfId && `hfId ${element.hfId}`,
    element.domId && `id ${element.domId}`,
    element.selector && `selector ${element.selector}`,
  ].filter((part): part is string => Boolean(part));
  const name = element.label ? `"${element.label}"` : "an element";
  return `${name}${ids.length > 0 ? ` (${ids.join(", ")})` : ""}${element.sourceFile ? ` in ${element.sourceFile}` : ""}`;
}

function describeClip(clip: EditorClipSummary): string {
  const id = clip.hfId ?? clip.domId ?? clip.id;
  const label = clip.label ? ` "${clip.label}"` : "";
  return `${id}${label} (${clip.tag}, ${seconds(clip.start)}–${seconds(clip.start + clip.duration)} s, track ${clip.track})`;
}

/**
 * What the user had selected, in words, ahead of the raw editor JSON: the chips the composer showed are what "this"
 * in the message means, and a model skimming a long JSON dump misses a single nested field. Null when nothing is
 * selected.
 */
export function renderUserSelectionBlock(context: EditorContext): string | null {
  const { clips, range, assetPath, previewElement } = context.selection;
  const lines: string[] = [];
  if (previewElement) lines.push(`- canvas element ${describePreviewElement(previewElement)}`);
  if (clips.length > 0) lines.push(`- timeline clips: ${clips.map(describeClip).join("; ")}`);
  if (range) lines.push(`- time range ${seconds(range.start)}–${seconds(range.end)} s`);
  if (assetPath) lines.push(`- media asset ${assetPath}`);
  const storyNode = context.storyGraph?.selectedNode;
  if (storyNode) lines.push(`- story node ${storyNode}`);
  if (lines.length === 0) return null;
  return `<user-selection>\nThe user had this selected in the editor and attached it to the message. When the message says "this", "it", "here" (or the same in another language) without naming something else, it means this selection:\n${lines.join("\n")}\n</user-selection>`;
}

const ATTACHMENT_KINDS = {
  image: "picture",
  video: "video",
  audio: "audio",
  file: "file",
} as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/** `- video assets/a.mp4 (12.4 s, 3.2 MB)` for a project file the user attached; null for any other reference. */
function describeAttachment(reference: MessageReference): string | null {
  if (reference.kind === "url" || reference.kind === "timeline-range") return null;
  if (reference.kind === "editor-selection") return null;
  const path =
    reference.kind === "asset"
      ? reference.path
      : reference.source.type === "project-path"
        ? reference.source.path
        : null;
  if (!path) return null;
  const kind = reference.kind === "asset" ? "file" : ATTACHMENT_KINDS[reference.kind];
  const facts = [
    reference.durationSeconds !== undefined && `${seconds(reference.durationSeconds)} s`,
    reference.sizeBytes !== undefined && formatBytes(reference.sizeBytes),
  ].filter((fact): fact is string => fact !== false);
  return `- ${kind} ${path}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`;
}

/**
 * The project files the user attached to the message (dropped on the chat or dragged from Media), in words ahead of the
 * raw `<references>`: they are what "this picture", "the video I added" or "these files" means. Null when none.
 */
export function renderAttachmentsBlock(references: readonly MessageReference[]): string | null {
  const lines = references.flatMap((reference) => describeAttachment(reference) ?? []);
  if (lines.length === 0) return null;
  return `<attachments>\nThe user attached these project files to the message. When the message says "this", "these", "the picture", "the video" (or the same in another language) without naming something else, it means these files:\n${lines.join("\n")}\n</attachments>`;
}

/** How much of the editor-context JSON a prompt carries: all of it, or everything but the bulky clip list. */
export interface PromptContextOptions {
  /**
   * `full` (default): the whole captured context — the Director's first prompt of a turn carries it once.
   * `relevant`: without `timeline.elements` (the clip list: up to 200 entries a specialist can read with
   * inspect_timeline); the selection, playhead, composition and counts stay. Specialist tasks and steering use it,
   * so a turn with several specialists does not repeat the same JSON in every prompt.
   */
  editorJson?: "full" | "relevant";
}

/** The editor context without its clip list; the counts say how many clips there are. */
function withoutClipList(context: EditorContext): EditorContext {
  return { ...context, timeline: { ...context.timeline, elements: [] } };
}

/** Adds Studio-captured editor context, typed references and the user's language to the text received by a backend. */
export function renderPromptContext(
  prompt: string,
  editorContext?: EditorContext,
  references: readonly MessageReference[] = [],
  userLanguage?: string,
  options: PromptContextOptions = {},
): string {
  const blocks = [prompt];
  const selection = editorContext ? renderUserSelectionBlock(editorContext) : null;
  if (selection) blocks.push(selection);
  const attachments = renderAttachmentsBlock(references);
  if (attachments) blocks.push(attachments);
  if (editorContext) {
    const relevant =
      options.editorJson === "relevant" && editorContext.timeline.elements.length > 0;
    const shown = relevant ? withoutClipList(editorContext) : editorContext;
    const note = relevant ? "\n(The clip list is left out here; inspect_timeline reads it.)" : "";
    blocks.push(`<editor-context>\n${JSON.stringify(shown, null, 2)}${note}\n</editor-context>`);
  }
  if (references.length > 0) {
    const rendered = references.map((reference) => JSON.stringify(reference)).join("\n");
    blocks.push(`<references>\n${rendered}\n</references>`);
  }
  const language = renderUserLanguageBlock(userLanguage);
  if (language) blocks.push(language);
  return blocks.join("\n\n");
}
