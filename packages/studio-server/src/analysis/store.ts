import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import {
  ANALYSIS_STAGES,
  COMPUTED_STAGES,
  isRecord,
  type AnalysisStage,
  type ComputedStage,
  type CutPlan,
  type CutPlanSummary,
  type SegmentMap,
  type ShotMap,
  type SilenceMap,
  type SourceFingerprint,
  type SpeakerMap,
  type StageState,
  type TakeAnalysis,
  type TranscriptArtifact,
  type VisionAnalysis,
} from "@hyperframes/agent-protocol";
import { resolveWithinProject } from "../helpers/safePath.js";
import { AnalysisFailure } from "./errors.js";
import { artifactVersion } from "./version.js";

/** Where a project keeps its analysis; outside project history (the watcher and history skip `.hyperframes/`). */
export const ANALYSIS_DIR = ".hyperframes/analysis";

// ── Manifest ─────────────────────────────────────────────────────────────────

export type StageParams = Record<string, string | number | boolean | null>;

export interface StageRecord {
  /** `sha256:<hex>` of the stored artifact. */
  version: string;
  createdAt: number;
  /** Versions of what this was computed from (`null`: the input did not exist then). Keys: stage names and `asr`. */
  inputs: Record<string, string | null>;
  params: StageParams;
  /** Which engine produced it, when it is not deterministic ffmpeg work. */
  producer: string | null;
  detail: string | null;
  /** The method that made it (`STAGE_RECIPES`); absent for agent-written artifacts and for those stored before recipes. */
  recipe?: string;
}

/** Why a stage has no artifact even though it was tried. `unavailable` is retried on the next analysis. */
export interface StageProblem {
  status: "failed" | "unavailable";
  detail: string;
  at: number;
}

export interface SourceManifest {
  schema: 1;
  path: string;
  fingerprint: SourceFingerprint;
  stages: Partial<Record<AnalysisStage, StageRecord>>;
  /** The raw recognizer words (`asr.json`); lets speakers and the transcript be rebuilt without recognizing again. */
  asr: StageRecord | null;
  problems: Partial<Record<ComputedStage, StageProblem>>;
}

export interface StageArtifacts {
  transcript: TranscriptArtifact;
  speakers: SpeakerMap;
  silence: SilenceMap;
  shots: ShotMap;
  takes: TakeAnalysis;
  segments: SegmentMap;
  vision: VisionAnalysis;
}

/** The recognizer's words as stored in `asr.json`. */
export interface AsrArtifact {
  language: string | null;
  producer: string;
  words: Array<{ text: string; start: number; end: number }>;
}

// ── Stage graph ──────────────────────────────────────────────────────────────

/** Dependencies first: the order a job runs stages in and freshness is judged in. */
export const STAGE_ORDER = [
  "silence",
  "speakers",
  "shots",
  "transcript",
  "takes",
  "segments",
  "vision",
] as const satisfies readonly AnalysisStage[];

type InputKey = AnalysisStage | "asr";

interface StageInputs {
  /** The stage cannot be computed without these. */
  requires: readonly AnalysisStage[];
  /** Read when they exist; a change of theirs (or their appearing) makes this stage stale. */
  uses: readonly AnalysisStage[];
  /** Built from the raw recognizer words. */
  asr: boolean;
}

export const STAGE_INPUTS: Record<AnalysisStage, StageInputs> = {
  silence: { requires: [], uses: [], asr: false },
  speakers: { requires: [], uses: [], asr: false },
  shots: { requires: [], uses: [], asr: false },
  transcript: { requires: [], uses: ["speakers"], asr: true },
  takes: { requires: ["transcript"], uses: ["silence", "shots"], asr: false },
  segments: { requires: ["transcript"], uses: ["silence", "speakers"], asr: false },
  vision: { requires: [], uses: [], asr: false },
};

/**
 * How each stage is computed, as `<method>/<revision>`. Recorded with every artifact; one whose recorded recipe differs
 * from the one here was made by an older method and is stale, so improved heuristics never leave old results "fresh".
 * Bump the revision whenever a stage's algorithm changes what it produces. Recognizing speech is not a stage recipe:
 * `asr.json` is keyed by the source and the recognizer request (language), and a new transcript recipe rebuilds from it.
 */
export const STAGE_RECIPES: Record<ComputedStage, string> = {
  silence: "adaptive-rms/1",
  speakers: "diarization-merge/2",
  shots: "scene+black+freeze/2",
  transcript: "sentences/2",
  takes: "takes/2",
  segments: "draft/2",
};

