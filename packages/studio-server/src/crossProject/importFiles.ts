import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type AssetProvenance,
  type ImportFromProjectRequest,
  type ImportFromProjectResult,
  type ImportedProjectFile,
  type ProjectFilePart,
} from "@hyperframes/agent-protocol";
import { assetKindOf } from "../editing/mediaFacts.js";
import { isInHiddenOrVendorDir, pinWithinProject, walkDir } from "../helpers/safePath.js";
import { agentIdOf } from "../research/agents.js";
import { ResearchCache } from "../research/cache.js";
import { ResearchFailure, isResearchFailure } from "../research/errors.js";
import { readLedger, writeLedger } from "../research/provenance.js";
import type { RequestGuard } from "../research/requestRegistry.js";
import type { ResolvedProject } from "../types.js";
import type { ProjectFile } from "./projectFiles.js";

/** Where imported files land: one folder per source project. */
export const IMPORT_ASSET_DIR = "assets/from";

const MB = 1024 * 1024;
/** Largest file one import copies, per part (the same ceilings as a research import of that media kind). */
const MAX_BYTES: Record<ProjectFilePart, number> = {
  renders: 600 * MB,
  video: 600 * MB,
  music: 120 * MB,
  audio: 120 * MB,
  images: 60 * MB,
};

export interface ImportOptions {
  project: ResolvedProject;
  /** The source project: its name (recorded in the provenance) and its real folder. */
  other: { name: string; root: string };
  request: ImportFromProjectRequest;
  /** Every file the source project offers (`scanProjectFiles`): only these can be imported. */
  offered: ProjectFile[];
  guard: RequestGuard;
  now: () => number;
}

interface Copy {
  file: ProjectFile;
  scratchFile: string;
  sha256: string;
  bytes: number;
}

/** A project name as a folder name: `My Video #2` → `my-video-2`. */
export function projectSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "project";
}

/** A file name safe on every platform: letters, digits, `.`, `_`, `-`; never hidden. */
function safeFileName(path: string): { stem: string; ext: string } {
  const ext = posix
    .extname(path)
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "");
  const stem = posix
    .basename(path, posix.extname(path))
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return { stem: stem || "file", ext };
}

class TooLarge extends Error {}

/** Copies a file to `target` while hashing it; stops with `TooLarge` past `maxBytes` and when `signal` aborts. */
async function copyHashed(
  source: string,
  target: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += data.length;
      if (bytes > maxBytes) {
        done(new TooLarge());
        return;
      }
      hash.update(data);
      done(null, data);
    },
  });
  await pipeline(
    createReadStream(source),
    meter,
    createWriteStream(target, { flags: "wx", mode: 0o644 }),
    { signal },
  );
  return { sha256: hash.digest("hex"), bytes };
}

async function sha256Of(file: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) {
    hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return hash.digest("hex");
}

/**
 * The project's own media files whose bytes match one of the copies (a project file with the same size is hashed):
 * hash → project path. Renders and hidden folders are not the project's material.
 */
async function presentFiles(
  projectDir: string,
  sizes: ReadonlySet<number>,
  guard: RequestGuard,
): Promise<Map<string, string>> {
  const present = new Map<string, string>();
  for (const path of walkDir(projectDir)) {
    if (isInHiddenOrVendorDir(path) || path.startsWith("renders/")) continue;
    const kind = assetKindOf(path);
    if (kind !== "video" && kind !== "audio" && kind !== "image") continue;
    const abs = join(projectDir, path);
    try {
      const stat = lstatSync(abs);
      if (!stat.isFile() || !sizes.has(stat.size)) continue;
      guard.assertLive();
      const sha256 = await sha256Of(abs, guard.signal);
      if (!present.has(sha256)) present.set(sha256, path);
    } catch (error) {
      if (isResearchFailure(error) || guard.signal.aborted) throw error;
      // A file that vanished or cannot be read does not hold the bytes.
    }
  }
  return present;
}

/** The first of `name`, `name-<sha8>`, `name-<sha8>-2`, … that is neither on disk nor taken in this import. */
function freePath(
  projectDir: string,
  dir: string,
  file: { stem: string; ext: string },
  sha256: string,
  taken: Set<string>,
): string | null {
  const names = [
    `${file.stem}${file.ext}`,
    `${file.stem}-${sha256.slice(0, 8)}${file.ext}`,
    ...Array.from(
      { length: 50 },
      (_, index) => `${file.stem}-${sha256.slice(0, 8)}-${index + 2}${file.ext}`,
    ),
  ];
  for (const name of names) {
    const path = posix.join(dir, name);
    const key = path.toLowerCase();
    if (taken.has(key)) continue;
    const abs = pinWithinProject(projectDir, path);
    if (!abs) return null;
    // Anything there (even a link or a folder) is a name taken: nothing is ever overwritten.
    if (lstatSync(abs, { throwIfNoEntry: false })) continue;
    taken.add(key);
    return path;
  }
  return null;
}

function newRecordId(taken: ReadonlySet<string>, record: AssetProvenance, asset: string): string {
  if (!taken.has(record.id)) return record.id;
  return `prov-${createHash("sha256").update(`${record.id}\0${asset}`).digest("hex").slice(0, 12)}`;
}

