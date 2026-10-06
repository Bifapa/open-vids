import { lstat, readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import type { ExtractedFont, ProjectDesignExtraction } from "@hyperframes/agent-protocol";
import { pinWithinProject } from "../helpers/safePath.js";
import { DesignTally, weightsOf } from "./designTally.js";
import {
  isRootSelector,
  parseCss,
  parseDeclarations,
  type CssDeclaration,
  type ParsedCss,
} from "./cssScan.js";
import { googleFamilies } from "./googleFontsLink.js";
import { scanScript, type ScriptFacts } from "./scriptScan.js";

/** The root composition; sub-compositions live under `compositions/`. */
const ROOT_COMPOSITION = "index.html";
const ATTACHED_TOKENS = "design/tokens.css";

/** Bounds, so a huge project cannot stall the server: files read, bytes per file and in total, stylesheets followed. */
const MAX_COMPOSITIONS = 300;
const MAX_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 24_000_000;
const MAX_STYLESHEETS = 60;
const MAX_SCRIPT_CHARS = 400_000;
const MAX_DECLARED_TOKENS = 400;

/** Directory names the composition walk never enters (the attached system, history, renders, vendored code, assets). */
const SKIPPED_DIRS: Readonly<Record<string, true>> = {
  design: true,
  renders: true,
  node_modules: true,
  assets: true,
};

const TAG_ATTRIBUTES =
  /(?:\bstyle|\bdata-font-family|\bdata-font-weight|\bfill|\bstroke|\bstop-color|\bfont-family|\bfont-weight|\bfont-size)\s*=/i;
const ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** Presentation attributes that stand for the CSS property of the same name. */
const PRESENTATION_ATTRIBUTES: Readonly<Record<string, string>> = {
  fill: "fill",
  stroke: "stroke",
  "stop-color": "stop-color",
  "font-family": "font-family",
  "font-weight": "font-weight",
  "font-size": "font-size",
  "data-font-family": "font-family",
  "data-font-weight": "font-weight",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase();
    if (name !== undefined && !attributes.has(name)) {
      attributes.set(name, decodeEntities(match[2] ?? match[3] ?? ""));
    }
  }
  return attributes;
}

interface Stylesheet {
  /** Project-relative folder `url(...)` and `@import` resolve against. */
  dir: string;
  css: ParsedCss;
}

interface LoadedProject {
  files: string[];
  sheets: Stylesheet[];
  groups: CssDeclaration[][];
  script: ScriptFacts;
  google: Map<string, number[]>;
}

async function readCapped(
  projectDir: string,
  path: string,
  budget: { bytes: number },
): Promise<string | null> {
  const abs = pinWithinProject(projectDir, path);
  if (abs === null) return null;
  try {
    const info = await lstat(abs);
    if (
      !info.isFile() ||
      info.size > MAX_FILE_BYTES ||
      budget.bytes + info.size > MAX_TOTAL_BYTES
    ) {
      return null;
    }
    budget.bytes += info.size;
    return await readFile(abs, "utf-8");
  } catch {
    return null;
  }
}

async function compositionFiles(projectDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(projectDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (found.length >= MAX_COMPOSITIONS) return;
      const child = posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && SKIPPED_DIRS[entry.name] !== true) await walk(child);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) found.push(child);
    }
  };
  await walk("compositions");
  const root = await lstat(join(projectDir, ROOT_COMPOSITION)).then(
    (info) => info.isFile(),
    () => false,
  );
  return root ? [ROOT_COMPOSITION, ...found] : found;
}

