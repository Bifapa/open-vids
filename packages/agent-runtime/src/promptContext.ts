import type { EditorContext, MessageReference } from "@hyperframes/agent-protocol";

/** Adds Studio-captured editor context and typed references to the text received by a backend. */
export function renderPromptContext(
  prompt: string,
  editorContext?: EditorContext,
  references: readonly MessageReference[] = [],
): string {
  const blocks = [prompt];
  if (editorContext) {
    blocks.push(`<editor-context>\n${JSON.stringify(editorContext, null, 2)}\n</editor-context>`);
  }
  if (references.length > 0) {
    const rendered = references.map((reference) => JSON.stringify(reference)).join("\n");
    blocks.push(`<references>\n${rendered}\n</references>`);
  }
  return blocks.join("\n\n");
}