/** The recipe a stage's artifact is stamped with; none for agent-written ones (semantic segments) and agent notes (vision). */
function recipeOf(stage: ArtifactName, written: { params?: StageParams }): string | undefined {
  if (stage === "asr" || !isComputedStage(stage)) return undefined;
  return stage === "segments" && written.params?.origin === "semantic"
    ? undefined
    : STAGE_RECIPES[stage];
}

export function isComputedStage(stage: AnalysisStage): stage is ComputedStage {
  return COMPUTED_STAGES.some((computed) => computed === stage);
}

/** Segments an agent wrote depend on the transcript alone: they outlive a changed pause map. */
function inputKeys(stage: AnalysisStage, record: StageRecord): InputKey[] {
  const spec = STAGE_INPUTS[stage];
  if (stage === "segments" && record.params.origin === "semantic") return ["transcript"];
  return [...(spec.asr ? (["asr"] as const) : []), ...spec.requires, ...spec.uses];
}

/** The state of every stage of one source: stored artifacts judged against the source bytes and each other. */
export function evaluateStages(manifest: SourceManifest | null, changed: boolean): StageState[] {
  const fresh: Partial<Record<AnalysisStage, true>> = {};
  const states: StageState[] = [];
  for (const stage of STAGE_ORDER) {
    const record = manifest?.stages[stage];
    const problem = isComputedStage(stage) ? manifest?.problems[stage] : undefined;
    if (!manifest || !record) {
      states.push({
        stage,
        status: problem?.status ?? "missing",
        updatedAt: problem?.at ?? null,
        version: null,
        detail: problem?.detail ?? null,
      });
      continue;
    }
    let stale: string | null = changed ? "the source file changed since it was analysed" : null;
    if (!stale && record.recipe !== recipeOf(stage, record)) stale = "analysis method updated";
    for (const key of stale ? [] : inputKeys(stage, record)) {
      const current =
        key === "asr" ? (manifest.asr?.version ?? null) : (manifest.stages[key]?.version ?? null);
      if (key !== "asr" && current !== null && !fresh[key]) stale = `${key} is stale`;
      else if (current !== (record.inputs[key] ?? null))
        stale = `${key} changed since this was computed`;
      if (stale) break;
    }
    if (!stale) fresh[stage] = true;
    states.push({
      stage,
      status: stale ? "stale" : "fresh",
      updatedAt: record.createdAt,
      version: record.version,
      detail: stale ?? record.detail,
    });
  }
  return ANALYSIS_STAGES.flatMap((stage) => states.filter((state) => state.stage === stage));
}

// ── Guards ───────────────────────────────────────────────────────────────────

function hasSource(value: unknown): value is Record<string, unknown> & { source: string } {
  return isRecord(value) && typeof value.source === "string";
}

export function isTranscript(value: unknown): value is TranscriptArtifact {
  return hasSource(value) && Array.isArray(value.words) && Array.isArray(value.sentences);
}
export function isSpeakerMap(value: unknown): value is SpeakerMap {
  return hasSource(value) && Array.isArray(value.speakers) && Array.isArray(value.turns);
}
export function isSilenceMap(value: unknown): value is SilenceMap {
  return hasSource(value) && Array.isArray(value.silences);
}
export function isShotMap(value: unknown): value is ShotMap {
  return hasSource(value) && Array.isArray(value.shots) && Array.isArray(value.problems);
}
export function isTakeAnalysis(value: unknown): value is TakeAnalysis {
  return hasSource(value) && Array.isArray(value.issues);
}
export function isSegmentMap(value: unknown): value is SegmentMap {
  return (
    hasSource(value) &&
    Array.isArray(value.segments) &&
    typeof value.transcriptVersion === "string" &&
    (value.origin === "draft" || value.origin === "semantic")
  );
}
export function isVisionAnalysis(value: unknown): value is VisionAnalysis {
  return hasSource(value) && Array.isArray(value.notes) && Array.isArray(value.inspectedFrames);
}
export function isAsrArtifact(value: unknown): value is AsrArtifact {
  return isRecord(value) && Array.isArray(value.words) && typeof value.producer === "string";
}

function isFingerprint(value: unknown): value is SourceFingerprint {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.bytes === "number" &&
    typeof value.mtimeMs === "number" &&
    typeof value.hash === "string"
  );
}

