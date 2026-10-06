import { lstatSync, mkdirSync, readdirSync, rmSync, type Stats } from "node:fs";
import { join } from "node:path";
import {
  DESIGN_REQUIRED_TOKENS,
  isDesignSystemId,
  parseDesignSystemName,
  parseSaveDesignSystemRequest,
  type DesignManifest,
  type DesignSystemDetail,
  type DesignSystemMeta,
  type DesignSystemSummary,
  type DesignVersionInfo,
  type SaveDesignSystemRequest,
  type SaveDesignSystemResult,
} from "@hyperframes/agent-protocol";
import {
  resolveAssets,
  unknownLicenses,
  type FetchFont,
  type ResolveProjectFile,
  type ResolvedAssets,
} from "./assets.js";
import { DesignFailure } from "./errors.js";
import { fetchGoogleFontFaces } from "./googleFonts.js";
import { withLibraryLock } from "./lock.js";
import { parseDesignSystemHtml } from "./parse.js";
import { designLibraryRoot } from "./paths.js";
import { renderDesignSystem } from "./render.js";
import {
  isBehind,
  listSystemFiles,
  materialise,
  readMetaFile,
  readRegular,
  readVersionMeta,
  recoverSystem,
  versionDirOf,
  versionNumbers,
  writeMetaFile,
  writeVersion,
  type StagedFile,
} from "./store.js";
import { validateDesignSystemHtml, validateTokensCss } from "./validate.js";

export interface DesignLibraryDeps {
  /** Downloads a Google Fonts family (default: the network). Tests inject their own. */
  fetchFont?: FetchFont;
  /** Resolves a project-relative file to an absolute one inside that project; null when the project or file is unknown. */
  resolveProjectFile?: ResolveProjectFile;
  /** How long a write waits for another process's write (default 15 s) before failing `busy`. */
  lockWaitMs?: number;
}

const PALETTE_TOKENS = ["--bg", "--fg", "--brand", "--accent", "--accent-2"];

/**
 * The app-wide design-system library (`~/.openvids/design-systems`): every version kept complete under
 * `versions/<n>/`, the current one materialised at the top of each system folder, `meta.json` last. Reads are
 * synchronous and take no lock (they see a complete version or the previous one); every write runs under the
 * cross-process library lock.
 */
export class DesignLibrary {
  readonly root: string;
  private readonly deps: DesignLibraryDeps;

  constructor(root: string = designLibraryRoot(), deps: DesignLibraryDeps = {}) {
    this.root = root;
    this.deps = deps;
  }

  private dirOf(id: string): string {
    return join(this.root, id);
  }

  /** The folder of a system, checked: a valid id, a real folder (a link is refused). Null when there is none. */
  private existingDir(id: string): string | null {
    if (!isDesignSystemId(id)) return null;
    const dir = this.dirOf(id);
    try {
      return lstatSync(dir).isDirectory() ? dir : null;
    } catch {
      return null;
    }
  }

  private metaOrFail(id: string): { dir: string; meta: DesignSystemMeta } {
    const dir = this.existingDir(id);
    const meta = dir === null ? null : readMetaFile(dir, id);
    if (dir === null || meta === null)
      throw new DesignFailure("not_found", `There is no design system "${id}".`);
    return { dir, meta };
  }

  /** Every readable system, newest updated first. Reads `meta.json` only; an unreadable entry is skipped. */
  list(): DesignSystemSummary[] {
    let names: string[];
    try {
      names = readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isDesignSystemId(entry.name))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const metas: DesignSystemMeta[] = [];
    for (const name of names) {
      const meta = readMetaFile(this.dirOf(name), name);
      if (meta) metas.push(meta);
    }
    return metas
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .map((meta) => summaryOf(meta));
  }

  readMeta(id: string): DesignSystemMeta | null {
    const dir = this.existingDir(id);
    return dir === null ? null : readMetaFile(dir, id);
  }

