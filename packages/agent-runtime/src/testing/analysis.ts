import type {
  AnalysisJob,
  AnalysisOverview,
  AnalyzeRequest,
  CutPlan,
  CutPlanRequest,
  CutPlanSummary,
  CutRange,
  FrameImage,
  FramesRequest,
  FramesResponse,
  SaveSegmentsRequest,
  SaveVisionNotesRequest,
  SegmentMap,
  ShotMap,
  SilenceMap,
  StageResult,
  TranscriptView,
  TranscriptWord,
  VisionAnalysis,
  VisionNote,
} from "@hyperframes/agent-protocol";
import { AnalysisToolError, type AnalysisHost } from "../analysis/host.js";

/** The source the default fixtures describe. */
export const SAMPLE_SOURCE = "assets/raw-talk.mp4";

/** A tiny valid base64 payload standing in for a JPEG. */
export const FAKE_JPEG = Buffer.from("fake-jpeg-frame").toString("base64");

const FAKE_VERSION = "sha256:aaaa";

export function sampleOverview(source: string = SAMPLE_SOURCE): AnalysisOverview {
  return {
    status: {
      source,
      kind: "video",
      duration: 1_420,
      fingerprint: null,
      stages: [
        { stage: "transcript", status: "fresh", updatedAt: 1, version: FAKE_VERSION, detail: null },
        { stage: "shots", status: "fresh", updatedAt: 1, version: FAKE_VERSION, detail: null },
      ],
    },
    transcript: {
      version: FAKE_VERSION,
      language: "en",
      words: 3_600,
      sentences: 3,
      speechSeconds: 1_100,
    },
    speakers: {
      source,
      method: "diarization",
      speakers: [
        { id: "S1", label: null, seconds: 900, share: 0.82 },
        { id: "S2", label: null, seconds: 200, share: 0.18 },
      ],
      turns: [],
      note: null,
    },
    silence: {
      count: 120,
      totalSeconds: 96,
      longest: [{ start: 41, end: 44.9 }],
      over1s: 12,
    },
    shots: {
      count: 4,
      averageSeconds: 355,
      problems: [{ kind: "black", start: 100, end: 102 }],
    },
    takes: {
      counts: { retake: 1, filler: 30 },
      issues: [
        {
          id: "t1",
          kind: "retake",
          start: 10,
          end: 14,
          sentences: ["s1", "s2"],
          confidence: 0.9,
          action: "cut",
          note: "s1 is re-said as s2",
          keep: "s2",
        },
      ],
    },
    segments: null,
    vision: null,
    visionTargets: [
      {
        start: 100,
        end: 102,
        reason: "visual_problem",
        ref: "k2",
        times: [100.5, 101.5],
        inspected: false,
      },
    ],
    cuts: [],
  };
}

export function sampleTranscript(source: string = SAMPLE_SOURCE): TranscriptView {
  return {
    source,
    version: FAKE_VERSION,
    language: "en",
    from: 0,
    to: 30,
    totalSentences: 3,
    sentences: [
      {
        id: "s1",
        start: 10,
        end: 12,
        firstWord: 0,
        lastWord: 3,
        text: "So the thing is",
        speaker: "S1",
      },
      {
        id: "s2",
        start: 12.5,
        end: 15,
        firstWord: 4,
        lastWord: 9,
        text: "The thing is simple",
        speaker: "S1",
      },
      {
        id: "s3",
        start: 20,
        end: 30,
        firstWord: 10,
        lastWord: 30,
        text: "Here is the rest.",
        speaker: "S1",
      },
    ],
  };
}

/** One word per index of every sentence, spread evenly over the sentence. */
export function sampleWords(sentences: TranscriptView["sentences"]): TranscriptWord[] {
  return sentences.flatMap((sentence) => {
    const count = sentence.lastWord - sentence.firstWord + 1;
    const length = (sentence.end - sentence.start) / count;
    return Array.from({ length: count }, (_, index): TranscriptWord => {
      const start = Number((sentence.start + index * length).toFixed(3));
      return {
        i: sentence.firstWord + index,
        text: `w${sentence.firstWord + index}`,
        start,
        end: Number((start + length).toFixed(3)),
        speaker: sentence.speaker,
      };
    });
  });
}

const SAMPLE_RANGES: CutRange[] = [
  { from: 12.5, to: 15, at: 0, segment: "g1", hook: false },
  { from: 20, to: 30, at: 2.5, segment: "g2", hook: false },
  { from: 100.5, to: 104, at: 12.5, segment: "g3", hook: false },
];