function isManifest(value: unknown): value is SourceManifest {
  return (
    isRecord(value) &&
    value.schema === 1 &&
    typeof value.path === "string" &&
    isFingerprint(value.fingerprint) &&
    isRecord(value.stages) &&
    isRecord(value.problems)
  );
}

function isCutPlan(value: unknown): value is CutPlan {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    Array.isArray(value.ranges)
  );
}

interface CutIndex {
  /** The number the next plan gets. */
  next: number;
  plans: CutPlanSummary[];
}

function isCutIndex(value: unknown): value is CutIndex {
  return isRecord(value) && typeof value.next === "number" && Array.isArray(value.plans);
}

// ── Files ────────────────────────────────────────────────────────────────────

/** Serializes read-modify-write cycles on the same file group; the analysis is single-process per project. */
const chains = new Map<string, Promise<unknown>>();

export function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(task, task);
  const settled = run.catch(() => undefined);
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}

async function readJson(file: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf-8"));
    return parsed;
  } catch {
    return undefined;
  }
}

/** Human-readable JSON, replaced atomically so a reader (or a crash) never sees half a file. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Every stored file of one source, in the order `adopt` rebuilds them. */
export type ArtifactName = AnalysisStage | "asr";

export interface CommitMeta {
  inputs?: Record<string, string | null>;
  params?: StageParams;
  producer?: string | null;
  detail?: string | null;
}

/**
 * The project's analysis directory: one folder per source under `sources/`, plus the project's cut plans.
 * Artifacts are separate JSON files; the manifest records which version of each was made from which inputs.
 */
export class AnalysisStore {
  private readonly root: string;

  constructor(readonly projectDir: string) {
    this.root = join(projectDir, ANALYSIS_DIR);
  }

  /** A path under the analysis directory, checked to stay inside the project. */
  private inside(...parts: string[]): string {
    const relative = posix.join(ANALYSIS_DIR, ...parts);
    const abs = resolveWithinProject(this.projectDir, relative);
    if (!abs) throw new AnalysisFailure("failed", `Analysis path escapes the project: ${relative}`);
    return abs;
  }

  static keyOf(path: string): string {
    return createHash("sha1").update(path).digest("hex").slice(0, 16);
  }

  sourceDir(path: string): string {
    return this.inside("sources", AnalysisStore.keyOf(path));
  }

  /** Runs `task` while no other cycle of this source's files runs. Not re-entrant. */
  locked<T>(path: string, task: () => Promise<T>): Promise<T> {
    return serialized(`${this.root}\0${AnalysisStore.keyOf(path)}`, task);
  }

  // Manifest

  async readManifest(path: string): Promise<SourceManifest | null> {
    const value = await readJson(join(this.sourceDir(path), "manifest.json"));
    return isManifest(value) && value.path === path ? value : null;
  }

  async writeManifest(manifest: SourceManifest): Promise<void> {
    await writeJson(join(this.sourceDir(manifest.path), "manifest.json"), manifest);
  }

  /** Read-modify-write of the manifest under the source lock; the callback may return a replacement. */
  updateManifest(
    path: string,
    change: (manifest: SourceManifest) => SourceManifest | void,
  ): Promise<SourceManifest> {
    return this.locked(path, async () => {
      const manifest = await this.readManifest(path);
      if (!manifest) throw new AnalysisFailure("not_analyzed", `${path} has not been analysed yet`);
      const next = change(manifest) ?? manifest;
      await this.writeManifest(next);
      return next;
    });
  }

  /** Forgets everything about a source: artifacts, frames, agent notes. */
  async wipeSource(path: string): Promise<void> {
    await rm(this.sourceDir(path), { recursive: true, force: true });
  }

  /** Starts a source's folder over with only a fingerprint. */
  createSource(fingerprint: SourceFingerprint): Promise<SourceManifest> {
    return this.locked(fingerprint.path, async () => {
      await this.wipeSource(fingerprint.path);
      const manifest: SourceManifest = {
        schema: 1,
        path: fingerprint.path,
        fingerprint,
        stages: {},
        asr: null,
        problems: {},
      };
      await this.writeManifest(manifest);
      return manifest;
    });
  }

  // Artifacts

  private artifactFile(path: string, name: ArtifactName): string {
    return join(this.sourceDir(path), `${name}.json`);
  }

