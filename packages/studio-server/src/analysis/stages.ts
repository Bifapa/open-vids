import type {
  AnalysisStage,
  ComputedStage,
  SegmentMap,
  ShotMap,
  SilenceMap,
  StageOutcome,
  StageResult,
  TakeAnalysis,
  TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import type { StudioApiAdapter } from "../types.js";
import { AnalysisFailure, isAnalysisFailure } from "./errors.js";
import { measureAudioLevels } from "./audioLevels.js";
import { runFfmpeg } from "./ffmpeg.js";
import { parseBlackdetect, parseFreezedetect, parseSceneChanges } from "./ffmpegParse.js";
import { detectSilences } from "./levels.js";
import { draftSegments } from "./segmentation.js";
import { buildShotMap } from "./shots.js";
import { buildSpeakerMap } from "./speakers.js";
import {
  AnalysisStore,
  STAGE_INPUTS,
  STAGE_ORDER,
  evaluateStages,
  isAsrArtifact,
  isSegmentMap,
  isShotMap,
  isSilenceMap,
  isSpeakerMap,
  isTranscript,
  type AsrArtifact,
  type CommitMeta,
  type SourceManifest,
} from "./store.js";
import { detectTakeIssues } from "./takes.js";
import { buildTranscript } from "./transcript.js";

/** A silence lasts at least this long (seconds); how quiet it must be is worked out per recording (see levels.ts). */
const MIN_SILENCE_SECONDS = 0.35;
/** A frame this different from the one before it (0–1 scene score) starts a new shot. */
export const SCENE_THRESHOLD = 0.3;
const BLACK_MIN_SECONDS = 0.5;
const BLACK_PIXEL_THRESHOLD = 0.1;
const FREEZE_NOISE = 0.003;
const FREEZE_MIN_SECONDS = 2;
/** Shots are found on a small 10 fps copy of the picture: the decode is the cost, not the analysis. */
const SHOT_FILTER = `scale=320:-2,fps=10`;

/** Share of a job's progress bar per stage; recognizing speech is by far the longest. */
export const STAGE_WEIGHTS: Record<ComputedStage, number> = {
  silence: 6,
  speakers: 12,
  shots: 20,
  transcript: 50,
  takes: 6,
  segments: 6,
};

/** The requested stages plus everything they cannot be computed without, in run order. */
export function planStages(requested: readonly ComputedStage[] | undefined): ComputedStage[] {
  const wanted = new Set<AnalysisStage>(requested ?? STAGE_ORDER);
  for (const stage of [...STAGE_ORDER].reverse()) {
    if (wanted.has(stage)) for (const need of STAGE_INPUTS[stage].requires) wanted.add(need);
  }
  return STAGE_ORDER.filter(
    (stage): stage is ComputedStage => stage !== "vision" && wanted.has(stage),
  );
}

/** A source ready to analyse: a project file that exists, has a duration, and is fingerprinted. */
export interface SourceInfo {
  path: string;
  abs: string;
  kind: "video" | "audio";
  duration: number;
  hasAudio: boolean;
}

/** Progress reporting of a running job, as the stage runner sees it. */
export interface StageReporter {
  signal: AbortSignal;
  begin(stage: ComputedStage): void;
  /** 0–1 within the stage that began last. */
  advance(fraction: number): void;
  finish(result: StageResult): void;
}

export interface AnalysisRun {
  store: AnalysisStore;
  adapter: StudioApiAdapter;
  source: SourceInfo;
  ffmpegPath?: string;
  language?: string;
  /** Stages to recompute even when fresh (the requested ones; what they merely need is not forced). */
  force: readonly ComputedStage[];
  plan: readonly ComputedStage[];
}

type Computed =
  | { kind: "artifact"; artifact: unknown; meta: CommitMeta }
  /** The stage's stored artifact stays as it is. */
  | { kind: "kept"; detail: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "skipped"; detail: string };

interface Stage extends AnalysisRun {
  signal: AbortSignal;
  advance(fraction: number): void;
}

function versionOf(manifest: SourceManifest | null, stage: AnalysisStage): string | null {
  return manifest?.stages[stage]?.version ?? null;
}

function isFresh(manifest: SourceManifest | null, stage: AnalysisStage): boolean {
  return evaluateStages(manifest, false).some(
    (state) => state.stage === stage && state.status === "fresh",
  );
}

/** A stage's artifact when it is stored, valid and current; null otherwise. */
async function loadFresh<T>(
  run: AnalysisRun,
  stage: AnalysisStage,
  guard: (value: unknown) => value is T,
): Promise<T | null> {
  const manifest = await run.store.readManifest(run.source.path);
  if (!manifest || !isFresh(manifest, stage)) return null;
  return run.store.readArtifact(manifest, stage, guard);
}

async function requireFresh<T>(
  run: AnalysisRun,
  stage: AnalysisStage,
  guard: (value: unknown) => value is T,
): Promise<T> {
  const artifact = await loadFresh(run, stage, guard);
  if (!artifact) throw new AnalysisFailure("failed", `The stored ${stage} could not be read`);
  return artifact;
}

function progressOf(stage: Stage): (seconds: number) => void {
  return (seconds) => stage.advance(Math.min(1, seconds / Math.max(stage.source.duration, 0.001)));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function computeSilence(stage: Stage): Promise<Computed> {
  const { source } = stage;
  const levels = await measureAudioLevels(source.abs, {
    signal: stage.signal,
    ffmpegPath: stage.ffmpegPath,
    onTime: progressOf(stage),
  });
  const detection = detectSilences(levels.frameDb, levels.frameSeconds, {
    minSilence: MIN_SILENCE_SECONDS,
  });
  const silences = detection.silences
    .map((range) => ({ start: range.start, end: Math.min(range.end, source.duration) }))
    .filter((range) => range.end > range.start);
  const artifact: SilenceMap = {
    source: source.path,
    thresholdDb: detection.thresholdDb,
    minSilence: MIN_SILENCE_SECONDS,
    silences,
    silenceSeconds: round3(silences.reduce((sum, range) => sum + (range.end - range.start), 0)),
  };
  return {
    kind: "artifact",
    artifact,
    meta: {
      params: {
        method: "adaptive-rms",
        thresholdDb: detection.thresholdDb,
        minSilence: MIN_SILENCE_SECONDS,
      },
    },
  };
}

async function computeSpeakers(stage: Stage): Promise<Computed> {
  const { adapter, source, signal } = stage;
  let note: string;
  if (!adapter.diarizeMedia) {
    note = "No speaker diarizer is available on this machine; one speaker is assumed.";
  } else {
    const result = await adapter.diarizeMedia({ inputPath: source.abs, signal });
    if (!("unavailable" in result)) {
      const artifact = buildSpeakerMap(source.path, result, null, source.duration);
      return { kind: "artifact", artifact, meta: { producer: result.producer, detail: null } };
    }
    note = `${result.unavailable}; one speaker is assumed.`;
  }
  const artifact = buildSpeakerMap(source.path, null, note, source.duration);
  return { kind: "artifact", artifact, meta: { detail: note } };
}

/** Recognizes speech (or reuses the stored words) and builds the transcript with the speaker turns known so far. */
async function computeTranscript(stage: Stage): Promise<Computed> {
  const { store, adapter, source, signal } = stage;
  let manifest = await store.readManifest(source.path);
  let asr = manifest ? await store.readArtifact(manifest, "asr", isAsrArtifact) : null;
  const hint = stage.language ?? null;
  const usable =
    !stage.force.includes("transcript") &&
    asr !== null &&
    (hint === null || manifest?.asr?.params.language === hint);
  let detail: string | null = null;
  if (!usable) {
    if (!adapter.transcribeMedia) {
      return {
        kind: "unavailable",
        detail: "No speech recognizer is available on this machine, so there is no transcript.",
      };
    }
    const result = await adapter.transcribeMedia({
      inputPath: source.abs,
      language: stage.language,
      signal,
    });
    if ("unavailable" in result) return { kind: "unavailable", detail: result.unavailable };
    signal.throwIfAborted();
    const fresh: AsrArtifact = {
      language: result.language,
      producer: result.producer,
      words: result.words,
    };
    await store.commit(source.path, "asr", fresh, {
      params: { language: hint },
      producer: result.producer,
    });
    asr = fresh;
    manifest = await store.readManifest(source.path);
  } else {
    detail = "rebuilt from the stored recognizer words";
  }
  if (!asr || !manifest?.asr)
    throw new AnalysisFailure("failed", "The recognizer words are missing");

  const speakers = await loadFresh(stage, "speakers", isSpeakerMap);
  // Read when fresh, not tracked as an input: it only tells a loop over silence from one over music or noise.
  const silence = await loadFresh(stage, "silence", isSilenceMap);
  const turns = speakers && speakers.turns.length > 0 ? speakers.turns : null;
  const artifact: TranscriptArtifact = buildTranscript(
    source.path,
    asr.words,
    asr.language,
    turns,
    silence,
  );
  return {
    kind: "artifact",
    artifact,
    meta: {
      inputs: {
        asr: manifest.asr.version,
        speakers: speakers ? versionOf(manifest, "speakers") : null,
      },
      producer: asr.producer,
      detail: [detail, artifact.hallucinations?.note].filter(Boolean).join("; ") || null,
    },
  };
}

async function computeShots(stage: Stage): Promise<Computed> {
  const { source } = stage;
  const graph =
    `[0:v:0]${SHOT_FILTER},split=2[a][b];` +
    // The first frame is always kept (score 0): a branch that delivers no frame at all makes ffmpeg fail.
    `[a]select='gt(scene,${SCENE_THRESHOLD})+eq(n,0)',metadata=print[scenes];` +
    `[b]blackdetect=d=${BLACK_MIN_SECONDS}:pix_th=${BLACK_PIXEL_THRESHOLD},` +
    `freezedetect=n=${FREEZE_NOISE}:d=${FREEZE_MIN_SECONDS}[problems]`;
  const stderr = await runFfmpeg(
    [
      "-i",
      source.abs,
      "-filter_complex",
      graph,
      "-map",
      "[scenes]",
      "-an",
      "-f",
      "null",
      "-",
      "-map",
      "[problems]",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { signal: stage.signal, ffmpegPath: stage.ffmpegPath, onTime: progressOf(stage) },
  );
  const artifact: ShotMap = buildShotMap(
    source.path,
    source.duration,
    parseSceneChanges(stderr),
    SCENE_THRESHOLD,
    parseBlackdetect(stderr),
    parseFreezedetect(stderr, source.duration),
  );
  return {
    kind: "artifact",
    artifact,
    meta: {
      params: {
        sceneThreshold: SCENE_THRESHOLD,
        blackMinSeconds: BLACK_MIN_SECONDS,
        freezeMinSeconds: FREEZE_MIN_SECONDS,
      },
    },
  };
}

async function computeTakes(stage: Stage): Promise<Computed> {
  const transcript = await requireFresh(stage, "transcript", isTranscript);
  const silence = await loadFresh(stage, "silence", isSilenceMap);
  const shots = await loadFresh(stage, "shots", isShotMap);
  const manifest = await stage.store.readManifest(stage.source.path);
  const artifact: TakeAnalysis = detectTakeIssues({ transcript, silence, shots });
  return {
    kind: "artifact",
    artifact,
    meta: {
      inputs: {
        transcript: versionOf(manifest, "transcript"),
        silence: silence ? versionOf(manifest, "silence") : null,
        shots: shots ? versionOf(manifest, "shots") : null,
      },
    },
  };
}

/** Draft segments from pauses, speakers and topic shifts; segments an agent wrote for this transcript stay. */
async function computeSegments(stage: Stage): Promise<Computed> {
  const { store, source } = stage;
  const manifest = await store.readManifest(source.path);
  const transcriptVersion = versionOf(manifest, "transcript");
  if (!manifest || transcriptVersion === null) {
    throw new AnalysisFailure("failed", "The transcript is missing");
  }
  const stored = manifest.stages.segments;
  const existing = stored ? await store.readArtifact(manifest, "segments", isSegmentMap) : null;
  if (existing?.origin === "semantic" && existing.transcriptVersion === transcriptVersion) {
    return { kind: "kept", detail: "segments written by an agent were kept" };
  }
  const detail =
    existing?.origin === "semantic"
      ? "segments written by an agent were dropped because the transcript changed"
      : null;
  const transcript = await requireFresh(stage, "transcript", isTranscript);
  const silence = await loadFresh(stage, "silence", isSilenceMap);
  const speakers = await loadFresh(stage, "speakers", isSpeakerMap);
  const artifact: SegmentMap = draftSegments({ transcript, transcriptVersion, silence, speakers });
  return {
    kind: "artifact",
    artifact,
    meta: {
      inputs: {
        transcript: transcriptVersion,
        silence: silence ? versionOf(manifest, "silence") : null,
        speakers: speakers ? versionOf(manifest, "speakers") : null,
      },
      params: { origin: "draft" },
      detail,
    },
  };
}

const COMPUTE: Record<ComputedStage, (stage: Stage) => Promise<Computed>> = {
  silence: computeSilence,
  speakers: computeSpeakers,
  shots: computeShots,
  transcript: computeTranscript,
  takes: computeTakes,
  segments: computeSegments,
};

/** Why a stage cannot apply to this source at all (nothing to hear, nothing to see). */
function inapplicable(source: SourceInfo, stage: ComputedStage): string | null {
  if (stage === "shots" && source.kind === "audio") return "an audio file has no picture";
  const needsAudio = stage === "silence" || stage === "speakers" || stage === "transcript";
  if (needsAudio && !source.hasAudio) return "the source has no audio track";
  return null;
}

const done = (outcome: StageOutcome) => outcome === "cached" || outcome === "computed";

/**
 * Runs the planned stages of one source in dependency order: fresh stages are `cached` without any work, the rest are
 * computed and committed one at a time (so a cancel or a later failure keeps what finished). A stage whose required
 * input did not finish is `failed` (its input failed) or `skipped` (its input is unavailable or does not apply).
 * Rejects with `cancelled` when the signal aborts; every child process is killed by then.
 */
export async function runAnalysis(run: AnalysisRun, reporter: StageReporter): Promise<void> {
  const { store, source } = run;
  const { signal } = reporter;
  const outcomes: Partial<Record<AnalysisStage, StageOutcome>> = {};
  /** Stages that cannot apply to this source, directly or because what they need cannot. */
  const inapplicableStages = new Set<AnalysisStage>();
  for (const name of run.plan) {
    signal.throwIfAborted();
    reporter.begin(name);
    const started = performance.now();
    const conclude = async (
      outcome: StageOutcome,
      detail: string | null,
      problem?: "failed" | "unavailable",
    ) => {
      outcomes[name] = outcome;
      if (problem && detail) await store.setProblem(source.path, name, { status: problem, detail });
      reporter.finish({
        stage: name,
        outcome,
        seconds: Math.round((performance.now() - started) / 10) / 100,
        detail,
      });
    };

    const notApplicable = inapplicable(source, name);
    if (notApplicable) {
      inapplicableStages.add(name);
      await conclude("skipped", notApplicable, "unavailable");
      continue;
    }
    const blocker = STAGE_INPUTS[name].requires.find((need) => {
      const outcome = outcomes[need];
      return outcome !== undefined && !done(outcome);
    });
    if (blocker) {
      const failed = outcomes[blocker] === "failed";
      const detail = `${blocker} ${failed ? "failed" : "is not available"}`;
      // What only waits on a stage that does not apply to this source never will apply either: record that, so the
      // stage stops reporting "missing". A blocker that is merely unavailable on this machine may be installed later.
      const never = !failed && inapplicableStages.has(blocker);
      if (never) inapplicableStages.add(name);
      await conclude(
        failed ? "failed" : "skipped",
        detail,
        failed ? "failed" : never ? "unavailable" : undefined,
      );
      continue;
    }

    const manifest = await store.readManifest(source.path);
    if (!run.force.includes(name) && isFresh(manifest, name)) {
      const record = manifest?.stages[name];
      await conclude("cached", record?.detail ?? null);
      continue;
    }

    try {
      const computed = await COMPUTE[name]({
        ...run,
        signal,
        advance: (fraction) => reporter.advance(fraction),
      });
      signal.throwIfAborted();
      if (computed.kind === "artifact") {
        await store.commit(source.path, name, computed.artifact, computed.meta);
        await conclude("computed", computed.meta.detail ?? null);
      } else if (computed.kind === "kept") {
        await conclude("cached", computed.detail);
      } else {
        if (computed.kind === "skipped") inapplicableStages.add(name);
        await conclude(computed.kind, computed.detail, "unavailable");
      }
    } catch (error) {
      if (signal.aborted || (isAnalysisFailure(error) && error.error.code === "cancelled")) {
        throw new AnalysisFailure("cancelled", "Analysis was cancelled");
      }
      const message = error instanceof Error ? error.message : String(error);
      if (isAnalysisFailure(error) && error.error.code === "unavailable") {
        await conclude("unavailable", message, "unavailable");
      } else {
        await conclude("failed", message, "failed");
      }
    }
  }
}