/**
 * Deterministic in-memory analysis host for runtime tests and embedding harnesses. It records every request and
 * answers from the fields below. A job stays `running` for {@link runningPolls} polls, or until {@link jobGate}
 * resolves, so tests can hold an analysis open across a turn's end; cancelling it is recorded in {@link cancelledJobs}.
 */
export class FakeAnalysisHost implements AnalysisHost {
  overviewResult: AnalysisOverview = sampleOverview();
  transcriptResult: TranscriptView = sampleTranscript();
  silenceResult: SilenceMap = {
    source: SAMPLE_SOURCE,
    thresholdDb: -35,
    minSilence: 0.3,
    silences: [{ start: 41, end: 44.9 }],
    silenceSeconds: 3.9,
  };
  shotsResult: ShotMap = {
    source: SAMPLE_SOURCE,
    sceneThreshold: 0.3,
    shots: [{ id: "k1", start: 0, end: 1_420 }],
    problems: [{ kind: "black", start: 100, end: 102 }],
  };
  jobResults: StageResult[] = [
    { stage: "silence", outcome: "cached", seconds: 0, detail: null },
    { stage: "transcript", outcome: "computed", seconds: 12.5, detail: null },
  ];
  /** The ranges every planned cut gets. */
  planRanges: CutRange[] = SAMPLE_RANGES;
  /** Polls that report a started job as running before it completes. */
  runningPolls = 0;
  /** While set (and unresolved), started jobs stay running. */
  jobGate: Promise<void> | null = null;
  /** The next call of any route rejects with this error. */
  nextError: AnalysisToolError | null = null;

  readonly startRequests: AnalyzeRequest[] = [];
  readonly startSignals: AbortSignal[] = [];
  readonly cancelledJobs: string[] = [];
  readonly overviewRequests: string[] = [];
  readonly transcriptRequests: Array<{
    source: string;
    from?: number;
    to?: number;
    words?: boolean;
  }> = [];
  readonly artifactRequests: string[] = [];
  readonly segmentRequests: SaveSegmentsRequest[] = [];
  readonly visionRequests: SaveVisionNotesRequest[] = [];
  readonly frameRequests: FramesRequest[] = [];
  readonly planRequests: CutPlanRequest[] = [];
  readonly cutPlans = new Map<string, CutPlan>();

  private jobCount = 0;
  private pollsLeft = 0;
  private gateOpen = false;
  private readonly notes: VisionNote[] = [];
  private readonly inspected = new Set<number>();

  private guard(signal: AbortSignal): void {
    if (signal.aborted) throw new AnalysisToolError("aborted", "The operation was cancelled.");
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
  }

  private job(id: string, source: string, status: AnalysisJob["status"]): AnalysisJob {
    return {
      id,
      source,
      status,
      stage: status === "running" ? "transcript" : null,
      progress: status === "running" ? 40 : 100,
      results: status === "running" ? [] : structuredClone(this.jobResults),
      error: null,
      startedAt: 1,
      finishedAt: status === "running" ? null : 2,
    };
  }

  async startJob(request: AnalyzeRequest, signal: AbortSignal): Promise<AnalysisJob> {
    this.guard(signal);
    this.startRequests.push(request);
    this.startSignals.push(signal);
    this.jobCount += 1;
    this.pollsLeft = this.runningPolls;
    this.gateOpen = this.jobGate === null;
    void this.jobGate?.then(() => {
      this.gateOpen = true;
    });
    const running = this.pollsLeft > 0 || !this.gateOpen;
    return this.job(`job-${this.jobCount}`, request.source, running ? "running" : "completed");
  }

  async getJob(jobId: string, signal: AbortSignal): Promise<AnalysisJob> {
    this.guard(signal);
    const source = this.startRequests.at(-1)?.source ?? SAMPLE_SOURCE;
    if (this.cancelledJobs.includes(jobId)) return this.job(jobId, source, "cancelled");
    if (!this.gateOpen) return this.job(jobId, source, "running");
    if (this.pollsLeft > 0) {
      this.pollsLeft -= 1;
      return this.job(jobId, source, "running");
    }
    return this.job(jobId, source, "completed");
  }

  async cancelJob(jobId: string, _signal: AbortSignal): Promise<AnalysisJob> {
    this.cancelledJobs.push(jobId);
    return this.job(jobId, this.startRequests.at(-1)?.source ?? SAMPLE_SOURCE, "cancelled");
  }