/** A project-relative path for a relative reference, or null for a remote, absolute or data reference. */
function localReference(dir: string, reference: string): string | null {
  const clean = reference.trim().split(/[?#]/)[0] ?? "";
  if (clean === "" || /^([a-z][a-z0-9+.-]*:|\/)/i.test(clean)) return null;
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // Keep the raw text.
  }
  const joined = posix.normalize(posix.join(dir, decoded));
  return joined.startsWith("..") ? null : joined;
}

function mergeGoogle(target: Map<string, number[]>, families: Map<string, number[]>): void {
  for (const [family, weights] of families) {
    target.set(family, [...new Set([...(target.get(family) ?? []), ...weights])]);
  }
}

function addPageFacts(html: string, file: string, loaded: LoadedProject, links: string[]): void {
  const dir = posix.dirname(file);
  const page = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const style of page.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const css = parseCss(style[1] ?? "");
    loaded.sheets.push({ dir, css });
    for (const target of css.imports) links.push(`${dir}\0${target}`);
  }
  for (const script of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = attributesOf(script[1] ?? "").get("type") ?? "";
    const body = script[2] ?? "";
    if (body.length === 0 || body.length > MAX_SCRIPT_CHARS) continue;
    if (type === "" || /javascript|module/i.test(type)) scanScript(body, loaded.script);
  }
  const markup = page.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ");
  for (const tag of markup.matchAll(/<([a-zA-Z][\w:-]*)\b([^>]*)>/g)) {
    const text = tag[2] ?? "";
    if (tag[1]?.toLowerCase() === "link") {
      const attributes = attributesOf(text);
      const href = attributes.get("href");
      if (href === undefined) continue;
      mergeGoogle(loaded.google, googleFamilies(href));
      if (/\bstylesheet\b/i.test(attributes.get("rel") ?? "")) links.push(`${dir}\0${href}`);
    } else if (TAG_ATTRIBUTES.test(text)) {
      const group: CssDeclaration[] = [];
      const attributes = attributesOf(text);
      for (const [name, property] of Object.entries(PRESENTATION_ATTRIBUTES)) {
        const value = attributes.get(name);
        if (value !== undefined && value.trim() !== "") group.push({ property, value });
      }
      group.push(...parseDeclarations(attributes.get("style") ?? ""));
      if (group.length > 0) loaded.groups.push(group);
    }
  }
}

/** Reads the compositions and every local stylesheet they link or import (bounded), plus an attached `design/tokens.css`. */
async function loadProject(projectDir: string): Promise<LoadedProject> {
  const loaded: LoadedProject = {
    files: [],
    sheets: [],
    groups: [],
    script: { groups: [], easings: [], durations: [] },
    google: new Map(),
  };
  const budget = { bytes: 0 };
  const queue: string[] = [];
  const seen = new Set<string>();
  const tokens = await readCapped(projectDir, ATTACHED_TOKENS, budget);
  if (tokens !== null) {
    seen.add(ATTACHED_TOKENS);
    const css = parseCss(tokens);
    loaded.sheets.push({ dir: "design", css });
  }
  for (const file of await compositionFiles(projectDir)) {
    const html = await readCapped(projectDir, file, budget);
    if (html === null) continue;
    loaded.files.push(file);
    addPageFacts(html, file, loaded, queue);
  }
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [dir = "", reference = ""] = next.split("\0");
    const remote = googleFamilies(reference);
    if (remote.size > 0) mergeGoogle(loaded.google, remote);
    const path = localReference(dir, reference);
    if (path === null || seen.has(path) || seen.size >= MAX_STYLESHEETS) continue;
    seen.add(path);
    const source = await readCapped(projectDir, path, budget);
    if (source === null) continue;
    const css = parseCss(source);
    loaded.sheets.push({ dir: posix.dirname(path), css });
    for (const target of css.imports) queue.push(`${posix.dirname(path)}\0${target}`);
  }
  return loaded;
}

/** Custom properties: `:root`/`html` ones beat the rest, later beat earlier (an attached system comes first). */
function customProperties(sheets: readonly Stylesheet[]): {
  vars: Map<string, string>;
  declared: Record<string, string>;
} {
  const vars = new Map<string, string>();
  const rootVars = new Map<string, string>();
  for (const { css } of sheets) {
    for (const rule of css.rules) {
      const root = isRootSelector(rule.selector);
      for (const declaration of rule.declarations) {
        if (!declaration.property.startsWith("--")) continue;
        if (root) rootVars.set(declaration.property, declaration.value);
        else vars.set(declaration.property, declaration.value);
      }
    }
  }
  for (const [name, value] of rootVars) vars.set(name, value);
  const declared: Record<string, string> = {};
  for (const name of [...rootVars.keys()].sort().slice(0, MAX_DECLARED_TOKENS)) {
    declared[name] = rootVars.get(name) ?? "";
  }
  return { vars, declared };
}

interface FontFaceFacts {
  weights: Set<number>;
  projectPath?: string;
}

