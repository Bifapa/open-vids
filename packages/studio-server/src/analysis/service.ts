import { isAbsolute, posix, relative } from "node:path";
import { stat } from "node:fs/promises";
import {
  ANALYSIS_STAGES,
  COMPUTED_STAGES,
  type AnalysisJob,
  type AnalysisOverview,
  type AnalysisStage,
  type AnalyzeRequest,
  type AssetRange,
  type CutPlan,
  type CutPlanRequest,
  type CutPlanSummary,
  type FramesRequest,
  type FramesResponse,
  type SaveSegmentsRequest,
  type SaveVisionNotesRequest,
  type SegmentMap,
  type SourceAnalysisStatus,
  type StageState,
  type TakeIssueKind,
  type TranscriptView,
  type VisionAnalysis,
  type VisionNote,
  type SilenceMap,
  type TakeAnalysis,
  type TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import { isInHiddenOrVendorDir, resolveWithinProject, walkDir } from "../helpers/safePath.js";
import { effectiveRange, readAssetRanges } from "../editing/assetRanges.js";
import { assetKindOf, MediaFacts, type MediaProber } from "../editing/mediaFacts.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { readAppliedCuts } from "./appliedCuts.js";
import { mergeCutRequest, planCut } from "./cutPlan.js";
import { AnalysisFailure } from "./errors.js";
import { removeOrphans, type OrphanReport } from "./orphans.js";
import { checkFingerprint } from "./fingerprint.js";
import { grabFrame, readFrameBase64 } from "./frames.js";
import { JobRegistry } from "./jobs.js";
import { semanticSegments } from "./segmentation.js";
import { STAGE_WEIGHTS, planStages, runAnalysis, type SourceInfo } from "./stages.js";
import {
  AnalysisStore,
  evaluateStages,
  isSegmentMap,
  isShotMap,
  isSilenceMap,
  isSpeakerMap,
  isTakeAnalysis,
  isTranscript,
  isVisionAnalysis,
  serialized,
  type SourceManifest,
} from "./store.js";
import { visionTargets } from "./targets.js";

const DEFAULT_FRAME_WIDTH = 512;
/// Note times may not run past the media by more than this (seconds): decoders round the last frame.
const END_TOLERANCE = 0.5;
const LONGEST_SILENCES = 10;
/** Two vision notes over the same range (within this many seconds at both ends) are one note. */
const SAME_RANGE = 0.001;
/** Orphan sweeps of one project run at most this often. */
const ORPHAN_INTERVAL_MS = 60_000;

export interface AnalysisServiceOptions {
  /** ffprobe reader (tests). */
  probe?: MediaProber;
  /** Overrides the ffmpeg binary lookup (tests). */
  ffmpegPath?: string;
  /** Minimum time between orphan sweeps of one project, ms (default one minute; tests use 0). */
  orphanIntervalMs?: number;
}

/** A project file that is a valid analysis source (video or audio, inside the project, not in `.hyperframes/`). */
export interface SourceRef {
  path: string;
  abs: string;
  kind: "video" | "audio";
}

/** A source as it is on disk and in the cache right now. */
interface SourceView {
  ref: SourceRef;
  manifest: SourceManifest | null;
  /** The file's bytes differ from the analysed ones. */
  changed: boolean;
  states: StageState[];
}

/** A source's fresh analysis as the story service reads it (see `AnalysisService.sourceData`). */
export interface SourceAnalysisData {
  source: string;
  kind: "video" | "audio";
  duration: number | null;
  transcript: TranscriptArtifact | null;
  takes: TakeAnalysis | null;
  silence: SilenceMap | null;
  segments: SegmentMap | null;
  /** Changes whenever the file or any of these artifacts changes. */
  version: string;
}

/** Version tokens travel through models: accept them bare, quoted like an ETag, or as bare hex. */
function bareVersion(token: string): string {
  const unquoted = token.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  return /^[0-9a-f]{64}$/.test(unquoted) ? `sha256:${unquoted}` : unquoted;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The analysis service of one Studio server: durable per-source artifacts under `.hyperframes/analysis/`, the jobs that
 * make them, and the reads, saves and cut plans that build on them. Every method takes the project it works on.
 */
export class AnalysisService {
  private readonly stores = new Map<string, AnalysisStore>();
  private readonly lastOrphanSweep = new Map<string, number>();
  private readonly jobs = new JobRegistry();
  private readonly facts: MediaFacts;

  constructor(
    private readonly adapter: StudioApiAdapter,
    private readonly options: AnalysisServiceOptions = {},
  ) {
    this.facts = new MediaFacts(options.probe);
  }

  store(project: ResolvedProject): AnalysisStore {
    let store = this.stores.get(project.dir);
    if (!store) {
      store = new AnalysisStore(project.dir);
      this.stores.set(project.dir, store);
    }
    return store;
  }

  /** Kills the child processes of every running job. */
  shutdown(): void {
    this.jobs.abortAll();
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  /** A request's source path as a checked project file, or the refusal that says why it is not one. */
  async resolveSource(project: ResolvedProject, raw: string): Promise<SourceRef> {
    const text = raw.trim().replaceAll("\\", "/");
    if (text.length === 0) throw new AnalysisFailure("invalid_request", "source is required");
    const inside = isAbsolute(text) ? relative(project.dir, text).replaceAll("\\", "/") : text;
    const path = posix.normalize(inside.replace(/^\.\//, ""));
    if (path === ".." || path.startsWith("../") || posix.isAbsolute(path) || path === ".") {
      throw new AnalysisFailure("invalid_request", `"${raw}" is not a path inside the project`);
    }
    if (path === ".hyperframes" || path.startsWith(".hyperframes/")) {
      throw new AnalysisFailure("invalid_request", "Files in .hyperframes/ cannot be analysed");
    }
    const abs = resolveWithinProject(project.dir, path);
    if (!abs) {
      throw new AnalysisFailure("invalid_request", `"${raw}" is not a path inside the project`);
    }
    const kind = assetKindOf(path);
    if (kind !== "video" && kind !== "audio") {
      throw new AnalysisFailure("invalid_request", `${path} is not a video or audio file`);
    }
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile())
      throw new AnalysisFailure("unknown_source", `No file "${path}" in this project`);
    return { path, abs, kind };
  }

  /**
   * Fingerprints the source and brings its folder in line: a new file starts from a same-content twin's artifacts or
   * empty, a changed file's cache is wiped (`reset`) or refused as stale, a re-saved one only records its new stat.
   */
  private prepare(
    project: ResolvedProject,
    ref: SourceRef,
    reset: boolean,
  ): Promise<{ source: SourceInfo; manifest: SourceManifest }> {
    const store = this.store(project);
    return serialized(`prepare\0${project.dir}\0${ref.path}`, async () => {
      const asset = await this.facts.read(project.dir, ref.path);
      const duration = asset?.duration ?? null;
      if (duration === null || !(duration > 0)) {
        throw new AnalysisFailure(
          "failed",
          `The length of ${ref.path} could not be read (is ffprobe installed?)`,
        );
      }
      const existing = await store.readManifest(ref.path);
      const check = await checkFingerprint(ref.abs, ref.path, existing?.fingerprint ?? null);
      const fingerprint = { ...check.fingerprint, duration };
      let manifest: SourceManifest;
      if (existing && check.change === "unchanged" && existing.fingerprint.duration === duration) {
        manifest = existing;
      } else if (existing && check.change !== "changed") {
        manifest = await store.updateManifest(ref.path, (current) => {
          current.fingerprint = fingerprint;
        });
      } else if (existing && !reset) {
        throw new AnalysisFailure(
          "stale",
          `${ref.path} changed since it was analysed; run analysis for it again`,
        );
      } else {
        const twin = existing ? null : await store.findTwin(ref.path, fingerprint);
        manifest = twin
          ? await store.adopt(twin, fingerprint)
          : await store.createSource(fingerprint);
      }
      return {
        manifest,
        source: {
          path: ref.path,
          abs: ref.abs,
          kind: ref.kind,
          duration,
          hasAudio: asset?.hasAudio !== false,
        },
      };
    });
  }

  /** Read-only state of a source; a file that was only re-saved (same bytes) gets its new stat recorded. */
  private async view(project: ResolvedProject, ref: SourceRef): Promise<SourceView> {
    const store = this.store(project);
    let manifest = await store.readManifest(ref.path);
    let changed = false;
    if (manifest) {
      const check = await checkFingerprint(ref.abs, ref.path, manifest.fingerprint);
      changed = check.change === "changed";
      if (check.change === "touched") {
        const { fingerprint } = check;
        manifest = await store.updateManifest(ref.path, (current) => {
          current.fingerprint = fingerprint;
        });
      }
    }
    return {
      ref,
      manifest,
      changed,
      states: this.withRunning(project, ref, evaluateStages(manifest, changed)),
    };
  }

  private withRunning(
    project: ResolvedProject,
    ref: SourceRef,
    states: StageState[],
  ): StageState[] {
    const stage = this.jobs.runningFor(project.dir, ref.path)?.stage;
    return stage
      ? states.map((state) => (state.stage === stage ? { ...state, status: "running" } : state))
      : states;
  }

  /**
   * Removes analysis of files that are gone and cut plans of vanished sources (see `removeOrphans`). Throttled per
   * project (`orphanIntervalMs`, one minute by default) unless forced; a failure never breaks the caller.
   */
  async cleanOrphans(
    project: ResolvedProject,
    { force = false }: { force?: boolean } = {},
  ): Promise<OrphanReport | null> {
    const interval = this.options.orphanIntervalMs ?? ORPHAN_INTERVAL_MS;
    const last = this.lastOrphanSweep.get(project.dir);
    const now = Date.now();
    if (!force && last !== undefined && now - last < interval) return null;
    this.lastOrphanSweep.set(project.dir, now);
    return removeOrphans(this.store(project)).catch(() => null);
  }

  private async status(project: ResolvedProject, view: SourceView): Promise<SourceAnalysisStatus> {
    const asset = await this.facts.read(project.dir, view.ref.path);
    return {
      source: view.ref.path,
      kind: view.ref.kind,
      duration: view.manifest?.fingerprint.duration ?? asset?.duration ?? null,
      fingerprint: view.manifest?.fingerprint ?? null,
      stages: view.states,
    };
  }

  /** Every video and audio file of the project with the state of its analysis. */
  async listSources(project: ResolvedProject): Promise<SourceAnalysisStatus[]> {
    await this.cleanOrphans(project);
    const paths = walkDir(project.dir)
      .filter((file) => !isInHiddenOrVendorDir(file) && !file.startsWith("renders/"))
      .filter((file) => ["video", "audio"].includes(assetKindOf(file)))
      .sort();
    await this.facts.readMany(project.dir, paths);
    const statuses: SourceAnalysisStatus[] = [];
    for (const path of paths) {
      const ref = await this.resolveSource(project, path).catch(() => null);
      if (ref) statuses.push(await this.status(project, await this.view(project, ref)));
    }
    return statuses;
  }

  /** One state of a stage that must be usable: the refusal tells the caller what to do otherwise. */
  private requireStage(view: SourceView, stage: AnalysisStage): StageState {
    const state = view.states.find((entry) => entry.stage === stage);
    const where = `${stage} of ${view.ref.path}`;
    const rerun = `run analysis for ${view.ref.path} (analyze_media)`;
    switch (state?.status) {
      case "fresh":
        return state;
      case "running":
        // Whatever is stored for a stage being recomputed (nothing, an outdated artifact) must not pass for its result.
        throw new AnalysisFailure(
          "conflict",
          `The ${where} is being computed by a running analysis; wait for it to finish, then try again`,
        );
      case "stale":
        throw new AnalysisFailure(
          "stale",
          `The ${where} is out of date (${state.detail ?? "inputs changed"}); ${rerun}`,
        );
      case "unavailable":
        throw new AnalysisFailure(
          "unavailable",
          state.detail ?? `The ${where} cannot be made on this machine`,
        );
      case "failed":
        throw new AnalysisFailure(
          "failed",
          `The ${where} failed: ${state.detail ?? "unknown error"}; ${rerun} to retry`,
        );
      default:
        throw new AnalysisFailure("not_analyzed", `The ${where} has not been computed; ${rerun}`);
    }
  }

  private isFresh(view: SourceView, stage: AnalysisStage): boolean {
    return view.states.some((state) => state.stage === stage && state.status === "fresh");
  }

  /** The stored artifact of a stage that is fresh, or null (never throws for a missing or stale one). */
  private async freshArtifact<T>(
    project: ResolvedProject,
    view: SourceView,
    stage: AnalysisStage,
    guard: (value: unknown) => value is T,
  ): Promise<T | null> {
    if (!view.manifest || !this.isFresh(view, stage)) return null;
    return this.store(project).readArtifact(view.manifest, stage, guard);
  }

  private async requireArtifact<T>(
    project: ResolvedProject,
    view: SourceView,
    stage: AnalysisStage,
    guard: (value: unknown) => value is T,
  ): Promise<{ artifact: T; version: string }> {
    const state = this.requireStage(view, stage);
    const artifact = view.manifest
      ? await this.store(project).readArtifact(view.manifest, stage, guard)
      : null;
    if (!artifact || !state.version) {
      throw new AnalysisFailure(
        "failed",
        `The stored ${stage} of ${view.ref.path} could not be read; run analysis again with force`,
      );
    }
    return { artifact, version: state.version };
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  /** Starts analysing a source, or joins the job already running for it when that job does what the request asks. */
  async startJob(project: ResolvedProject, request: AnalyzeRequest): Promise<AnalysisJob> {
    await this.cleanOrphans(project);
    const ref = await this.resolveSource(project, request.source);
    const plan = planStages(request.stages);
    const weights: Partial<Record<(typeof COMPUTED_STAGES)[number], number>> = {};
    for (const stage of plan) weights[stage] = STAGE_WEIGHTS[stage];
    const force = request.force ? (request.stages ?? COMPUTED_STAGES) : [];
    const store = this.store(project);
    return this.jobs.start({
      projectDir: project.dir,
      source: ref.path,
      weights,
      want: { language: request.language, force },
      run: async (reporter) => {
        const { source } = await this.prepare(project, ref, true);
        await runAnalysis(
          {
            store,
            adapter: this.adapter,
            source,
            ffmpegPath: this.options.ffmpegPath,
            language: request.language,
            force,
            plan,
          },
          reporter,
        );
      },
    });
  }

  getJob(project: ResolvedProject, id: string): AnalysisJob | null {
    return this.jobs.get(project.dir, id);
  }

  cancelJob(project: ResolvedProject, id: string): Promise<AnalysisJob | null> {
    return this.jobs.cancel(project.dir, id);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async overview(project: ResolvedProject, rawSource: string): Promise<AnalysisOverview> {
    const ref = await this.resolveSource(project, rawSource);
    const view = await this.view(project, ref);
    const status = await this.status(project, view);
    const [transcript, speakers, silence, shots, takes, segments, vision] = await Promise.all([
      this.freshArtifact(project, view, "transcript", isTranscript),
      this.freshArtifact(project, view, "speakers", isSpeakerMap),
      this.freshArtifact(project, view, "silence", isSilenceMap),
      this.freshArtifact(project, view, "shots", isShotMap),
      this.freshArtifact(project, view, "takes", isTakeAnalysis),
      this.freshArtifact(project, view, "segments", isSegmentMap),
      this.freshArtifact(project, view, "vision", isVisionAnalysis),
    ]);
    const duration = status.duration ?? 0;
    const cuts = (await this.withApplied(project, await this.store(project).listCuts())).filter(
      (plan) => plan.source === ref.path,
    );

    const counts: Partial<Record<TakeIssueKind, number>> = {};
    for (const issue of takes?.issues ?? []) counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;

    return {
      status,
      transcript:
        transcript && this.stateVersion(view, "transcript")
          ? {
              version: this.stateVersion(view, "transcript") ?? "",
              language: transcript.language,
              words: transcript.words.length,
              sentences: transcript.sentences.length,
              speechSeconds: transcript.speechSeconds,
            }
          : null,
      speakers,
      silence: silence
        ? {
            count: silence.silences.length,
            totalSeconds: silence.silenceSeconds,
            longest: [...silence.silences]
              .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
              .slice(0, LONGEST_SILENCES),
            over1s: silence.silences.filter((range) => range.end - range.start >= 1).length,
          }
        : null,
      shots: shots
        ? {
            count: shots.shots.length,
            averageSeconds: round2(
              shots.shots.length > 0
                ? shots.shots.reduce((sum, shot) => sum + (shot.end - shot.start), 0) /
                    shots.shots.length
                : 0,
            ),
            problems: shots.problems,
          }
        : null,
      takes: takes
        ? {
            counts,
            issues: takes.issues.filter(
              (issue) => issue.kind !== "filler" && issue.kind !== "stutter",
            ),
          }
        : null,
      segments,
      vision: vision
        ? { notes: vision.notes, inspectedFrames: vision.inspectedFrames.length }
        : null,
      visionTargets: visionTargets({ duration, shots, takes, segments, vision }),
      cuts,
    };
  }

  private stateVersion(view: SourceView, stage: AnalysisStage): string | null {
    return view.states.find((state) => state.stage === stage)?.version ?? null;
  }

  /**
   * What Build Story and the story graph need to know about one source: the fresh artifacts (null for a stage that was
   * not computed or is stale) and a token that changes whenever any of them does. Refuses like `resolveSource` when
   * the file is not a project media file.
   */
  async sourceData(project: ResolvedProject, rawSource: string): Promise<SourceAnalysisData> {
    const ref = await this.resolveSource(project, rawSource);
    const view = await this.view(project, ref);
    const [transcript, takes, silence, segments] = await Promise.all([
      this.freshArtifact(project, view, "transcript", isTranscript),
      this.freshArtifact(project, view, "takes", isTakeAnalysis),
      this.freshArtifact(project, view, "silence", isSilenceMap),
      this.freshArtifact(project, view, "segments", isSegmentMap),
    ]);
    const asset = await this.facts.read(project.dir, ref.path);
    const duration = view.manifest?.fingerprint.duration ?? asset?.duration ?? null;
    const stages = ["transcript", "takes", "silence", "segments"] as const;
    return {
      source: ref.path,
      kind: ref.kind,
      duration,
      transcript,
      takes,
      silence,
      segments,
      version: [
        view.manifest?.fingerprint.hash ?? "unanalyzed",
        ...stages.map((stage) => this.stateVersion(view, stage) ?? "-"),
      ].join("|"),
    };
  }

  /** One JPEG of a video source for a preview card: cached with the analysis frames, not recorded as inspected. */
  async framePreview(
    project: ResolvedProject,
    rawSource: string,
    time: number,
    width: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const ref = await this.resolveSource(project, rawSource);
    if (ref.kind !== "video") {
      throw new AnalysisFailure("invalid_request", `${ref.path} is not a video file`);
    }
    const { source } = await this.prepare(project, ref, false);
    const grab = await grabFrame({
      inputPath: ref.abs,
      framesDir: this.store(project).framesDir(ref.path),
      timeMs: Math.round(Math.max(0, Math.min(time, source.duration)) * 1000),
      width,
      signal,
      ffmpegPath: this.options.ffmpegPath,
    });
    return Buffer.from(await readFrameBase64(grab.file), "base64");
  }

  async transcript(
    project: ResolvedProject,
    rawSource: string,
    window: { from?: number; to?: number; words?: boolean },
  ): Promise<TranscriptView> {
    const ref = await this.resolveSource(project, rawSource);
    const view = await this.view(project, ref);
    const { artifact, version } = await this.requireArtifact(
      project,
      view,
      "transcript",
      isTranscript,
    );
    const lastEnd = artifact.sentences.at(-1)?.end ?? 0;
    const from = window.from ?? 0;
    const to = window.to ?? Math.max(lastEnd, view.manifest?.fingerprint.duration ?? 0);
    if (!(from >= 0) || !(to > from)) {
      throw new AnalysisFailure(
        "invalid_request",
        "from and to must be seconds with 0 ≤ from < to",
      );
    }
    const sentences = artifact.sentences.filter(
      (sentence) => sentence.end > from && sentence.start < to,
    );
    const first = sentences[0];
    const last = sentences.at(-1);
    return {
      source: ref.path,
      version,
      language: artifact.language,
      from,
      to,
      sentences,
      ...(window.words && first && last
        ? { words: artifact.words.slice(first.firstWord, last.lastWord + 1) }
        : window.words
          ? { words: [] }
          : {}),
      totalSentences: artifact.sentences.length,
    };
  }

  /** One stage's stored artifact as it is (only when fresh). */
  async artifact(project: ResolvedProject, rawSource: string, rawStage: string): Promise<unknown> {
    const stage = ANALYSIS_STAGES.find((candidate) => candidate === rawStage);
    if (!stage) {
      throw new AnalysisFailure(
        "invalid_request",
        `stage must be one of ${ANALYSIS_STAGES.join(", ")}`,
      );
    }
    const ref = await this.resolveSource(project, rawSource);
    const view = await this.view(project, ref);
    if (stage === "vision" && view.manifest && !view.changed && !view.manifest.stages.vision) {
      return { source: ref.path, notes: [], inspectedFrames: [] } satisfies VisionAnalysis;
    }
    switch (stage) {
      case "transcript":
        return (await this.requireArtifact(project, view, stage, isTranscript)).artifact;
      case "speakers":
        return (await this.requireArtifact(project, view, stage, isSpeakerMap)).artifact;
      case "silence":
        return (await this.requireArtifact(project, view, stage, isSilenceMap)).artifact;
      case "shots":
        return (await this.requireArtifact(project, view, stage, isShotMap)).artifact;
      case "takes":
        return (await this.requireArtifact(project, view, stage, isTakeAnalysis)).artifact;
      case "segments":
        return (await this.requireArtifact(project, view, stage, isSegmentMap)).artifact;
      case "vision":
        return (await this.requireArtifact(project, view, stage, isVisionAnalysis)).artifact;
    }
  }

  // ── Agent-written artifacts ───────────────────────────────────────────────

  /** Stores the segmentation an agent wrote for the current transcript; it replaces the draft. */
  async saveSegments(project: ResolvedProject, request: SaveSegmentsRequest): Promise<SegmentMap> {
    const ref = await this.resolveSource(project, request.source);
    const view = await this.view(project, ref);
    const { artifact: transcript, version } = await this.requireArtifact(
      project,
      view,
      "transcript",
      isTranscript,
    );
    if (bareVersion(request.transcriptVersion) !== version) {
      throw new AnalysisFailure(
        "conflict",
        `The transcript changed: you read ${request.transcriptVersion}, it is now ${version}. Read it again before segmenting.`,
      );
    }
    const speakers = await this.freshArtifact(project, view, "speakers", isSpeakerMap);
    const map = semanticSegments({
      transcript,
      transcriptVersion: version,
      request: { ...request, source: ref.path, transcriptVersion: version },
      speakers,
    });
    await this.store(project).commit(ref.path, "segments", map, {
      inputs: { transcript: version },
      params: { origin: "semantic" },
    });
    return map;
  }

  /** Appends vision notes; a note over the same range as a stored one replaces it and keeps its id. */
  async saveVisionNotes(
    project: ResolvedProject,
    request: SaveVisionNotesRequest,
  ): Promise<VisionAnalysis> {
    const ref = await this.resolveSource(project, request.source);
    const { source } = await this.prepare(project, ref, false);
    for (const note of request.notes) {
      if (note.end > source.duration + END_TOLERANCE) {
        throw new AnalysisFailure(
          "invalid_request",
          `A note ends at ${note.end} s but ${ref.path} is ${round2(source.duration)} s long`,
        );
      }
    }
    let saved: VisionAnalysis | null = null;
    await this.store(project).modify(ref.path, "vision", isVisionAnalysis, async (current) => {
      const notes: VisionNote[] = [...(current?.notes ?? [])];
      let nextId = notes.reduce((max, note) => Math.max(max, Number(note.id.slice(1)) || 0), 0) + 1;
      const createdAt = Date.now();
      for (const input of request.notes) {
        const at = notes.findIndex(
          (note) =>
            Math.abs(note.start - input.start) < SAME_RANGE &&
            Math.abs(note.end - input.end) < SAME_RANGE,
        );
        const id = at >= 0 ? (notes[at]?.id ?? `v${nextId}`) : `v${nextId++}`;
        const note: VisionNote = { id, ...input, createdAt };
        if (at >= 0) notes[at] = note;
        else notes.push(note);
      }
      notes.sort((a, b) => a.start - b.start || a.end - b.end);
      saved = { source: ref.path, notes, inspectedFrames: current?.inspectedFrames ?? [] };
      return { artifact: saved };
    });
    if (!saved) throw new AnalysisFailure("failed", "Vision notes could not be saved");
    return saved;
  }

  /** JPEG frames at source times, decoded once and cached; every time is recorded as inspected. */
  async frames(
    project: ResolvedProject,
    request: FramesRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<FramesResponse> {
    const ref = await this.resolveSource(project, request.source);
    const { source } = await this.prepare(project, ref, false);
    const width = request.width ?? DEFAULT_FRAME_WIDTH;
    for (const time of request.times) {
      if (time > source.duration + END_TOLERANCE) {
        throw new AnalysisFailure(
          "invalid_request",
          `Time ${time} s is past the end of ${ref.path} (${round2(source.duration)} s)`,
        );
      }
    }
    const store = this.store(project);
    const frames = await Promise.all(
      request.times.map(async (time) => {
        const grab = await grabFrame({
          inputPath: ref.abs,
          framesDir: store.framesDir(ref.path),
          timeMs: Math.round(Math.min(time, source.duration) * 1000),
          width,
          signal,
          ffmpegPath: this.options.ffmpegPath,
        });
        return {
          time,
          mimeType: "image/jpeg" as const,
          data: await readFrameBase64(grab.file),
          cached: grab.cached,
        };
      }),
    );
    const seen = request.times.map(
      (time) => Math.round(Math.min(time, source.duration) * 1000) / 1000,
    );
    await store.modify(ref.path, "vision", isVisionAnalysis, async (current) => {
      const known = current?.inspectedFrames ?? [];
      const inspectedFrames = [...new Set([...known, ...seen])].sort((a, b) => a - b);
      if (current && inspectedFrames.length === known.length) return null;
      return { artifact: { source: ref.path, notes: current?.notes ?? [], inspectedFrames } };
    });
    return { source: ref.path, frames };
  }

  // ── Cut plans ─────────────────────────────────────────────────────────────

  async planCut(project: ResolvedProject, request: CutPlanRequest): Promise<CutPlan> {
    const ref = await this.resolveSource(project, request.source);
    const store = this.store(project);
    const normalised: CutPlanRequest = { ...request, source: ref.path };
    const base = request.basedOn ? await this.baseCut(project, request.basedOn, ref) : null;
    const view = await this.view(project, ref);
    const { artifact: transcript, version: transcriptVersion } = await this.requireArtifact(
      project,
      view,
      "transcript",
      isTranscript,
    );
    const { artifact: takes } = await this.requireArtifact(project, view, "takes", isTakeAnalysis);
    const { artifact: segments, version: segmentsVersion } = await this.requireArtifact(
      project,
      view,
      "segments",
      isSegmentMap,
    );
    const silence = await this.freshArtifact(project, view, "silence", isSilenceMap);
    const shots = await this.freshArtifact(project, view, "shots", isShotMap);
    const sourceDuration = view.manifest?.fingerprint.duration ?? 0;
    const merged = mergeCutRequest(base?.request ?? null, normalised);
    const mediaRange = effectiveRange(
      readAssetRanges(project.dir).get(ref.path),
      sourceDuration > 0 ? sourceDuration : null,
    );
    return store.createCut(async (id) =>
      planCut({
        id,
        createdAt: Date.now(),
        request: merged,
        basedOn: request.basedOn ?? null,
        transcript,
        transcriptVersion,
        silence,
        takes,
        segments,
        segmentsVersion,
        shots,
        sourceDuration,
        mediaRange,
      }),
    );
  }

  private async baseCut(project: ResolvedProject, id: string, ref: SourceRef): Promise<CutPlan> {
    const base = await this.store(project).readCut(id);
    if (!base) throw new AnalysisFailure("unknown_plan", `There is no cut plan "${id}"`);
    if (base.source !== ref.path) {
      throw new AnalysisFailure(
        "invalid_request",
        `${id} is a plan for ${base.source}, not ${ref.path}`,
      );
    }
    return base;
  }

  async listCuts(
    project: ResolvedProject,
    rawSource: string | undefined,
  ): Promise<CutPlanSummary[]> {
    const plans = await this.withApplied(project, await this.store(project).listCuts());
    if (rawSource === undefined) return plans;
    const ref = await this.resolveSource(project, rawSource);
    return plans.filter((plan) => plan.source === ref.path);
  }

  /** A stored plan; when its source or transcript changed since, a warning says it needs planning again. */
  async getCut(project: ResolvedProject, id: string): Promise<CutPlan> {
    const plan = await this.store(project).readCut(id);
    if (!plan) throw new AnalysisFailure("unknown_plan", `There is no cut plan "${id}"`);
    const stale = await this.staleReason(project, plan);
    const [current] = await this.withApplied(project, [plan]);
    const derived = current ?? plan;
    return stale
      ? {
          ...derived,
          warnings: [...derived.warnings, `This plan is out of date: ${stale}`],
          outOfDate: stale,
        }
      : derived;
  }

  /** Stamps each plan with where it is on a timeline now (derived from `data-ov-cut` clips; null when nowhere). */
  private async withApplied<T extends CutPlanSummary>(
    project: ResolvedProject,
    plans: T[],
  ): Promise<T[]> {
    const applied = await readAppliedCuts(project.dir);
    return plans.map((plan) => ({ ...plan, applied: applied.get(plan.id) ?? null }));
  }

  /** Why the plan no longer fits the source's analysis (or its picked fragment), or null while it does. */
  private async staleReason(project: ResolvedProject, plan: CutPlan): Promise<string | null> {
    const ref = await this.resolveSource(project, plan.source).catch(() => null);
    if (!ref) return `${plan.source} is no longer in the project`;
    const view = await this.view(project, ref);
    if (view.changed)
      return `${plan.source} changed after the plan was made; analyse it and plan again`;
    const version = this.stateVersion(view, "transcript");
    if (!this.isFresh(view, "transcript") || version !== plan.transcriptVersion) {
      return `the transcript of ${plan.source} changed after the plan was made; plan again`;
    }
    const pickNow = effectiveRange(
      readAssetRanges(project.dir).get(plan.source),
      view.manifest?.fingerprint.duration ?? null,
    );
    const pickThen = plan.mediaRange ?? null;
    if (!sameRange(pickThen, pickNow)) {
      return `the picked fragment of ${plan.source} changed after the plan was made; plan again`;
    }
    return null;
  }
}

/** Whether two picks are the same fragment (both null: the whole file). */
function sameRange(a: AssetRange | null, b: AssetRange | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.start - b.start) < 1e-6 && Math.abs(a.end - b.end) < 1e-6;
}
