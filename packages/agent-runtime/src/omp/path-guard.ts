import { realpath } from "node:fs/promises";
import path from "node:path";
import { resolveLikeOmp } from "./path-forms.ts";

const PATH_ARGUMENT_KEYS: Record<string, true> = {
  path: true,
  paths: true,
  filepath: true,
  file: true,
  filename: true,
  directory: true,
  dir: true,
  cwd: true,
  target: true,
  source: true,
  from: true,
  to: true,
  oldpath: true,
  newpath: true,
  sourcepath: true,
  targetpath: true,
  rename: true,
};
const DISPLAY_TARGET_LIMIT = 4;

function normalizedKey(key: string): string {
  return key.replaceAll(/[-_]/g, "").toLowerCase();
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    if (Object.hasOwn(PATH_ARGUMENT_KEYS, normalizedKey(key))) {
      collectStrings(child, output);
    } else if (typeof child === "object" && child !== null) {
      collectStrings(child, output);
    }
  }
}

export function extractPathArguments(input: unknown): string[] {
  const candidates: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return candidates;
  }
  for (const [key, value] of Object.entries(input)) {
    if (Object.hasOwn(PATH_ARGUMENT_KEYS, normalizedKey(key))) {
      collectStrings(value, candidates);
    } else if (Array.isArray(value)) {
      for (const item of value) candidates.push(...extractPathArguments(item));
    } else if (typeof value === "object" && value !== null) {
      candidates.push(...extractPathArguments(value));
    }
  }
  return [...new Set(candidates)];
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

async function realpathWithMissingTail(target: string): Promise<string> {
  let probe = path.resolve(target);
  const missing: string[] = [];

  while (true) {
    try {
      const resolvedParent = await realpath(probe);
      return path.resolve(resolvedParent, ...missing.reverse());
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTDIR")
      ) {
        throw error;
      }
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      missing.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

function isHyperframesPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative)) return false;
  return relative.split(path.sep).some((segment) => segment === ".hyperframes");
}

function blockReason(target: string, cause?: unknown, url = false): string {
  if (url) {
    return "Only paths inside this project can be accessed; URLs and external file schemes are blocked.";
  }
  if (cause) {
    return `The project boundary for ${JSON.stringify(target)} could not be verified, so access was blocked.`;
  }
  return `Project boundary violation: ${JSON.stringify(target)} resolves outside this project. Only project files outside .hyperframes may be accessed.`;
}

const MAX_VARIANTS = 64;

function braceExpand(pattern: string, budget = MAX_VARIANTS): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  let depth = 0;
  let close = -1;
  for (let index = open; index < pattern.length; index++) {
    if (pattern[index] === "{") depth++;
    else if (pattern[index] === "}" && --depth === 0) {
      close = index;
      break;
    }
  }
  if (close < 0) return [pattern];
  const alternatives: string[] = [];
  let start = open + 1;
  depth = 0;
  for (let index = open + 1; index <= close; index++) {
    const char = pattern[index];
    if (char === "{") depth++;
    else if (char === "}" && index < close) depth--;
    else if ((char === "," && depth === 0) || index === close) {
      alternatives.push(pattern.slice(start, index));
      start = index + 1;
    }
  }
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const expanded: string[] = [];
  for (const alternative of alternatives) {
    for (const rest of braceExpand(prefix + alternative + suffix, budget)) {
      expanded.push(rest);
      if (expanded.length >= budget) throw new RangeError("too many path alternatives");
    }
  }
  return expanded;
}

/**
 * OMP's read/grep/find fan one `path` string out into several targets (`a;b`, `a,b`, `a b`, glob
 * braces, a `:1-20` selector suffix). Every plausible reading is checked, not just the literal one,
 * so `src;../../secret` cannot hide an outside path behind an inside-looking prefix.
 */