  /** The stored artifact when it exists and still is the version the manifest recorded (no hand edit, no torn write). */
  async readArtifact<T>(
    manifest: SourceManifest,
    name: ArtifactName,
    guard: (value: unknown) => value is T,
  ): Promise<T | null> {
    const record = name === "asr" ? manifest.asr : manifest.stages[name];
    if (!record) return null;
    const value = await readJson(this.artifactFile(manifest.path, name));
    if (!guard(value) || artifactVersion(value) !== record.version) return null;
    return value;
  }

  private async write(
    manifest: SourceManifest,
    name: ArtifactName,
    artifact: unknown,
    meta: CommitMeta,
  ): Promise<StageRecord> {
    const record: StageRecord = {
      version: artifactVersion(artifact),
      createdAt: Date.now(),
      inputs: meta.inputs ?? {},
      params: meta.params ?? {},
      producer: meta.producer ?? null,
      recipe: recipeOf(name, meta),
      detail: meta.detail ?? null,
    };
    await writeJson(this.artifactFile(manifest.path, name), artifact);
    if (name === "asr") manifest.asr = record;
    else {
      manifest.stages[name] = record;
      if (isComputedStage(name)) delete manifest.problems[name];
    }
    await this.writeManifest(manifest);
    return record;
  }

  /** Writes an artifact and its manifest record together. */
  commit(
    path: string,
    name: ArtifactName,
    artifact: unknown,
    meta: CommitMeta = {},
  ): Promise<StageRecord> {
    return this.locked(path, async () => {
      const manifest = await this.readManifest(path);
      if (!manifest) throw new AnalysisFailure("not_analyzed", `${path} has not been analysed yet`);
      return this.write(manifest, name, artifact, meta);
    });
  }

  /**
   * Reads an artifact, lets `change` produce its replacement and writes that, all under the source lock so two callers
   * (a frame grab and a note save) cannot overwrite each other. `change` returns null to leave things as they are.
   */
  modify<T>(
    path: string,
    name: ArtifactName,
    guard: (value: unknown) => value is T,
    change: (
      current: T | null,
      manifest: SourceManifest,
    ) => Promise<{ artifact: T; meta?: CommitMeta } | null>,
  ): Promise<StageRecord | null> {
    return this.locked(path, async () => {
      const manifest = await this.readManifest(path);
      if (!manifest) throw new AnalysisFailure("not_analyzed", `${path} has not been analysed yet`);
      const next = await change(await this.readArtifact(manifest, name, guard), manifest);
      return next ? this.write(manifest, name, next.artifact, next.meta ?? {}) : null;
    });
  }

  /** Notes why a stage has no artifact (`null` clears the note). */
  async setProblem(
    path: string,
    stage: ComputedStage,
    problem: Omit<StageProblem, "at"> | null,
  ): Promise<void> {
    await this.updateManifest(path, (manifest) => {
      if (problem) manifest.problems[stage] = { ...problem, at: Date.now() };
      else delete manifest.problems[stage];
    });
  }

  // Frames

  framesDir(path: string): string {
    return join(this.sourceDir(path), "frames");
  }

  // Renamed or copied files

