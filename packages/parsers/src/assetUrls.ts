/**
 * Browser-safe primitives for scanning and rewriting asset URLs in HTML/CSS (no `node:path`).
 * The Node-only containment check lives in `assetPaths.ts`.
 *
 * Used by: rewriteSubCompPaths (core), collectExternalAssets (producer), the live composition
 * loader (core runtime).
 */

/**
 * Regex matching CSS `url(...)` references. Capture 1 is a double-quoted value, 2 a single-quoted
 * value and 3 an unquoted one. A quoted value may contain parentheses and the other quote character
 * (`url("a (2).png")`); the unquoted form is anchored to non-whitespace at both ends so the
 * surrounding `\s*` can never overlap it (avoids polynomial-ReDoS backtracking).
 *
 * Use `replaceCssUrls` to rewrite matches; it hides the group layout.
 */
const CSS_URL_RE = /\burl\(\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^)"'\s](?:[^)"']*[^)"'\s])?))\s*\)/g;

/**
 * Rewrite every CSS `url(...)` value. `rewrite` receives the whitespace-trimmed raw URL and returns
 * the replacement, or null/undefined/the same string to keep the reference untouched. The original
 * quote style is preserved.
 */
export function replaceCssUrls(
  css: string,
  rewrite: (rawUrl: string) => string | null | undefined,
): string {
  return css.replace(
    CSS_URL_RE,
    (full: string, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
      const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : "";
      const rawUrl = (doubleQuoted ?? singleQuoted ?? bare ?? "").trim();
      const rewritten = rewrite(rawUrl);
      if (rewritten == null || rewritten === rawUrl) return full;
      return `url(${quote}${rewritten}${quote})`;
    },
  );
}

/** Attributes that hold a single relative asset path. `srcset` holds a candidate list; see `ASSET_PATH_SELECTOR`. */
export const PATH_ATTRS = ["src", "href", "poster", "xlink:href"] as const;

/** Selector for every element that may carry a relative asset path (`PATH_ATTRS` plus `srcset`). */
export const ASSET_PATH_SELECTOR = "[src], [href], [poster], [srcset], [xlink\\:href]";

/**
 * Rewrite each URL of a `srcset` value (`a.png 1x, b.png 2x`). Returns the input untouched when no
 * URL changes; otherwise the candidates are re-joined with ", ".
 */
export function rewriteSrcset(srcset: string, rewrite: (url: string) => string): string {
  const candidates: string[] = [];
  let changed = false;
  let cursor = 0;
  while (cursor < srcset.length) {
    while (cursor < srcset.length && /[\s,]/.test(srcset.charAt(cursor))) cursor += 1;
    if (cursor >= srcset.length) break;
    const urlStart = cursor;
    while (cursor < srcset.length && !/\s/.test(srcset.charAt(cursor))) cursor += 1;
    const token = srcset.slice(urlStart, cursor);
    const url = token.replace(/,+$/, "");
    let descriptors = "";
    if (url === token) {
      const comma = srcset.indexOf(",", cursor);
      const end = comma === -1 ? srcset.length : comma;
      descriptors = srcset.slice(cursor, end).trim();
      cursor = end + 1;
    }
    const rewritten = rewrite(url);
    if (rewritten !== url) changed = true;
    candidates.push(descriptors ? `${rewritten} ${descriptors}` : rewritten);
  }
  return changed ? candidates.join(", ") : srcset;
}

/** Returns true for URLs/prefixes that should never be rewritten. */
export function isNonRelativeUrl(val: string): boolean {
  return (
    !val ||
    val.startsWith("http://") ||
    val.startsWith("https://") ||
    val.startsWith("//") ||
    val.startsWith("data:") ||
    val.startsWith("#") ||
    val.startsWith("/")
  );
}
