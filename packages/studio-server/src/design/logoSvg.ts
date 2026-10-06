import { DOMParser } from "linkedom";

const DENIED_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "image",
  "img",
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
  "textarea",
  "xmp",
  "noscript",
  "template",
  "math",
]);
/**
 * Tags and handlers refused wherever they appear in the text: an HTML parser reads `<title>`, `<style>`, `<textarea>`
 * and `<xmp>` as raw text even inside `<svg>`, a browser's XML parser does not, so the same bytes can hide markup
 * from one reader and run in the other. The scan does not depend on how any parser reads the file.
 */
const DENIED_TAG_TEXT =
  /<\s*\/?\s*(?:script|foreignobject|iframe|object|embed|image|img|a|animate\w*|set|audio|video|link|meta|base|textarea|xmp|noscript|template|math)\b/i;
const EVENT_HANDLER_TEXT = /\son[a-z]+\s*=/i;
/** Elements whose content is text for every reader: a `<` in them is markup one reader sees and another does not. */
const TEXT_ONLY_ELEMENTS = new Set(["title", "desc", "style", "metadata"]);
/** `url(` that points anywhere but at an id inside the document. */
const OUTSIDE_URL = /url\(\s*(?!["']?\s*#)/i;

function readAsXml(svg: string) {
  try {
    return new DOMParser().parseFromString(svg, "image/svg+xml");
  } catch {
    return null;
  }
}

/**
 * Why an SVG may not be stored as a logo, or null when it is clean. A logo is shown in a page and an `<img>`, and
 * ends up inside a project: scripts, event handlers, embedded documents, animation of links, entity declarations
 * and every reference that leaves the file (`href`, `url()`, `@import`) are refused rather than cleaned. The file is
 * read as XML (as a browser reads an SVG file) and scanned as plain text, and both readings must be clean.
 */
export function svgRefusal(svg: string): string | null {
  if (/<!\s*(?:ENTITY|DOCTYPE\s[^>]*\[)/i.test(svg)) return "it declares entities";
  const denied = DENIED_TAG_TEXT.exec(svg);
  if (denied) return `it contains ${denied[0].replace(/\s+/g, "")}`;
  if (EVENT_HANDLER_TEXT.test(svg)) return "it has an event handler";
  const document = readAsXml(svg);
  if (document === null) return "it is not well-formed XML";
  if (document.documentElement?.localName !== "svg") return "it is not an SVG image";
  for (const element of document.querySelectorAll("*")) {
    const tag = element.localName.toLowerCase();
    if (DENIED_ELEMENTS.has(tag)) return `it contains <${tag}>`;
    if (TEXT_ONLY_ELEMENTS.has(tag)) {
      const text = element.textContent ?? "";
      if (element.children.length > 0 || text.includes("<")) return `its <${tag}> holds markup`;
      if (tag === "style" && (/@import|\\/i.test(text) || OUTSIDE_URL.test(text)))
        return "its stylesheet loads something";
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