async function fontFaces(
  projectDir: string,
  sheets: readonly Stylesheet[],
): Promise<Map<string, FontFaceFacts>> {
  const faces = new Map<string, FontFaceFacts>();
  for (const { dir, css } of sheets) {
    for (const face of css.fontFaces) {
      const family = face
        .find((declaration) => declaration.property === "font-family")
        ?.value.replace(/^["']|["']$/g, "")
        .trim();
      if (!family) continue;
      const key = family.toLowerCase();
      const entry = faces.get(key) ?? { weights: new Set<number>() };
      for (const declaration of face) {
        if (declaration.property === "font-weight") {
          for (const weight of weightsOf(declaration.value)) entry.weights.add(weight);
        }
      }
      const src = face.find((declaration) => declaration.property === "src")?.value ?? "";
      for (const url of src.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
        if (entry.projectPath !== undefined) break;
        const path = localReference(dir, url[1] ?? url[2] ?? url[3] ?? "");
        const abs = path === null ? null : pinWithinProject(projectDir, path);
        if (path === null || abs === null) continue;
        try {
          if ((await lstat(abs)).isFile()) entry.projectPath = path;
        } catch {
          // Not in the project: a remote or missing file.
        }
      }
      faces.set(key, entry);
    }
  }
  return faces;
}

/**
 * What a project's compositions use, counted: colours with their roles, fonts, easings, durations, radii, font sizes,
 * shadows, and the tokens it already declares. Fully deterministic (same files → same answer, ties broken by value),
 * no model. Reads the root composition, `compositions/**`, the local stylesheets they link, inline styles, `<style>`
 * blocks and GSAP call literals; never `design/` (apart from an attached `tokens.css`, read for tokens and fonts),
 * `.hyperframes/`, `renders/`, `node_modules` or `assets/`.
 */
export async function extractProjectDesign(projectDir: string): Promise<ProjectDesignExtraction> {
  const loaded = await loadProject(projectDir);
  const { vars, declared } = customProperties(loaded.sheets);
  const tally = new DesignTally(vars);
  for (const { css } of loaded.sheets) {
    for (const rule of css.rules) tally.addGroup(rule.declarations);
  }
  for (const group of loaded.groups) tally.addGroup(group);
  for (const group of loaded.script.groups) tally.addGroup(group);
  for (const easing of loaded.script.easings) tally.addEasing(easing);
  for (const seconds of loaded.script.durations) tally.addDuration(seconds);

  const faces = await fontFaces(projectDir, loaded.sheets);
  const fonts: ExtractedFont[] = tally.fontList().map((font) => {
    const key = font.family.toLowerCase();
    const face = faces.get(key);
    const google = [...loaded.google].find(([family]) => family.toLowerCase() === key)?.[1];
    const weights = [
      ...new Set([...font.weights, ...(face?.weights ?? []), ...(google ?? [])]),
    ].sort((a, b) => a - b);
    if (face?.projectPath !== undefined) {
      return {
        family: font.family,
        count: font.count,
        weights,
        loading: "project_file",
        projectPath: face.projectPath,
      };
    }
    return {
      family: font.family,
      count: font.count,
      weights,
      loading: google === undefined ? "unresolved" : "google",
    };
  });

  return {
    files: loaded.files,
    colors: tally.colorList(),
    fonts,
    easings: tally.easingList(),
    durations: tally.durationList(),
    radii: tally.radiusList(),
    fontSizes: tally.fontSizeList(),
    shadows: tally.shadowList(),
    declaredTokens: declared,
  };
}

/**
 * {@link extractProjectDesign} for another project of the Projects page (the `external_project` source). A font
 * file that sits in that project cannot be copied into the library from the open project (the save resolves
 * `projectPath`s in the open project only), so such a font is reported as `unresolved` without its path: the author
 * picks a Google family or a system font for it.
 */
export async function extractExternalProjectDesign(
  projectDir: string,
): Promise<ProjectDesignExtraction> {
  const extraction = await extractProjectDesign(projectDir);
  return {
    ...extraction,
    fonts: extraction.fonts.map(({ projectPath: _projectPath, ...font }) =>
      font.loading === "project_file" ? { ...font, loading: "unresolved" } : font,
    ),
  };
}
