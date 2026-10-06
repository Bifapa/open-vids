/** A small, forgiving CSS reader for design extraction: declarations grouped per rule, font faces, imports. */

export interface CssDeclaration {
  /** Lowercase, except custom properties (`--Brand`), which keep their case. */
  property: string;
  value: string;
}

export interface CssRule {
  selector: string;
  declarations: CssDeclaration[];
}

export interface ParsedCss {
  rules: CssRule[];
  fontFaces: CssDeclaration[][];
  /** `@import` targets as written (`url(...)` and quotes removed). */
  imports: string[];
}

/** Nesting deeper than this is not stylesheet CSS; the rest is ignored. */
const MAX_DEPTH = 8;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Index of the `}` closing the block opened just before `from`, or the end of the text. */
function blockEnd(css: string, from: number): number {
  let depth = 1;
  let quote = "";
  for (let i = from; i < css.length; i++) {
    const ch = css[i];
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return css.length;
}

function declarationOf(segment: string): CssDeclaration | null {
  const colon = segment.indexOf(":");
  if (colon <= 0) return null;
  const name = segment.slice(0, colon).trim();
  if (!/^-{0,2}[A-Za-z_][\w-]*$/.test(name)) return null;
  const value = segment
    .slice(colon + 1)
    .replace(/!\s*important\s*$/i, "")
    .trim();
  if (value === "") return null;
  return { property: name.startsWith("--") ? name : name.toLowerCase(), value };
}

/** Splits `a:b;c:d` on top-level semicolons (not inside quotes or parentheses). */
export function parseDeclarations(body: string): CssDeclaration[] {
  const result: CssDeclaration[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  const push = (end: number) => {
    const declaration = declarationOf(body.slice(start, end));
    if (declaration) result.push(declaration);
    start = end + 1;
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) push(i);
  }
  push(body.length);
  return result;
}

function importTarget(statement: string): string | null {
  const match =
    /^@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|"([^"]*)"|'([^']*)')/i.exec(
      statement.trim(),
    );
  const target = match
    ?.slice(1)
    .find((part) => part !== undefined)
    ?.trim();
  return target === undefined || target === "" ? null : target;
}

function readBlock(css: string, selector: string, out: ParsedCss, depth: number): void {
  let ownText = "";
  let i = 0;
  let segmentStart = 0;
  let paren = 0;
  let quote = "";
  const flushStatement = (end: number) => {
    const statement = css.slice(segmentStart, end);
    if (statement.trim().toLowerCase().startsWith("@import")) {
      const target = importTarget(statement);
      if (target !== null) out.imports.push(target);
    } else ownText += `${statement};`;
    segmentStart = end + 1;
  };
  while (i < css.length) {
    const ch = css[i];
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === ";" && paren === 0) flushStatement(i);
    else if (ch === "{") {
      const nestedSelector = css.slice(segmentStart, i).trim();
      const end = blockEnd(css, i + 1);
      const inner = css.slice(i + 1, end);
      if (depth < MAX_DEPTH) {
        if (/^@font-face\b/i.test(nestedSelector)) out.fontFaces.push(parseDeclarations(inner));
        else if (nestedSelector.startsWith("@")) readBlock(inner, selector, out, depth + 1);
        else readBlock(inner, nestedSelector, out, depth + 1);
      }
      i = end;
      segmentStart = end + 1;
    }
    i++;
  }
  flushStatement(css.length);
  const own = parseDeclarations(ownText);
  if (own.length > 0) out.rules.push({ selector, declarations: own });
}

/** Parses a stylesheet (or a `<style>` body). Never throws; unreadable parts are skipped. */
export function parseCss(css: string): ParsedCss {
  const out: ParsedCss = { rules: [], fontFaces: [], imports: [] };
  readBlock(stripComments(css), "", out, 0);
  return out;
}

/** Whether a selector list contains `:root` or `html` (where design tokens live). */
export function isRootSelector(selector: string): boolean {
  return selector.split(",").some((part) => /^(?::root|html)\b/i.test(part.trim()));
}

const MAX_VAR_DEPTH = 8;

/** Replaces `var(--x[, fallback])` using `vars`; a reference that cannot be resolved is left in place. */
export function resolveVars(value: string, vars: ReadonlyMap<string, string>, depth = 0): string {
  if (depth >= MAX_VAR_DEPTH || !value.includes("var(")) return value;
  const resolved = value.replace(
    /var\(\s*(--[\w-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/g,
    (whole, name: string, fallback: string | undefined) =>
      vars.get(name) ?? (fallback !== undefined ? fallback.trim() : whole),
  );
  return resolved === value ? value : resolveVars(resolved, vars, depth + 1);
}