  /** Another source with the same content (same size and sampled hash) that was analysed, newest first. */
  async findTwin(path: string, fingerprint: SourceFingerprint): Promise<SourceManifest | null> {
    const dir = this.inside("sources");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }
    let best: SourceManifest | null = null;
    for (const name of names) {
      const manifest = await readJson(join(dir, name, "manifest.json"));
      if (!isManifest(manifest) || manifest.path === path) continue;
      if (manifest.fingerprint.hash !== fingerprint.hash) continue;
      if (manifest.fingerprint.bytes !== fingerprint.bytes) continue;
      if (Object.keys(manifest.stages).length === 0 && !manifest.asr) continue;
      if (!best || newest(manifest) > newest(best)) best = manifest;
    }
    return best;
  }

  /**
   * Starts `fingerprint.path` from a twin's artifacts. Every artifact names its source, so each is rewritten for the
   * new path and gets the version of what it now is; recorded inputs are remapped to those versions.
   */
  adopt(twin: SourceManifest, fingerprint: SourceFingerprint): Promise<SourceManifest> {
    const path = fingerprint.path;
    return this.locked(path, async () => {
      await this.wipeSource(path);
      const versions = new Map<string, string>();
      const manifest: SourceManifest = {
        schema: 1,
        path,
        fingerprint: { ...fingerprint, duration: twin.fingerprint.duration },
        stages: {},
        asr: null,
        problems: {},
      };
      const asr = await readJson(this.artifactFile(twin.path, "asr"));
      if (twin.asr && isAsrArtifact(asr) && artifactVersion(asr) === twin.asr.version) {
        await writeJson(this.artifactFile(path, "asr"), asr);
        manifest.asr = twin.asr;
      }
      for (const stage of STAGE_ORDER) {
        const record = twin.stages[stage];
        const stored = record ? await readJson(this.artifactFile(twin.path, stage)) : undefined;
        if (!record || !hasSource(stored) || artifactVersion(stored) !== record.version) continue;
        const moved: Record<string, unknown> = { ...stored, source: path };
        if (stage === "segments") {
          const old = moved.transcriptVersion;
          const now = typeof old === "string" ? versions.get(old) : undefined;
          if (now === undefined) continue;
          moved.transcriptVersion = now;
        }
        const version = artifactVersion(moved);
        versions.set(record.version, version);
        const inputs: Record<string, string | null> = {};
        for (const [key, old] of Object.entries(record.inputs)) {
          inputs[key] = old === null || key === "asr" ? old : (versions.get(old) ?? old);
        }
        await writeJson(this.artifactFile(path, stage), moved);
        manifest.stages[stage] = { ...record, version, inputs };
      }
      await cp(this.framesDir(twin.path), this.framesDir(path), { recursive: true }).catch(
        () => undefined,
      );
      await this.writeManifest(manifest);
      return manifest;
    });
  }

  // Cut plans

  private cutsFile(name: string): string {
    return this.inside("cuts", name);
  }

  private async readCutIndex(): Promise<CutIndex> {
    const value = await readJson(this.cutsFile("index.json"));
    return isCutIndex(value) ? value : { next: 1, plans: [] };
  }

  /** Every plan's summary, oldest first. */
  async listCuts(): Promise<CutPlanSummary[]> {
    return (await this.readCutIndex()).plans;
  }

  async readCut(id: string): Promise<CutPlan | null> {
    if (!/^cut-[1-9][0-9]*$/.test(id)) return null;
    const value = await readJson(this.cutsFile(`${id}.json`));
    return isCutPlan(value) ? value : null;
  }

  /** Plans a new cut under the project's cut lock: `build` receives the id it will be stored as. */
  createCut(build: (id: string) => Promise<CutPlan>): Promise<CutPlan> {
    return serialized(`${this.root}\0cuts`, async () => {
      const index = await this.readCutIndex();
      const plan = await build(`cut-${index.next}`);
      await writeJson(this.cutsFile(`${plan.id}.json`), plan);
      await writeJson(this.cutsFile("index.json"), {
        next: index.next + 1,
        plans: [...index.plans, summaryOf(plan)],
      } satisfies CutIndex);
      return plan;
    });
  }

  /** Deletes the plans `drop` names. The id counter stays where it is: ids are never reused. Returns the ids removed. */
  dropCuts(drop: (plan: CutPlanSummary) => boolean): Promise<string[]> {
    return serialized(`${this.root}\0cuts`, async () => {
      const index = await this.readCutIndex();
      const gone = index.plans.filter(drop);
      if (gone.length === 0) return [];
      await writeJson(this.cutsFile("index.json"), {
        next: index.next,
        plans: index.plans.filter((entry) => !gone.includes(entry)),
      } satisfies CutIndex);
      await Promise.all(gone.map((plan) => rm(this.cutsFile(`${plan.id}.json`), { force: true })));
      return gone.map((plan) => plan.id);
    });
  }

  // Orphans

  /** Every source folder's manifest (unreadable folders are skipped). */
  async listManifests(): Promise<SourceManifest[]> {
    const dir = this.inside("sources");
    const names = await readdir(dir).catch(() => []);
    const manifests: SourceManifest[] = [];
    for (const name of names) {
      const manifest = await readJson(join(dir, name, "manifest.json"));
      if (isManifest(manifest)) manifests.push(manifest);
    }
    return manifests;
  }
}

function newest(manifest: SourceManifest): number {
  return Math.max(0, ...Object.values(manifest.stages).map((record) => record.createdAt));
}

export function summaryOf(plan: CutPlan): CutPlanSummary {
  return {
    id: plan.id,
    source: plan.source,
    label: plan.label,
    createdAt: plan.createdAt,
    basedOn: plan.basedOn,
    stats: plan.stats,
    applied: plan.applied,
  };
}
