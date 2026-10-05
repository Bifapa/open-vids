import { existsSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import {
  type AssetProvenance,
  type AssetSearchMode,
  type ExportLicenseCheck,
  type ProjectSourceEntry,
  type ProjectSourcesView,
} from "@hyperframes/agent-protocol";
import { MAIN_COMPOSITION } from "../editing/inventory.js";
import { parseComposition } from "../editing/timeline.js";
import { isCompositionSource } from "../helpers/hfIdPersist.js";
import { isInHiddenOrVendorDir, resolveWithinProject, walkDir } from "../helpers/safePath.js";
import { referencedPaths } from "./assetReferences.js";

interface CompositionRefs {
  media: Set<string>;
  hosted: Set<string>;
}

/** Stylesheets read per composition while following `<link>` and `@import`; real projects have one or two. */
const MAX_STYLESHEETS = 20;

/** Project paths a composition's markup references, and those of the local stylesheets it links (transitively). */
function markupReferences(projectDir: string, file: string, html: string): Set<string> {
  const found = referencedPaths(html, posix.dirname(file), false);
  const sheets = [...found].filter((path) => path.toLowerCase().endsWith(".css"));
  const read = new Set<string>();
  for (let next = sheets.shift(); next !== undefined; next = sheets.shift()) {
    if (read.has(next) || read.size >= MAX_STYLESHEETS) continue;
    read.add(next);
    let css: string;
    try {
      css = readFileSync(resolveWithinProject(projectDir, next) ?? "", "utf-8");
    } catch {
      continue;
    }
    for (const path of referencedPaths(css, posix.dirname(next), true)) {
      found.add(path);
      if (path.toLowerCase().endsWith(".css")) sheets.push(path);
    }
  }
  return found;
}

/** What every composition file of the project references directly: media paths and hosted sub-compositions. */
function readReferences(projectDir: string): Map<string, CompositionRefs> {
  const refs = new Map<string, CompositionRefs>();
  for (const file of walkDir(projectDir)) {
    if (!file.endsWith(".html") || isInHiddenOrVendorDir(file) || file.startsWith("renders/"))
      continue;
    let html: string;
    try {
      html = readFileSync(resolveWithinProject(projectDir, file) ?? "", "utf-8");
    } catch {
      continue;
    }
    if (!isCompositionSource(html)) continue;
    const model = parseComposition(html, file);
    if (!model) continue;
    const entry: CompositionRefs = { media: new Set(), hosted: new Set() };
    for (const clip of model.clips) {
      if (clip.src !== null) entry.media.add(clip.src);
      if (clip.compositionSrc !== null) entry.hosted.add(clip.compositionSrc);
    }
    for (const path of markupReferences(projectDir, file, html)) entry.media.add(path);
    refs.set(file, entry);
  }
  return refs;
}

/** Media a composition uses through its own clips and through the sub-compositions it hosts (transitively). */
function mediaOf(refs: Map<string, CompositionRefs>, composition: string): Set<string> {
  const media = new Set<string>();
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const entry = refs.get(path);
    if (!entry) return;
    for (const file of entry.media) media.add(file);
    for (const sub of entry.hosted) visit(sub);
  };
  visit(composition);
  return media;
}

/** The compositions whose timeline uses each asset, directly or through a hosted sub-composition. */
export function assetUsage(projectDir: string, assets: readonly string[]): Map<string, string[]> {
  const refs = readReferences(projectDir);
  const usage = new Map<string, string[]>(assets.map((asset) => [asset, []]));
  const compositions = [...refs.keys()].sort((a, b) =>
    a === MAIN_COMPOSITION ? -1 : b === MAIN_COMPOSITION ? 1 : a.localeCompare(b),
  );
  for (const composition of compositions) {
    const media = mediaOf(refs, composition);
    for (const asset of assets) if (media.has(asset)) usage.get(asset)?.push(composition);
  }
  return usage;
}

/** Whether a composition file exists (export-check refuses a path that is not one). */
export function compositionExists(projectDir: string, composition: string): boolean {
  const abs = resolveWithinProject(projectDir, composition);
  return abs !== null && composition.endsWith(".html") && existsSync(abs) && statSync(abs).isFile();
}

