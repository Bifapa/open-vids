import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  QA_LIMITS,
  parseQaIssueDraft,
  type FrameImage,
  type QaCheckId,
  type QaCheckRequest,
  type QaCheckResponse,
  type QaCheckRun,
  type QaFramesRequest,
  type QaFramesResponse,
  type QaFinishRequest,
  type QaFinishResponse,
  type QaIssueDraft,
  type QaReport,
  type QaReportInput,
  type QaReportList,
  type QaSeverity,
  type QaStateResponse,
  type StoryGraph,
  type TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import { measureAudioLevels } from "../analysis/audioLevels.js";
import { grabFrame, readFrameBase64 } from "../analysis/frames.js";
import type { AnalysisService } from "../analysis/service.js";
import { isEditFailure } from "../editing/errors.js";
import { MediaFacts, type MediaProber } from "../editing/mediaFacts.js";
import { probeMediaMetadata } from "../helpers/mediaMetadata.js";
import {
  normalizeCompositionPath,
  readComposition,
  type ReadComposition,
} from "../editing/service.js";
import { MAIN_COMPOSITION } from "../editing/inventory.js";
import { resolveProjectSignature } from "../helpers/projectSignature.js";
import { resolveWithinProject } from "../helpers/safePath.js";
import { readStoredStory } from "../story/graphIo.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { readCaptionCues } from "./cues.js";
import { QaFailure, asQaFailure } from "./errors.js";
import { layoutIssues, layoutSampleTimes } from "./layoutChecks.js";
import {
  analysePicture,
  blackIssues,
  frozenIssues,
  noAudioStreamIssue,
  silenceIssues,
  silentRuns,
  withoutSilentSources,
  withoutStaticSources,
} from "./renderChecks.js";
import { enforceRetention, finishSession, type RetentionContext } from "./retention.js";
import { planSamples } from "./samples.js";
import { framesDirFor, listReports, readReport, writeReport } from "./store.js";
import { timelineIssues } from "./timelineChecks.js";
import { isAudible, type QaTimeline } from "./timelineModel.js";

const DEFAULT_FRAME_WIDTH = 640;
/** A frame requested at the very end of a render is taken this much earlier (the last frame ends at the duration). */
const END_MARGIN_SECONDS = 0.04;
const RENDERS_PREFIX = "renders/";

export interface QaServiceOptions {
  /** ffprobe reader (tests). */
  probe?: MediaProber;
  /** Overrides the ffmpeg binary lookup (tests). */
  ffmpegPath?: string;
  /** Clock for report ids and timestamps (tests). */
  now?: () => number;
}

export type QaAnalysis = Pick<AnalysisService, "sourceData">;

const SEVERITY_RANK: Record<QaSeverity, number> = { error: 0, warning: 1, info: 2 };

/** One issue per (kind, subject): the same thing found by several checks or at several times is reported once. */
function mergeSameSubject(drafts: readonly QaIssueDraft[]): QaIssueDraft[] {
  const merged: QaIssueDraft[] = [];
  const bySubject = new Map<string, QaIssueDraft[]>();
  for (const draft of drafts) {
    if (draft.subject === null) {
      merged.push(draft);
      continue;
    }
    const key = `${draft.kind}\0${draft.subject}`;
    bySubject.set(key, [...(bySubject.get(key) ?? []), draft]);
  }
  for (const group of bySubject.values()) {
    const ranked = [...group].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.start - b.start,
    );
    const base = ranked[0];
    if (!base) continue;
    merged.push({
      ...base,
      start: Math.min(...group.map((entry) => entry.start)),
      end: Math.max(...group.map((entry) => entry.end)),
      clipIds: [...new Set(group.flatMap((entry) => entry.clipIds))].slice(0, QA_LIMITS.clipIds),
      fixable: group.some((entry) => entry.fixable),
      owner: base.owner ?? group.find((entry) => entry.owner !== null)?.owner ?? null,
      message:
        group.length > 1 ? `${base.message} (and ${group.length - 1} more like it)` : base.message,
    });
  }
  return merged;
}

/** A timeline hole the render's own black-frame detection found too is one issue, reported with the render's numbers. */
function withoutConfirmedGaps(drafts: readonly QaIssueDraft[]): QaIssueDraft[] {
  const black = drafts.filter((draft) => draft.check === "blackdetect");
  return drafts.filter((draft) => {
    if (draft.check !== "timeline.gap") return true;
    const length = draft.end - draft.start;
    return !black.some(
      (found) => Math.min(found.end, draft.end) - Math.max(found.start, draft.start) >= length / 2,
    );
  });
}

