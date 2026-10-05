import { ensureHfIds, isCompositionTemplate } from "@hyperframes/parsers/hf-ids";
import {
  STUDIO_PREVIEW_DETACHED_SRC_ATTR,
  STUDIO_PREVIEW_LAZY_ATTR,
  STUDIO_PREVIEW_UPCOMING_ATTR,
} from "@hyperframes/core/studio-preview-mark";
import { PATH_ATTRS, replaceCssUrls, rewriteSrcset } from "@hyperframes/parsers/asset-urls";

// Stamped as the preview stamps the files it serves, so a live element's hf-id finds its source.
export function parseSavedSource(html: string): Document {
  return new DOMParser().parseFromString(ensureHfIds(html), "text/html");
}

const rootsByDoc = new WeakMap<Document, ParentNode[]>();

// A plain template is a runtime clone source, so ids inside it repeat across clones.
function searchRoots(root: ParentNode): ParentNode[] {
  const templates = Array.from(root.querySelectorAll("template")).filter(isCompositionTemplate);
  return [root, ...templates.flatMap((template) => searchRoots(template.content))];
}

function findByAttribute(doc: Document, name: string, value: string): Element | null {
  let roots = rootsByDoc.get(doc);
  if (!roots) rootsByDoc.set(doc, (roots = searchRoots(doc)));
  const selector = `[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;
  for (const root of roots) {
    const match = root.querySelector(selector);
    if (match) return match;
  }
  return null;
}

export function findAuthoredElement(doc: Document, live: Element): Element | null {
  const hfId = live.getAttribute("data-hf-id");
  if (hfId) return findByAttribute(doc, "data-hf-id", hfId);
  return live.id ? findByAttribute(doc, "id", live.id) : null;
}

export function findAuthoredElementById(doc: Document, live: Element): Element | null {
  return live.id ? findByAttribute(doc, "id", live.id) : null;
}

function isRelative(path: string): boolean {
  return !!path && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(path);
}

function toProjectPath(sourceFile: string, path: string): string {
  const parts = sourceFile.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}

function livePathsOf(live: Element): Set<string> {
  const paths = new Set<string>();
  for (const el of [live, ...Array.from(live.querySelectorAll("*"))]) {
    for (const attr of PATH_ATTRS) paths.add(el.getAttribute(attr) ?? "");
    paths.add(el.getAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR) ?? "");
    rewriteSrcset(el.getAttribute("srcset") ?? "", (url) => {
      paths.add(url);
      return url;
    });
    replaceCssUrls(el.getAttribute("style") ?? "", (url) => {
      paths.add(url);
      return null;
    });
  }
  return paths;
}

// The preview inlines a sub-composition with its relative asset paths rebased to the project
// root (rewriteAssetPath in @hyperframes/parsers, which is not browser-safe); copy does the same.
export function authoredMarkup(authored: Element, live: Element, sourceFile: string): string {
  if (!sourceFile.includes("/")) return authored.outerHTML;
  const livePaths = livePathsOf(live);
  const rebase = (path: string): string => {
    if (!isRelative(path)) return path;
    const cut = path.search(/[?#]/);
    const suffix = cut < 0 ? "" : path.slice(cut);
    const rebased = toProjectPath(sourceFile, cut < 0 ? path : path.slice(0, cut)) + suffix;
    return path.startsWith("../") || livePaths.has(rebased) ? rebased : path;
  };
  const copy = authored.cloneNode(true) as Element;
  for (const el of [copy, ...Array.from(copy.querySelectorAll("*"))]) {
    for (const attr of PATH_ATTRS) {
      const value = el.getAttribute(attr);
      if (value) el.setAttribute(attr, rebase(value.trim()));
    }
    const srcset = el.getAttribute("srcset");
    if (srcset) el.setAttribute("srcset", rewriteSrcset(srcset, rebase));
    const style = el.getAttribute("style");
    if (style) el.setAttribute("style", replaceCssUrls(style, rebase));
  }
  return copy.outerHTML;
}

export function liveMarkupWithoutPreviewMarks(live: Element): string {
  const copy = live.cloneNode(true) as Element;
  for (const el of [copy, ...Array.from(copy.querySelectorAll("*"))]) {
    el.removeAttribute(STUDIO_PREVIEW_UPCOMING_ATTR);
    // A video whose decoder the preview released: the copy carries its authored source back.
    const detachedSrc = el.getAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR);
    if (detachedSrc !== null) {
      el.setAttribute("src", detachedSrc);
      el.removeAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR);
      el.removeAttribute("preload");
    }
    if (!el.hasAttribute(STUDIO_PREVIEW_LAZY_ATTR)) continue;
    el.removeAttribute("loading");
    el.removeAttribute(STUDIO_PREVIEW_LAZY_ATTR);
  }
  return copy.outerHTML;
}