  /** The system with its spec and manifest read back from the saved `system.html` of `version` (default: current). */
  get(id: string, version?: number): DesignSystemDetail {
    const { dir, meta } = this.metaOrFail(id);
    const wanted = version ?? meta.version;
    const versionMeta = wanted === meta.version ? meta : readVersionMeta(dir, wanted);
    const folder = versionDirOf(dir, wanted);
    const html = versionMeta ? readRegular(join(folder, "system.html")) : null;
    if (versionMeta === null || html === null)
      throw new DesignFailure("not_found", `Design system "${id}" has no version ${wanted}.`);
    const { spec, manifest } = parseDesignSystemHtml(html.toString("utf-8"));
    const versions: DesignVersionInfo[] = [];
    for (const number of versionNumbers(dir)) {
      const info = readVersionMeta(dir, number);
      if (info) versions.push({ version: number, createdAt: info.updatedAt, source: info.source });
    }
    const summary = summaryOf({ ...versionMeta, name: meta.name });
    return { ...summary, spec, manifest, versions, files: listSystemFiles(folder) };
  }

  /** The absolute folder of version `version` (default: current): complete and never rewritten. */
  versionDir(id: string, version?: number): string {
    const { dir, meta } = this.metaOrFail(id);
    const wanted = version ?? meta.version;
    if (readVersionMeta(dir, wanted) === null)
      throw new DesignFailure("not_found", `Design system "${id}" has no version ${wanted}.`);
    return versionDirOf(dir, wanted);
  }

  /**
   * The absolute folder holding the current version's files. It is the version's own folder: the same layout as the
   * top level, but complete and immutable, so copying from it cannot meet a half-materialised top level.
   */
  currentDir(id: string): string {
    return this.versionDir(id);
  }

  /** The current version and the files a project copies (`system.html`, `tokens.css`, the logo, `fonts/*`). */
  snapshotFiles(id: string): { version: number; files: string[] } {
    const { meta } = this.metaOrFail(id);
    const folder = this.versionDir(id, meta.version);
    return {
      version: meta.version,
      files: listSystemFiles(folder).filter((file) => file !== "thumbnail.svg"),
    };
  }