function finalizeIssues(drafts: readonly QaIssueDraft[]): QaIssueDraft[] {
  const checked: QaIssueDraft[] = [];
  for (const draft of mergeSameSubject(withoutConfirmedGaps(drafts))) {
    const parsed = parseQaIssueDraft(draft);
    if (parsed.ok) checked.push(parsed.value);
  }
  const kept = checked
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.start - b.start)
    .slice(0, QA_LIMITS.issues);
  return kept.sort(
    (a, b) => a.start - b.start || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}

function failedRun(id: QaCheckId, reason: unknown): QaCheckRun {
  const { error } = asQaFailure(reason);
  return {
    id,
    status: error.code === "unavailable" ? "unavailable" : "failed",
    detail: error.message,
  };
}

interface RenderFacts {
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean | null;
  error: string | null;
}

interface CheckPart {
  runs: QaCheckRun[];
  issues: QaIssueDraft[];
}

/**
 * Render QA of one Studio server: deterministic checks on a rendered file and on the timeline it was rendered from,
 * the plan of frames Vision should review, frame grabs of the render, and the durable reports of QA passes under
 * `.hyperframes/qa/`. Every check reports how it ran, and one that cannot run (no ffmpeg, no layout checker) never
 * fails the request.
 */
export class QaService {
  private readonly facts: MediaFacts;
  private readonly shutdownController = new AbortController();
  /** Sessions that saved a report and have not finished (their reports are exempt from retention). */
  private readonly running = new Set<string>();

  constructor(
    private readonly adapter: StudioApiAdapter,
    private readonly analysis: QaAnalysis,
    private readonly options: QaServiceOptions = {},
  ) {
    this.facts = new MediaFacts(options.probe);
  }

  /** Kills the ffmpeg and layout-checker children of every running check and frame grab. */
  shutdown(): void {
    this.shutdownController.abort();
  }

  state(project: ResolvedProject): QaStateResponse {
    return { fingerprint: resolveProjectSignature(this.adapter, project.dir) };
  }

  // ── Check ─────────────────────────────────────────────────────────────────

  async check(
    project: ResolvedProject,
    request: QaCheckRequest,
    requestSignal: AbortSignal = new AbortController().signal,
  ): Promise<QaCheckResponse> {
    const signal = AbortSignal.any([requestSignal, this.shutdownController.signal]);
    const renderFile = this.resolveRender(project, request.render);
    const compositionPath = this.compositionPath(request.composition);
    const timeline = await this.loadTimeline(project, compositionPath, signal);
    const info = await this.probeRender(renderFile);
    const duration = info.duration ?? timeline.snapshot.composition.duration;

    const [picture, audio, layout] = await Promise.all([
      this.checkPicture(project, renderFile, info, duration, timeline, signal),
      this.checkAudio(project, renderFile, info, duration, timeline, signal),
      this.checkLayout(project, timeline, duration, signal),
    ]);
    if (signal.aborted) throw new QaFailure("cancelled", "The QA check was cancelled");
    const fromTimeline = this.checkTimeline(timeline);

    const renderRun: QaCheckRun = info.error
      ? { id: "render", status: "failed", detail: info.error }
      : {
          id: "render",
          status: "ran",
          detail: `${info.width ?? "?"}×${info.height ?? "?"}, ${duration.toFixed(2)} s, ${info.hasAudio === false ? "no audio" : "audio"}`,
        };
    const issues = finalizeIssues([
      ...picture.issues,
      ...audio.issues,
      ...fromTimeline.issues,
      ...layout.issues,
    ]);
    return {
      fingerprint: resolveProjectSignature(this.adapter, project.dir),
      composition: compositionPath,
      timelineVersion: timeline.snapshot.version,
      duration,
      checks: [renderRun, ...picture.runs, ...audio.runs, ...fromTimeline.runs, ...layout.runs],
      issues,
      samples: planSamples({
        timeline,
        duration,
        issues,
        framesPerMinute: request.framesPerMinute,
        maxFrames: request.maxFrames,
      }),
    };
  }

