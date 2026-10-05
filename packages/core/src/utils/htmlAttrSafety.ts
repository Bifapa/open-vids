/**
 * Shared HTML attribute safety constants.
 *
 * Single source of truth for attribute allowlists and dangerous-URI patterns
 * used by sourceMutation (core), sdkCutover (studio), and mutate (sdk).
 */

export const ALLOWED_HTML_ATTRS = new Set([
  "id",
  "class",
  "style",
  "title",
  "name",
  "for",
  "type",
  "lang",
  "dir",
  "translate",
  "hidden",
  "tabindex",
  "draggable",
  "contenteditable",
  "role",
  "slot",
  "href",
  "target",
  "rel",
  "src",
  "srcset",
  "sizes",
  "alt",
  "poster",
  "loading",
  "decoding",
  "crossorigin",
  "preload",
  "autoplay",
  "loop",
  "muted",
  "controls",
  "playsinline",
  "width",
  "height",
  "colspan",
  "rowspan",
  "scope",
  "placeholder",
  "value",
  "min",
  "max",
  "step",
  "pattern",
  "required",
  "disabled",
  "readonly",
  "checked",
  "selected",
  "multiple",
  "accept",
  "maxlength",
  "minlength",
  "rows",
  "cols",
  "wrap",
]);

export const URI_BEARING_ATTRS = new Set([
  "src",
  "href",
  "action",
  "formaction",
  "poster",
  "srcset",
  "xlink:href",
]);

const DANGEROUS_URI_SCHEMES = /^(?:javascript|vbscript):/i;
const DANGEROUS_DATA_URI = /^data\s*:\s*text\/html/i;

export function isAllowedHtmlAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) return false;
  if (ALLOWED_HTML_ATTRS.has(lower)) return true;
  if (lower.startsWith("data-")) return true;
  if (lower.startsWith("aria-")) return true;
  return false;
}

/**
 * Reduce a URI attribute value to what a URL parser sees before it reads the
 * scheme: ASCII tab, LF and CR are removed anywhere, and leading C0 controls
 * and spaces are stripped. `java\tscript:` and `\x01javascript:` both
 * resolve to the `javascript:` scheme in a browser, so the scheme check has to
 * run on this form rather than on the raw value.
 */
function normalizeUriForSchemeCheck(value: string): string {
  const stripped = value.replace(/[\t\n\r]/g, "");
  let start = 0;
  while (start < stripped.length && stripped.charCodeAt(start) <= 0x20) start += 1;
  return stripped.slice(start);
}

export function isSafeAttributeValue(name: string, value: string): boolean {
  if (URI_BEARING_ATTRS.has(name.toLowerCase())) {
    const normalized = normalizeUriForSchemeCheck(value);
    if (DANGEROUS_URI_SCHEMES.test(normalized)) return false;
    if (DANGEROUS_DATA_URI.test(normalized)) return false;
  }
  return true;
}