export function pathVariants(raw: string): string[] {
  const variants = new Set<string>([raw]);
  for (const part of raw.split(/[;,\s]+/)) if (part) variants.add(part);
  for (const variant of [...variants]) {
    for (const expanded of braceExpand(variant)) variants.add(expanded);
  }
  for (const variant of [...variants]) {
    const selector = variant.replace(/:[^/:]*$/, "");
    if (selector !== variant) variants.add(selector);
  }
  return [...variants];
}

/** Tools that change files: a call whose target cannot be read from its arguments must not run. */
const MUTATING_TOOLS: Record<string, true> = { edit: true, write: true };

export async function guardToolCallPaths(
  projectDir: string,
  input: unknown,
  toolName?: string,
): Promise<string | null> {
  const candidates = extractPathArguments(input);
  if (toolName !== undefined && Object.hasOwn(MUTATING_TOOLS, toolName)) {
    // Patch-style edit modes carry their targets inside a free-text `input` blob; they are not
    // parsed here, so they are refused rather than trusted. The session pins a path-based mode.
    const opaque = typeof input === "object" && input !== null && "input" in input;
    if (candidates.length === 0 || opaque) {
      return `The ${toolName} call names its target file in a form that cannot be checked against the project boundary, so it was blocked. Use the path-based form with an explicit "path" inside the project.`;
    }
  }
  if (candidates.length === 0) return null;

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(projectDir);
  } catch {
    return "The project directory could not be verified; file access was blocked.";
  }

  let targets: string[];
  try {
    targets = candidates.flatMap((original) => pathVariants(original.trim()));
  } catch {
    return "That path pattern is too broad to check against the project boundary, so it was blocked. Use one explicit path per call.";
  }
  for (const target of targets) {
    if (!target) continue;
    const absolutes = resolveLikeOmp(projectDir, target);
    if (absolutes === null) return blockReason(target, undefined, true);

    for (const absolute of absolutes) {
      let canonicalTarget: string;
      try {
        canonicalTarget = await realpathWithMissingTail(absolute);
      } catch (error) {
        return blockReason(target, error);
      }

      if (!isWithin(canonicalRoot, canonicalTarget)) {
        return blockReason(target);
      }
      if (isHyperframesPath(canonicalRoot, canonicalTarget)) {
        return "The .hyperframes directory is reserved for OpenVids state and cannot be accessed.";
      }
    }
  }

  return null;
}

/**
 * Every existing-or-new file inside the project (outside `.hyperframes`) that one `edit`/`write`
 * call could be aimed at, across all the readings {@link pathVariants} considers. Canonical
 * (symlinks resolved) absolute paths; targets the boundary guard rejects are skipped because
 * {@link guardToolCallPaths} already blocks those calls.
 */
export async function resolveProjectFileTargets(
  projectDir: string,
  input: unknown,
): Promise<string[]> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(projectDir);
  } catch {
    return [];
  }
  const resolved = new Set<string>();
  for (const original of extractPathArguments(input)) {
    for (const variant of pathVariants(original.trim())) {
      if (!variant) continue;
      for (const absolute of resolveLikeOmp(projectDir, variant) ?? []) {
        let canonical: string;
        try {
          canonical = await realpathWithMissingTail(absolute);
        } catch {
          continue;
        }
        if (!isWithin(canonicalRoot, canonical) || isHyperframesPath(canonicalRoot, canonical)) {
          continue;
        }
        resolved.add(canonical);
      }
    }
  }
  return [...resolved];
}

export function projectRelativeTargets(projectDir: string, input: unknown): string[] {
  const targets: string[] = [];
  const root = path.resolve(projectDir);
  for (const raw of extractPathArguments(input)) {
    const absolute = resolveLikeOmp(root, raw.trim())?.[0];
    if (absolute === undefined || !isWithin(root, absolute) || isHyperframesPath(root, absolute)) {
      continue;
    }
    const relative = path.relative(root, absolute);
    const display = relative ? relative.split(path.sep).join("/") : ".";
    if (!targets.includes(display)) targets.push(display);
    if (targets.length >= DISPLAY_TARGET_LIMIT) break;
  }
  return targets;
}