  async overview(source: string, signal: AbortSignal): Promise<AnalysisOverview> {
    this.guard(signal);
    this.overviewRequests.push(source);
    return structuredClone(this.overviewResult);
  }

  async transcript(
    source: string,
    window: { from?: number; to?: number; words?: boolean },
    signal: AbortSignal,
  ): Promise<TranscriptView> {
    this.guard(signal);
    this.transcriptRequests.push({ source, ...window });
    const view = structuredClone(this.transcriptResult);
    if (window.words) view.words = sampleWords(view.sentences);
    return view;
  }

  artifact(source: string, stage: "silence", signal: AbortSignal): Promise<SilenceMap>;
  artifact(source: string, stage: "shots", signal: AbortSignal): Promise<ShotMap>;
  async artifact(
    source: string,
    stage: "silence" | "shots",
    signal: AbortSignal,
  ): Promise<SilenceMap | ShotMap> {
    this.guard(signal);
    this.artifactRequests.push(`${source}:${stage}`);
    return structuredClone(stage === "silence" ? this.silenceResult : this.shotsResult);
  }

  async saveSegments(request: SaveSegmentsRequest, signal: AbortSignal): Promise<SegmentMap> {
    this.guard(signal);
    if (request.transcriptVersion !== this.transcriptResult.version) {
      throw new AnalysisToolError("conflict", "The transcript changed since it was read.");
    }
    this.segmentRequests.push(request);
    const sentences = this.transcriptResult.sentences;
    return {
      source: request.source,
      origin: "semantic",
      transcriptVersion: request.transcriptVersion,
      segments: request.segments.map((segment, index) => ({
        ...segment,
        id: `g${index + 1}`,
        start: sentences.find((s) => s.id === segment.firstSentence)?.start ?? 0,
        end: sentences.find((s) => s.id === segment.lastSentence)?.end ?? 0,
        speaker: null,
      })),
    };
  }

  async saveVisionNotes(
    request: SaveVisionNotesRequest,
    signal: AbortSignal,
  ): Promise<VisionAnalysis> {
    this.guard(signal);
    this.visionRequests.push(request);
    for (const note of request.notes) {
      for (const time of note.frames) this.inspected.add(time);
      this.notes.push({ ...note, id: `v${this.notes.length + 1}`, createdAt: 1 });
    }
    return {
      source: request.source,
      notes: structuredClone(this.notes),
      inspectedFrames: [...this.inspected].sort((a, b) => a - b),
    };
  }

  async frames(request: FramesRequest, signal: AbortSignal): Promise<FramesResponse> {
    this.guard(signal);
    this.frameRequests.push(request);
    const frames = request.times.map((time): FrameImage => {
      const cached = this.inspected.has(time);
      this.inspected.add(time);
      return { time, mimeType: "image/jpeg", data: FAKE_JPEG, cached };
    });
    return { source: request.source, frames };
  }

  async planCut(request: CutPlanRequest, signal: AbortSignal): Promise<CutPlan> {
    this.guard(signal);
    this.planRequests.push(request);
    const cutDuration = this.planRanges.reduce((sum, range) => sum + range.to - range.from, 0);
    const plan: CutPlan = {
      id: `cut-${this.cutPlans.size + 1}`,
      source: request.source,
      label: request.label ?? "rough cut",
      createdAt: 1,
      basedOn: request.basedOn ?? null,
      stats: {
        sourceDuration: 1_420,
        cutDuration,
        ranges: this.planRanges.length,
        removedPauseSeconds: 40,
        removedFillers: 12,
        removedTakes: 1,
        droppedSegments: [],
        movedSegments: [],
        hookSeconds: 0,
      },
      applied: null,
      request,
      transcriptVersion: FAKE_VERSION,
      segmentsVersion: FAKE_VERSION,
      ranges: structuredClone(this.planRanges),
      removed: [],
      warnings: [],
    };
    this.cutPlans.set(plan.id, plan);
    return structuredClone(plan);
  }

  async listCuts(source: string | undefined, signal: AbortSignal): Promise<CutPlanSummary[]> {
    this.guard(signal);
    return [...this.cutPlans.values()]
      .filter((plan) => source === undefined || plan.source === source)
      .map((plan) => structuredClone(plan));
  }

  async getCut(planId: string, signal: AbortSignal): Promise<CutPlan> {
    this.guard(signal);
    const plan = this.cutPlans.get(planId);
    if (!plan) throw new AnalysisToolError("unknown_plan", `There is no cut plan ${planId}.`);
    return structuredClone(plan);
  }
}
