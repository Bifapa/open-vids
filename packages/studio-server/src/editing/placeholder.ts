/** Marker the blank project template puts on its placeholder clip (`packages/cli/src/templates/blank/index.html`). */
export const PLACEHOLDER_ATTRIBUTE = "data-ov-placeholder";
export const TEMPLATE_PLACEHOLDER = "template";

/** What the template's placeholder looked like, attribute for attribute; any difference means the user touched it. */
const TEMPLATE_TAG = "h1";
const TEMPLATE_TEXT = "Title";
const TEMPLATE_ATTRIBUTES: Record<string, string> = {
  id: "title",
  class: "clip",
  "data-start": "0",
  "data-duration": "10",
  "data-track-index": "0",
  [PLACEHOLDER_ATTRIBUTE]: TEMPLATE_PLACEHOLDER,
};
const NUMERIC_ATTRIBUTES: Record<string, true> = {
  "data-start": true,
  "data-duration": true,
  "data-track-index": true,
};
/** Studio stamps this into every clip it opens; it is not an edit. */
const IGNORED_ATTRIBUTES: Record<string, true> = { "data-hf-id": true };

/**
 * Whether a clip is the blank template's placeholder AND still untouched: it carries the template marker and its
 * tag, text and attributes all still equal the template's. A user who typed their own title, retimed, restyled or
 * moved the clip keeps it, and projects created before the marker existed never match (no guessing by text).
 */
export function isUntouchedTemplatePlaceholder(element: Element): boolean {
  if (element.getAttribute(PLACEHOLDER_ATTRIBUTE) !== TEMPLATE_PLACEHOLDER) return false;
  if (element.tagName.toLowerCase() !== TEMPLATE_TAG) return false;
  if (element.children.length > 0 || (element.textContent ?? "").trim() !== TEMPLATE_TEXT) {
    return false;
  }
  const attributes = Array.from(element.attributes).filter(
    (attribute) => !IGNORED_ATTRIBUTES[attribute.name],
  );
  if (attributes.length !== Object.keys(TEMPLATE_ATTRIBUTES).length) return false;
  return attributes.every((attribute) => {
    const expected = TEMPLATE_ATTRIBUTES[attribute.name];
    if (expected === undefined) return false;
    return NUMERIC_ATTRIBUTES[attribute.name]
      ? Number(attribute.value) === Number(expected)
      : attribute.value === expected;
  });
}