/** Assets one composition uses (see {@link assetUsage}). */
export function assetsUsedBy(projectDir: string, composition: string): Set<string> {
  return mediaOf(readReferences(projectDir), composition);
}

/** What the user should look at for a record. Empty when the license is clear. */
export function licenseIssues(record: AssetProvenance, present: boolean): string[] {
  const issues: string[] = [];
  if (!present) issues.push("The file is no longer in the project");
  if (record.licenseStatus === "unknown") {
    issues.push(
      record.licenseConfidence === "low"
        ? `License only mentioned in text on the page (${record.license}); confirm it on the source page`
        : "License unknown; check the source page before publishing",
    );
  } else if (record.licenseStatus === "restricted") {
    if (record.licenseId === "cc_by_nc_nd") {
      issues.push(`Non-commercial, no-derivatives license (${record.license})`);
    } else if (record.licenseId === "cc_by_nc" || record.licenseId === "cc_by_nc_sa") {
      issues.push(`Non-commercial license (${record.license})`);
    } else if (record.licenseId === "cc_by_nd") {
      issues.push(`No-derivatives license (${record.license})`);
    } else {
      issues.push(`License terms need review (${record.license})`);
    }
  }
  return issues;
}

/** The suggested credit line of a record: “Title” by Author, License, via Source. */
export function attributionLine(input: {
  title: string;
  author: string | null;
  license: string;
  sourceName: string;
}): string {
  const by = input.author ? ` by ${input.author}` : "";
  return `“${input.title}”${by}, ${input.license}, via ${input.sourceName}`;
}

export function sourceEntries(
  projectDir: string,
  records: readonly AssetProvenance[],
): ProjectSourceEntry[] {
  const present = new Map(
    records.map((record) => {
      const abs = resolveWithinProject(projectDir, record.asset);
      return [record.asset, abs !== null && existsSync(abs) && statSync(abs).isFile()] as const;
    }),
  );
  const usage = assetUsage(
    projectDir,
    records.filter((record) => present.get(record.asset)).map((record) => record.asset),
  );
  return records.map((record) => {
    const here = present.get(record.asset) ?? false;
    return {
      ...record,
      present: here,
      usedIn: usage.get(record.asset) ?? [],
      issues: licenseIssues(record, here),
    };
  });
}

export function sourcesView(
  projectDir: string,
  records: readonly AssetProvenance[],
  mode: AssetSearchMode,
): ProjectSourcesView {
  const entries = sourceEntries(projectDir, records);
  const summary: ProjectSourcesView["summary"] = {
    clear: 0,
    attribution: 0,
    restricted: 0,
    unknown: 0,
    total: entries.length,
    missingFiles: entries.filter((entry) => !entry.present).length,
  };
  for (const entry of entries) if (entry.present) summary[entry.licenseStatus] += 1;
  return {
    records: entries,
    summary,
    credits: entries
      .filter(
        (entry) =>
          entry.present &&
          (entry.licenseStatus === "attribution" || entry.licenseStatus === "unknown"),
      )
      .map((entry) => entry.attribution),
    mode,
  };
}

export function exportCheck(
  projectDir: string,
  composition: string,
  records: readonly AssetProvenance[],
): ExportLicenseCheck {
  const used = assetsUsedBy(projectDir, composition);
  const entries = sourceEntries(
    projectDir,
    records.filter((record) => used.has(record.asset)),
  );
  return {
    composition,
    assets: entries,
    warnings: entries
      .filter((entry) => entry.licenseStatus === "unknown" || entry.licenseStatus === "restricted")
      .map((entry) => ({
        asset: entry.asset,
        status: entry.licenseStatus,
        license: entry.license,
        message: `${entry.asset}: ${entry.issues.find((issue) => issue !== "The file is no longer in the project") ?? entry.license}`,
      })),
    credits: entries
      .filter((entry) => entry.licenseStatus === "attribution")
      .map((entry) => entry.attribution),
  };
}
