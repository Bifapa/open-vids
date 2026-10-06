import { parseHTML } from "linkedom";

const DENIED_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "image",
  "a",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
  "audio",
  "video",
  "link",
  "meta",
  "base",
]);
/** `url(` that points anywhere but at an id inside the document. */
const OUTSIDE_URL = /url\(\s*(?!["']?\s*#)/i;

/**
 * Why an SVG may not be stored as a logo, or null when it is clean. A logo is shown in a page and an `<img>`, and
 * ends up inside a project: scripts, event handlers, embedded documents, animation of links, entity declarations
 * and every reference that leaves the file (`href`, `url()`, `@import`) are refused rather than cleaned.
 */
export function svgRefusal(svg: string): string | null {
  if (/<!\s*(?:ENTITY|DOCTYPE\s[^>]*\[)/i.test(svg)) return "it declares entities";
  let document: Document;
  try {
    document = parseHTML(svg).document;
  } catch {
    return "it cannot be parsed";
  }
  if (!document.querySelector("svg")) return "it is not an SVG image";
  for (const element of document.querySelectorAll("*")) {
    const tag = element.localName.toLowerCase();
    if (DENIED_ELEMENTS.has(tag)) return `it contains <${tag}>`;
    if (tag === "style") {
      const css = element.textContent ?? "";
      if (/@import|\\/i.test(css) || OUTSIDE_URL.test(css)) return "its stylesheet loads something";
    }
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("on")) return `it has the event handler ${name}`;
      if (/(?:^|:)(?:href|src)$/.test(name) && !value.trim().startsWith("#"))
        return `${name} leaves the file`;
      if (OUTSIDE_URL.test(value) || /javascript:|data:text\/html/i.test(value.replace(/\s/g, "")))
        return `${name} references something outside the file`;
    }
  }
  return null;
}
