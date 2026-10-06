import {
  DESIGN_LIMITS,
  DESIGN_REQUIRED_TOKENS,
  DESIGN_TOKEN_NAME,
  isSafeDesignTokenValue,
} from "@hyperframes/agent-protocol";
import { parseHTML } from "linkedom";
import { analyseCss } from "./css.js";
import { readManifestBlock } from "./parse.js";

export interface ValidateOptions {
  /** The version the manifest must name. */
  expectedVersion?: number;
  /** Whether a library-relative file (`fonts/…`, `logo.svg`) exists; without it the files are not checked. */
  fileExists?: (relativePath: string) => boolean;
}

const MAX_HTML_BYTES = 2 * 1024 * 1024;

const ALLOWED_TAGS = new Set([
  "html",
  "head",
  "meta",
  "title",
  "style",
  "script",
  "body",
  "main",
  "header",
  "footer",
  "section",
  "article",
  "aside",
  "nav",
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "b",
  "i",
  "code",
  "pre",
  "small",
  "br",
  "hr",
  "img",
  "blockquote",
  "figure",
  "figcaption",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);
const GLOBAL_ATTRIBUTES = new Set(["class", "id", "lang", "dir", "title", "style", "role"]);
const TAG_ATTRIBUTES: Record<string, string[]> = {
  meta: ["charset", "name", "content"],
  style: ["type"],
  script: ["type"],
  img: ["src", "alt", "width", "height"],
  th: ["colspan", "rowspan"],
  td: ["colspan", "rowspan"],
};
const RELATIVE_SRC = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ACTIVE_URL = /javascript:|vbscript:|data:text\/html/;

function attributeAllowed(tag: string, name: string): boolean {
  return (
    GLOBAL_ATTRIBUTES.has(name) ||
    name.startsWith("data-") ||
    name.startsWith("aria-") ||
    (TAG_ATTRIBUTES[tag]?.includes(name) ?? false)
  );
}

function requiredTokenIssues(tokens: Record<string, string>): string[] {
  const issues: string[] = [];
  for (const name of DESIGN_REQUIRED_TOKENS)
    if (tokens[name] === undefined) issues.push(`missing required token ${name}`);
  const names = Object.keys(tokens);
  if (names.length > DESIGN_LIMITS.tokens)
    issues.push(`more than ${DESIGN_LIMITS.tokens} tokens are declared`);
  for (const name of names) {
    if (!DESIGN_TOKEN_NAME.test(name)) issues.push(`${name} is not a token name`);
    else if (!isSafeDesignTokenValue(tokens[name] ?? ""))
      issues.push(`token ${name} does not hold a safe CSS value`);
  }
  return issues;
}

/**
 * Every problem of a `system.html`, empty when it is clean: a strict allow-list of tags and attributes (no script but
 * the manifest data block, no event handlers, no `<link>`/`<base>`/`<iframe>`/`<svg>`/refresh), no `javascript:`, no
 * URL that is not a relative file (attributes, `<style>`, `style=`, `url()`, `@import`), `@font-face` sources only
 * relative `fonts/` files, all 18 contract tokens, and a manifest that agrees with the page and the files.
 */
export function validateDesignSystemHtml(html: string, options: ValidateOptions = {}): string[] {
  if (html.length > MAX_HTML_BYTES) return ["system.html is larger than 2 MB"];
  const issues: string[] = [];
  const report = (issue: string): void => {
    if (!issues.includes(issue)) issues.push(issue);
  };

  // The raw text is scanned too, so a tag the DOM parser reads differently from a browser is still refused.
  for (const match of html.matchAll(/<\s*\/?\s*([a-zA-Z][^\s/>]*)/g)) {
    const name = (match[1] ?? "").toLowerCase();
    if (!ALLOWED_TAGS.has(name)) report(`<${name}> is not allowed`);
  }
  if ((html.match(/<script(?=[\s/>])/gi) ?? []).length !== 1)
    report("exactly one <script> is allowed: the manifest data block");

  let document: Document;
  try {
    document = parseHTML(html).document;
  } catch {
    return [...issues, "system.html cannot be parsed as HTML"];
  }

  const tokens: Record<string, string> = {};
  const fontUrls: string[] = [];
  for (const element of document.querySelectorAll("*")) {
    const tag = element.localName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) report(`<${tag}> is not allowed`);
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("on")) report(`<${tag}> has the event handler ${name}`);
      else if (!attributeAllowed(tag, name))
        report(`<${tag}> has the attribute ${name}, which is not allowed`);
      if (ACTIVE_URL.test(value.replace(/[\s\p{Cc}]/gu, "").toLowerCase()))
        report(`<${tag} ${name}> holds a script or HTML URL`);
      if (tag === "img" && name === "src" && (!RELATIVE_SRC.test(value) || value.includes("..")))
        report(`<img src="${value.slice(0, 60)}"> must be a relative file`);
      if (tag === "meta" && name === "content" && !/^[A-Za-z0-9=.,\s-]{0,120}$/.test(value))
        report("<meta content> may only hold plain settings");
      if (name === "style") {
        const facts = analyseCss(`x{${value}}`, `style attribute of <${tag}>`);
        facts.issues.forEach(report);
      }
    }
    if (tag === "script" && element.getAttribute("type")?.toLowerCase() !== "application/json")
      report('the only <script> allowed has type="application/json"');
    if (tag === "style") {
      const facts = analyseCss(element.textContent ?? "", "<style>");
      facts.issues.forEach(report);
      Object.assign(tokens, facts.tokens);
      fontUrls.push(...facts.fontUrls);
    }
    if (
      tag === "meta" &&
      element.hasAttribute("name") &&
      element.getAttribute("name") !== "viewport"
    )
      report("<meta name> may only be viewport");
  }

  requiredTokenIssues(tokens).forEach(report);

  const manifest = readManifestBlock(document, tokens);
  if (!manifest.ok) {
    manifest.issues.forEach(report);
    return issues;
  }
  const { manifest: read } = manifest;
  if (options.expectedVersion !== undefined && read.version !== options.expectedVersion)
    report(`manifest names version ${read.version}, expected ${options.expectedVersion}`);
  const declared = new Set(fontUrls);
  const listed = new Set<string>();
  for (const font of read.fonts) {
    if (font.source === "system") {
      if (font.portable || font.files.length > 0)
        report(`system font "${font.family}" must be non-portable and have no files`);
      continue;
    }
    if (!font.portable || font.files.length === 0)
      report(`font "${font.family}" has no files: ${font.source} fonts must resolve to files`);
    for (const file of font.files) {
      listed.add(file.path);
      if (!declared.has(file.path))
        report(`font file ${file.path} is listed in the manifest but no @font-face loads it`);
      if (options.fileExists && !options.fileExists(file.path))
        report(`font file ${file.path} does not exist`);
    }
  }
  for (const url of declared)
    if (!listed.has(url)) report(`@font-face loads ${url}, which the manifest does not list`);
  if (read.logo && options.fileExists && !options.fileExists(read.logo.path))
    report(`logo file ${read.logo.path} does not exist`);
  return issues;
}

/** Every problem of a `tokens.css`: only `:root` and `@font-face`, the 18 tokens, safe values, relative font files. */
export function validateTokensCss(css: string): string[] {
  if (css.length > MAX_HTML_BYTES) return ["tokens.css is larger than 2 MB"];
  const facts = analyseCss(css, "tokens.css");
  const issues = [...facts.issues];
  for (const top of facts.topLevel)
    if (top !== ":root" && top !== "@font-face") issues.push(`tokens.css: ${top} is not allowed`);
  issues.push(...requiredTokenIssues(facts.tokens));
  return [...new Set(issues)];
}
