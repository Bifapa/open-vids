import { posix } from "node:path";

/**
 * Project paths a composition's markup or stylesheet points at, beyond its timeline clips: `<img>` and `<source>`
 * sources, `poster`, `srcset`, `<link href>` and any `url(…)` or `@import` of an inline `<style>`, a `style=""`
 * attribute or a linked stylesheet — which is where a self-hosted web font is referenced.
 */

const ATTRIBUTE = /\b(?:src|href|poster|srcset|data-[\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A reference as a normalised project path, or null for anything that is not a file inside the project. */
function projectPath(reference: string, baseDir: string): string | null {
  const text = reference.trim();
  if (!text || text.startsWith("#") || text.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(text))
    return null;
  const path = decoded(text.split(/[?#]/, 1)[0] ?? "").replaceAll("\\", "/");
  if (!path) return null;
  const normalised = path.startsWith("/")
    ? posix.normalize(path.slice(1))
    : posix.normalize(posix.join(baseDir, path));
  return normalised === "." || normalised === ".." || normalised.startsWith("../")
    ? null
    : normalised;
}

function* matches(text: string, pattern: RegExp): Generator<string> {
  for (const match of text.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) yield value;
  }
}

/**
 * Every project path `text` (HTML or CSS, living in `baseDir`) references. A relative path is resolved against the
 * file's own folder and, since the preview and the renderer serve the project root, as written too.
 */
export function referencedPaths(text: string, baseDir: string, isCss: boolean): Set<string> {
  const raw: string[] = [];
  if (!isCss) {
    for (const value of matches(text, ATTRIBUTE)) {
      // `srcset` is a comma list of `url [descriptor]`; for every other attribute the comma stays part of the value.
      raw.push(value);
      for (const candidate of value.split(",")) raw.push(candidate.trim().split(/\s+/, 1)[0] ?? "");
    }
  }
  raw.push(...matches(text, CSS_URL), ...matches(text, CSS_IMPORT));
  const paths = new Set<string>();
  for (const reference of raw) {
    for (const dir of baseDir === "" || baseDir === "." ? [""] : [baseDir, ""]) {
      const path = projectPath(reference, dir);
      if (path !== null) paths.add(path);
    }
  }
  return paths;
}