  /** Re-materialises every system whose top level is behind its versions (a crashed save), under the lock. */
  async heal(): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isDesignSystemId(entry.name))
        .map((entry) => entry.name);
    } catch {
      return;
    }
    const behind = names.filter((name) => isBehind(this.dirOf(name), name));
    if (behind.length === 0) return;
    await this.write(() => {
      for (const name of behind) recoverSystem(this.dirOf(name), name);
    });
  }

  private write<T>(work: () => Promise<T> | T): Promise<T> {
    return withLibraryLock(this.root, work, this.deps.lockWaitMs);
  }

  /**
   * Creates the system (`baseVersion` absent, the id free) or saves a new version (`baseVersion` = the current one;
   * anything else is a `conflict`). The spec is rendered, validated, its fonts and logo resolved to files, the version
   * written complete, then the top level switched to it.
   */
  async save(id: string, request: SaveDesignSystemRequest): Promise<SaveDesignSystemResult> {
    if (!isDesignSystemId(id))
      throw new DesignFailure("invalid_request", `"${id}" is not a design system id.`);
    const parsed = parseSaveDesignSystemRequest(request);
    if (!parsed.ok) throw new DesignFailure(parsed.error.code, parsed.error.message);
    const { name, source, spec, baseVersion, projectId } = parsed.value;
    const missing = DESIGN_REQUIRED_TOKENS.filter((token) => spec.tokens[token] === undefined);
    if (missing.length > 0)
      throw new DesignFailure(
        "invalid_system",
        "The spec misses required tokens.",
        missing.map((token) => `missing required token ${token}`),
      );

    // Network and project reads happen before the lock, so a slow download never holds the library.
    const base = baseVersion === undefined ? null : this.manifestOf(id, baseVersion);
    const assets = await resolveAssets(spec, {
      fetchFont:
        this.deps.fetchFont ??
        ((family, weights, italic) => fetchGoogleFontFaces(family, weights, italic)),
      resolveProjectFile: this.deps.resolveProjectFile,
      projectId,
      base,
    });
    return this.write(() => this.commit(id, { name, source, spec, baseVersion }, assets));
  }

  /** The manifest of a saved version, or null when there is none (the save then fails on `baseVersion` under the lock). */
  private manifestOf(id: string, version: number): DesignManifest | null {
    const dir = this.existingDir(id);
    if (dir === null) return null;
    const html = readRegular(join(versionDirOf(dir, version), "system.html"));
    if (html === null) return null;
    try {
      return parseDesignSystemHtml(html.toString("utf-8")).manifest;
    } catch {
      return null;
    }
  }

  private commit(
    id: string,
    request: Pick<SaveDesignSystemRequest, "name" | "source" | "spec" | "baseVersion">,
    assets: ResolvedAssets,
  ): SaveDesignSystemResult {
    const { name, source, spec, baseVersion } = request;
    mkdirSync(this.root, { recursive: true });
    const dir = this.dirOf(id);
    if (this.existingDir(id) === null && lstatOrNull(dir) !== null)
      throw new DesignFailure("invalid_request", `"${id}" is not a design system folder.`);
    recoverSystem(dir, id);
    const current = readMetaFile(dir, id);
    if (baseVersion === undefined) {
      if (current)
        throw new DesignFailure(
          "conflict",
          `A design system "${id}" already exists; pass its baseVersion to save a new version.`,
        );
    } else {
      if (!current) throw new DesignFailure("not_found", `There is no design system "${id}".`);
      if (current.version !== baseVersion)
        throw new DesignFailure(
          "conflict",
          `Design system "${id}" is at version ${current.version}, not ${baseVersion}: read it again and redo the change.`,
        );
    }
    const version = Math.max(current?.version ?? 0, versionNumbers(dir)[0] ?? 0) + 1;
    const now = Date.now();

    const rendered = renderDesignSystem({
      spec,
      fonts: assets.fonts,
      logo: assets.logo,
      version,
      source,
    });
    const staged = new Map<string, StagedFile>();
    const stage = (path: string, data: StagedFile["data"]): void => {
      if (!staged.has(path)) staged.set(path, { path, data });
    };
    stage("system.html", rendered.systemHtml);
    stage("tokens.css", rendered.tokensCss);
    stage("thumbnail.svg", rendered.thumbnailSvg);
    for (const blob of assets.blobs) stage(blob.path, blob.data);
    const issues = [
      ...validateDesignSystemHtml(rendered.systemHtml, {
        expectedVersion: version,
        fileExists: (path) => staged.has(path),
      }),
      ...validateTokensCss(rendered.tokensCss),
    ];
    if (issues.length > 0)
      throw new DesignFailure("invalid_system", "The design system breaks the format.", issues);

    const meta: DesignSystemMeta = {
      schema: "openvids.design-system-meta/1",
      id,
      name,
      version,
      source,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      palette: PALETTE_TOKENS.map((token) => spec.tokens[token]).filter(
        (value): value is string => value !== undefined,
      ),
      displayFont: assets.fonts.find((font) => font.role === "display")?.family ?? null,
      unknownLicenses: unknownLicenses(assets.fonts, assets.logo),
      nonPortableFonts: assets.fonts.filter((font) => !font.portable).map((font) => font.family),
    };
    const notes = [...assets.notes];
    for (const license of meta.unknownLicenses)
      notes.push(
        `The license of ${license.replace(":", " ")} is unknown: the pre-export license check will warn about it.`,
      );

    writeVersion(
      dir,
      version,
      [...staged.values()],
      meta,
      current ? versionDirOf(dir, current.version) : null,
    );
    materialise(dir, version);
    return { system: summaryOf(meta), notes };
  }

  /** Renames a system (`meta.json` only: no new version, `system.html` carries no name). */
  async rename(id: string, name: string): Promise<DesignSystemSummary> {
    if (!isDesignSystemId(id))
      throw new DesignFailure("invalid_request", `"${id}" is not a design system id.`);
    const clean = parseDesignSystemName(name);
    if (clean === null)
      throw new DesignFailure("invalid_request", "The name must be 1 to 80 plain characters.");
    return this.write(() => {
      const dir = this.existingDir(id);
      if (dir === null) throw new DesignFailure("not_found", `There is no design system "${id}".`);
      recoverSystem(dir, id);
      const meta = readMetaFile(dir, id);
      if (meta === null) throw new DesignFailure("not_found", `There is no design system "${id}".`);
      const renamed: DesignSystemMeta = { ...meta, name: clean, updatedAt: Date.now() };
      writeMetaFile(dir, renamed);
      return summaryOf(renamed);
    });
  }

  /** Deletes a system with all its versions. Projects that attached it keep their own copy. */
  async delete(id: string): Promise<void> {
    await this.write(() => {
      const dir = this.existingDir(id);
      if (dir === null) throw new DesignFailure("not_found", `There is no design system "${id}".`);
      rmSync(dir, { recursive: true, force: true });
    });
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** The summary part of a meta record (without its schema tag). */
function summaryOf(meta: DesignSystemMeta): DesignSystemSummary {
  const { schema: _schema, ...summary } = meta;
  return summary;
}