/**
 * Copies the named files of another project into `assets/from/<project>/`, carrying each file's provenance record
 * (license, source and credit line unchanged, plus `importedFrom`). Runs under the project's ledger lock.
 *
 * Sequence: copy (hashing) into a scratch folder inside the project — all the slow, abortable work — then, in one
 * synchronous stretch after `guard.commit()`, move the files into place and write the ledger. A cancel before the
 * commit leaves nothing but the scratch folder, which is removed.
 */
export async function importProjectFiles(options: ImportOptions): Promise<ImportFromProjectResult> {
  const { project, other, request, offered, guard } = options;
  guard.assertLive();
  const byPath = new Map(offered.map((file) => [file.path, file]));
  const skipped: ImportFromProjectResult["skipped"] = [];
  const wanted: Array<{ file: ProjectFile; source: string }> = [];
  for (const path of request.files) {
    const file = byPath.get(path);
    if (!file) {
      skipped.push({ source: path, reason: "not a file of the project" });
      continue;
    }
    if (file.bytes > MAX_BYTES[file.part]) {
      skipped.push({ source: path, reason: "too large to import" });
      continue;
    }
    // Links on the way (resolved now) must not lead out of the source project.
    const source = pinWithinProject(other.root, path);
    if (!source) {
      skipped.push({ source: path, reason: "outside the project" });
      continue;
    }
    wanted.push({ file, source });
  }
  if (wanted.length === 0) return { imported: [], skipped };

  const cache = new ResearchCache(project.dir);
  const scratch = cache.scratchDir(`from-${randomBytes(6).toString("hex")}`);
  try {
    const copies: Copy[] = [];
    for (const [index, { file, source }] of wanted.entries()) {
      guard.assertLive();
      const scratchFile = join(scratch, `${index}.bin`);
      try {
        const copied = await copyHashed(source, scratchFile, MAX_BYTES[file.part], guard.signal);
        copies.push({ file, scratchFile, ...copied });
      } catch (error) {
        if (guard.signal.aborted) throw error;
        if (error instanceof TooLarge) {
          skipped.push({ source: file.path, reason: "too large to import" });
        } else if (error instanceof Error && "code" in error) {
          skipped.push({ source: file.path, reason: "could not be read" });
        } else {
          throw error;
        }
      }
    }
    const present = await presentFiles(
      project.dir,
      new Set(copies.map((copy) => copy.bytes)),
      guard,
    );

    // From here to the end nothing awaits: the plan, the commit and the writes see the same disk.
    guard.assertLive();
    const ledger = readLedger(project.dir);
    const dir = posix.join(IMPORT_ASSET_DIR, projectSlug(other.name));
    const taken = new Set<string>();
    const placed = new Map<string, string>();
    const results: Array<{ copy: Copy; asset: string; fresh: boolean }> = [];
    for (const copy of copies) {
      const known = present.get(copy.sha256) ?? placed.get(copy.sha256);
      if (known !== undefined) {
        results.push({ copy, asset: known, fresh: false });
        continue;
      }
      const asset = freePath(project.dir, dir, safeFileName(copy.file.path), copy.sha256, taken);
      if (asset === null) {
        skipped.push({ source: copy.file.path, reason: "no free name in the project" });
        continue;
      }
      placed.set(copy.sha256, asset);
      results.push({ copy, asset, fresh: true });
    }
    if (!results.some((result) => result.fresh)) {
      return { imported: results.map((result) => describe(result, ledger.records, null)), skipped };
    }

    guard.commit();
    const ids = new Set(ledger.records.map((record) => record.id));
    const written = new Map<string, AssetProvenance>();
    let failure: unknown;
    try {
      for (const { copy, asset, fresh } of results) {
        if (!fresh) continue;
        const target = pinWithinProject(project.dir, asset);
        if (!target)
          throw new ResearchFailure("invalid_request", `${asset} is outside the project`);
        mkdirSync(dirname(target), { recursive: true });
        renameSync(copy.scratchFile, target);
        const record = copy.file.record;
        if (!record) continue;
        const id = newRecordId(ids, record, asset);
        ids.add(id);
        written.set(asset, {
          ...record,
          id,
          asset,
          sha256: copy.sha256,
          bytes: copy.bytes,
          retrievedAt: options.now(),
          retrievedBy: {
            agent: agentIdOf(request.agent) ?? "user",
            turnId: request.turnId ?? null,
            model: request.model ?? null,
          },
          storyNode: null,
          importedFrom: { project: other.name, asset: copy.file.path },
        });
      }
    } catch (error) {
      failure = error;
    }
    // What was moved gets its record even when a later move failed: no file without its license.
    if (written.size > 0) {
      writeLedger(project.dir, {
        schema: ledger.schema,
        records: [
          ...ledger.records.filter((record) => !written.has(record.asset)),
          ...written.values(),
        ],
      });
    }
    if (failure !== undefined) throw failure;
    return {
      imported: results.map((result) => describe(result, ledger.records, written)),
      skipped,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function describe(
  result: { copy: Copy; asset: string; fresh: boolean },
  records: readonly AssetProvenance[],
  written: ReadonlyMap<string, AssetProvenance> | null,
): ImportedProjectFile {
  const { copy, asset, fresh } = result;
  return {
    source: copy.file.path,
    asset,
    bytes: copy.bytes,
    status: fresh ? "copied" : "existing",
    provenance:
      (fresh ? written?.get(asset) : records.find((record) => record.asset === asset)) ?? null,
  };
}