  /** The render's file on disk, refused when it is not a file of the project's renders folder. */
  private resolveRender(project: ResolvedProject, render: string): string {
    const name = render.slice(RENDERS_PREFIX.length);
    const file = resolveWithinProject(this.adapter.rendersDir(project), name);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      throw new QaFailure("not_found", `There is no render "${render}" in this project`);
    }
    return file;
  }

  private compositionPath(raw: string | undefined): string {
    try {
      return normalizeCompositionPath(raw);
    } catch (error) {
      if (isEditFailure(error)) throw new QaFailure("invalid_request", error.error.message);
      throw error;
    }
  }

  private async probeRender(file: string): Promise<RenderFacts> {
    const metadata = await (this.options.probe ?? probeMediaMetadata)(file);
    return {
      duration: metadata.durationSeconds ?? null,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      hasAudio: metadata.hasAudio ?? null,
      error:
        metadata.probeError ??
        (metadata.durationSeconds === undefined ? "The render's length could not be read" : null),
    };
  }

  /** The composition's timeline and what the checks need around it, read once. */
  private async loadTimeline(
    project: ResolvedProject,
    compositionPath: string,
    signal: AbortSignal,
  ): Promise<QaTimeline> {
    let read: ReadComposition;
    try {
      read = await readComposition(project, compositionPath, this.facts);
    } catch (error) {
      if (isEditFailure(error)) throw new QaFailure("not_found", error.error.message);
      throw error;
    }
    const { snapshot, model } = read;
    const rates = new Map(model.clips.map((clip) => [clip.id, clip.playbackRate]));
    const sources = [
      ...new Set(snapshot.clips.flatMap((clip) => (clip.src === null ? [] : [clip.src]))),
    ];
    const missing = new Set<string>();
    const hasAudio = new Map<string, boolean | null>();
    for (const src of sources) {
      const abs = resolveWithinProject(project.dir, src);
      if (!abs || !existsSync(abs)) missing.add(src);
      hasAudio.set(src, this.facts.peek(project.dir, src)?.hasAudio ?? null);
    }
    const transcripts = new Map<string, TranscriptArtifact>();
    const silences = new Map<string, readonly { start: number; end: number }[]>();
    const played = snapshot.clips.filter((clip) => clip.kind === "video" || clip.kind === "audio");
    for (const src of new Set(played.flatMap((clip) => (clip.src === null ? [] : [clip.src])))) {
      if (missing.has(src) || signal.aborted) continue;
      try {
        const data = await this.analysis.sourceData(project, src);
        if (data.transcript && data.transcript.words.length > 0)
          transcripts.set(src, data.transcript);
        if (data.silence) silences.set(src, data.silence.silences);
      } catch {
        // not analysable (or not analysed): its cuts are simply not checked against speech
      }
    }
    let graph: StoryGraph | null = null;
    try {
      graph = readStoredStory(project.dir)?.graph ?? null;
    } catch {
      graph = null;
    }
    return {
      snapshot,
      rates,
      missing,
      hasAudio,
      transcripts,
      silences,
      cues: readCaptionCues(project.dir, snapshot.clips),
      graph,
    };
  }

  private async checkPicture(
    project: ResolvedProject,
    file: string,
    info: RenderFacts,
    duration: number,
    timeline: QaTimeline,
    signal: AbortSignal,
  ): Promise<CheckPart> {
    if (info.width === null && info.error === null) {
      const detail = "The render has no video stream";
      return {
        runs: [
          { id: "black_frames", status: "skipped", detail },
          { id: "frozen_frames", status: "skipped", detail },
        ],
        issues: [],
      };
    }
    try {
      const run = { signal, ffmpegPath: this.options.ffmpegPath };
      const found = await analysePicture(file, duration, run);
      const stuck = await withoutStaticSources(
        found.frozen,
        timeline,
        (src) => resolveWithinProject(project.dir, src),
        run,
      );
      return {
        runs: [
          { id: "black_frames", status: "ran", detail: null },
          { id: "frozen_frames", status: "ran", detail: null },
        ],
        issues: [...blackIssues(found.black, timeline, duration), ...frozenIssues(stuck, timeline)],
      };
    } catch (error) {
      return {
        runs: [failedRun("black_frames", error), failedRun("frozen_frames", error)],
        issues: [],
      };
    }
  }

  private async checkAudio(
    project: ResolvedProject,
    file: string,
    info: RenderFacts,
    duration: number,
    timeline: QaTimeline,
    signal: AbortSignal,
  ): Promise<CheckPart> {
    const expected = timeline.snapshot.clips.some((clip) => isAudible(timeline, clip));
    if (info.hasAudio === false) {
      const issue = noAudioStreamIssue(timeline, duration);
      return {
        runs: [
          expected
            ? { id: "audio", status: "ran", detail: "The render has no audio stream" }
            : { id: "audio", status: "skipped", detail: "No audio in the render, none expected" },
        ],
        issues: issue ? [issue] : [],
      };
    }
    try {
      const run = { signal, ffmpegPath: this.options.ffmpegPath };
      const levels = await measureAudioLevels(file, run);
      const suspicious = await withoutSilentSources(
        silentRuns(levels, duration),
        timeline,
        (src) => resolveWithinProject(project.dir, src),
        run,
      );
      return {
        runs: [{ id: "audio", status: "ran", detail: null }],
        issues: silenceIssues(suspicious, timeline),
      };
    } catch (error) {
      return { runs: [failedRun("audio", error)], issues: [] };
    }
  }

  private checkTimeline(timeline: QaTimeline): CheckPart {
    try {
      const issues = timelineIssues(timeline);
      const cached = timeline.transcripts.size;
      return {
        runs: [
          {
            id: "timeline",
            status: "ran",
            detail:
              cached === 0
                ? "No cached transcript: cuts inside words were not checked"
                : `${cached} transcript${cached === 1 ? "" : "s"} checked for cuts inside words`,
          },
        ],
        issues,
      };
    } catch (error) {
      return { runs: [failedRun("timeline", error)], issues: [] };
    }
  }

  private async checkLayout(
    project: ResolvedProject,
    timeline: QaTimeline,
    duration: number,
    signal: AbortSignal,
  ): Promise<CheckPart> {
    const run = (status: QaCheckRun["status"], detail: string | null): CheckPart => ({
      runs: [{ id: "layout", status, detail }],
      issues: [],
    });
    const checker = this.adapter.checkLayout;
    if (!checker) return run("unavailable", "This host has no layout checker");
    if (timeline.snapshot.composition.path !== MAIN_COMPOSITION) {
      return run(
        "skipped",
        `The layout check audits the main composition (${MAIN_COMPOSITION}) only`,
      );
    }
    const times = layoutSampleTimes(timeline, duration);
    if (times.length === 0) return run("skipped", "No captions, text or graphics to audit");
    try {
      const result = await checker.call(this.adapter, { project, times, signal });
      if ("unavailable" in result) return run("unavailable", result.unavailable);
      return {
        runs: [{ id: "layout", status: "ran", detail: `${result.samples.length} moments audited` }],
        issues: layoutIssues(result.findings, timeline),
      };
    } catch (error) {
      return { runs: [failedRun("layout", error)], issues: [] };
    }
  }

  // ── Frames ────────────────────────────────────────────────────────────────

  /** JPEG frames of a render at the given times, decoded once and cached until the render file changes. */
  async frames(
    project: ResolvedProject,
    request: QaFramesRequest,
    requestSignal: AbortSignal = new AbortController().signal,
  ): Promise<QaFramesResponse> {
    const signal = AbortSignal.any([requestSignal, this.shutdownController.signal]);
    const file = this.resolveRender(project, request.render);
    const info = await this.probeRender(file);
    const width = request.width ?? DEFAULT_FRAME_WIDTH;
    const last =
      info.duration === null ? Infinity : Math.max(0, info.duration - END_MARGIN_SECONDS);
    const dir = framesDirFor(project.dir, basename(file), file);
    try {
      const frames = await Promise.all(
        request.times.map(async (time): Promise<FrameImage> => {
          const grab = await grabFrame({
            inputPath: file,
            framesDir: dir,
            timeMs: Math.round(Math.min(time, last) * 1000),
            width,
            signal,
            ffmpegPath: this.options.ffmpegPath,
          });
          return {
            time,
            mimeType: "image/jpeg",
            data: await readFrameBase64(grab.file),
            cached: grab.cached,
          };
        }),
      );
      return { frames };
    } catch (error) {
      throw asQaFailure(error);
    }
  }

  // ── Reports ───────────────────────────────────────────────────────────────

  saveReport(project: ResolvedProject, input: QaReportInput): QaReport {
    const now = this.now();
    const report = writeReport(
      project.dir,
      input,
      now,
      resolveProjectSignature(this.adapter, project.dir),
    );
    this.running.add(input.sessionId);
    enforceRetention(this.retention(project, now));
    return report;
  }

  /**
   * Ends a QA session: its intermediate QA renders and their frames go (the render in `request.keep`, the one the
   * final report names, and any render that is not QA's own stay), and the retention of old reports runs. Reports
   * stay readable whether or not their render still exists.
   */
  finishSession(
    project: ResolvedProject,
    sessionId: string,
    request: QaFinishRequest,
  ): QaFinishResponse {
    this.running.delete(sessionId);
    return finishSession(this.retention(project, this.now()), sessionId, request);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private retention(project: ResolvedProject, now: number): RetentionContext {
    return {
      projectDir: project.dir,
      rendersDir: this.adapter.rendersDir(project),
      now,
      running: this.running,
    };
  }

  listReports(project: ResolvedProject): QaReportList {
    const fingerprint = resolveProjectSignature(this.adapter, project.dir);
    return { fingerprint, reports: listReports(project.dir, fingerprint) };
  }

  getReport(project: ResolvedProject, id: string): QaReport {
    const report = readReport(project.dir, id, resolveProjectSignature(this.adapter, project.dir));
    if (!report) throw new QaFailure("not_found", `There is no QA report "${id}"`);
    return report;
  }
}
