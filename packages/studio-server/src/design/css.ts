import postcss, { type ChildNode } from "postcss";

/** A font file a stylesheet may load: relative, inside the system's own `fonts/` folder. */
export const FONT_FILE_PATH = /^fonts\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:woff2|woff|ttf|otf)$/;

/** CSS functions that fetch something or run code; none belongs in a value (font `src` is checked on its own). */
const LOADING_FUNCTION =
  /(?:^|[^a-z0-9_-])(?:-webkit-)?(?:url|image-set|src|image|cross-fade|element|paint)\s*\(|expression\s*\(/i;
const SCRIPTING_PROPERTY = /^(?:behavior|-moz-binding)$/i;
const ALLOWED_AT_RULES = new Set(["font-face", "keyframes", "-webkit-keyframes", "media"]);
const URL_IN_SRC = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
const REST_OF_SRC = /^[\s,]*(?:format\(\s*["'][a-z0-9-]+["']\s*\)[\s,]*)*$/i;

export interface CssFacts {
  issues: string[];
  /** The `--*` declarations of every `:root` rule, later ones overriding. */
  tokens: Record<string, string>;
  /** Every font file a `@font-face` loads, as written. */
  fontUrls: string[];
  /** Selectors-and-at-rules found at the top level (`:root`, `@font-face`, …), for the tokens-only check. */
  topLevel: string[];
}

/**
 * Reads one stylesheet (a `<style>` block, a `style` attribute wrapped in a rule, `tokens.css`) and reports what makes
 * it unsafe: anything that loads a resource other than a relative `fonts/` file, `@import` and every other at-rule
 * outside `@font-face`/`@keyframes`/`@media`, CSS escapes (they hide the others), scripting properties.
 */
export function analyseCss(css: string, where: string): CssFacts {
  const facts: CssFacts = { issues: [], tokens: {}, fontUrls: [], topLevel: [] };
  if (css.includes("\\")) {
    facts.issues.push(`${where}: CSS escapes (\\) are not allowed`);
    return facts;
  }
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch {
    facts.issues.push(`${where}: is not valid CSS`);
    return facts;
  }
  const visit = (node: ChildNode, parent: "root" | "font-face" | "other"): void => {
    if (node.type === "atrule") {
      const name = node.name.toLowerCase();
      if (parent === "root") facts.topLevel.push(`@${name}`);
      if (!ALLOWED_AT_RULES.has(name)) {
        facts.issues.push(`${where}: @${node.name} is not allowed`);
        return;
      }
      node.each((child) => {
        visit(child, name === "font-face" ? "font-face" : "other");
      });
      return;
    }
    if (node.type === "rule") {
      if (parent === "root") facts.topLevel.push(node.selector.trim());
      const isRoot = parent === "root" && node.selector.trim() === ":root";
      node.each((child) => {
        if (child.type === "decl" && isRoot && child.prop.startsWith("--"))
          facts.tokens[child.prop] = child.value.trim();
        visit(child, "other");
      });
      return;
    }
    if (node.type !== "decl") return;
    if (SCRIPTING_PROPERTY.test(node.prop)) {
      facts.issues.push(`${where}: ${node.prop} is not allowed`);
      return;
    }
    if (parent === "font-face" && node.prop.toLowerCase() === "src") {
      for (const match of node.value.matchAll(URL_IN_SRC)) {
        const url = match[2] ?? "";
        facts.fontUrls.push(url);
        if (!FONT_FILE_PATH.test(url))
          facts.issues.push(`${where}: @font-face src "${url}" is not a relative fonts/ file`);
      }
      if (!REST_OF_SRC.test(node.value.replace(URL_IN_SRC, "")))
        facts.issues.push(`${where}: @font-face src may only name relative fonts/ files`);
      return;
    }
    if (LOADING_FUNCTION.test(node.value))
      facts.issues.push(`${where}: ${node.prop} loads or runs something (url(), image-set(), …)`);
  };
  root.each((node) => {
    visit(node, "root");
  });
  return facts;
}
