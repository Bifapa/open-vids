/** The `@` token the caret is in, when it is in one. */
export interface ActiveMention {
  /** Index of the `@` in the text. */
  start: number;
  /** What was typed after the `@`, up to the caret. */
  query: string;
}

export const MENTION_LIMIT = 8;

const WHITESPACE = /\s/;

/**
 * The mention being typed: an `@` at the text start, or after whitespace or `(`, followed by non-whitespace
 * characters up to the caret. `mail@example` is not one, and neither is a caret past a space after the `@`.
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === undefined || WHITESPACE.test(char)) return null;
    if (char !== "@") continue;
    const before = index === 0 ? "" : text[index - 1];
    if (before === "" || before === "(" || (before !== undefined && WHITESPACE.test(before))) {
      return { start: index, query: text.slice(index + 1, caret) };
    }
    return null;
  }
  return null;
}

export function mentionBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** The folder part of a project path, without the trailing slash; empty at the project root. */
export function mentionDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * The assets a query points at, best first: basename prefix, then basename contains, then path contains. Within a
 * rank (and for an empty query) the order is alphabetical by basename, then by path.
 */
export function matchMentionAssets(
  assets: readonly string[],
  query: string,
  limit = MENTION_LIMIT,
): string[] {
  const needle = query.toLowerCase();
  const ranked: { path: string; name: string; rank: number }[] = [];
  for (const path of assets) {
    const name = mentionBasename(path).toLowerCase();
    let rank: number;
    if (needle === "" || name.startsWith(needle)) rank = 0;
    else if (name.includes(needle)) rank = 1;
    else if (path.toLowerCase().includes(needle)) rank = 2;
    else continue;
    ranked.push({ path, name, rank });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.name.localeCompare(b.name, "en") ||
      a.path.toLowerCase().localeCompare(b.path.toLowerCase(), "en"),
  );
  return ranked.slice(0, Math.max(0, limit)).map((item) => item.path);
}

/** Replaces `@query` (from the mention's start to the caret) with `@<basename> ` and puts the caret after the space. */
export function applyMention(
  text: string,
  mention: ActiveMention,
  caret: number,
  path: string,
): { text: string; caret: number } {
  const inserted = `@${mentionBasename(path)} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(caret),
    caret: mention.start + inserted.length,
  };
}
