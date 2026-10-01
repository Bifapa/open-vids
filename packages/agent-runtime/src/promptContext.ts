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
