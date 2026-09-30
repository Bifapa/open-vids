import type {
  AnalysisJob,
  AnalysisOverview,
  CutPlan,
  CutPlanSummary,
  FrameImage,
  SegmentMap,
  ShotMap,
  SilenceMap,
  TakeIssue,
  TimeRange,
  TimelineSnapshot,
  TranscriptView,
  VisionAnalysis,
  VisionTarget,
  VisualProblem,
} from "@hyperframes/agent-protocol";
import { AnalysisToolError } from "./host.js";
import type { TimelineProblem } from "./roughCut.js";

/** Everything the analysis tools return is compact text for the model, capped at this many characters. */
export const RESULT_CHARS = 9_000;
/** A transcript page is the material the model reads to segment the video, so it may be longer. */
export const TRANSCRIPT_CHARS = 12_000;

export const ANALYSIS_SECTIONS = [
  "overview",
  "speakers",
  "silence",
  "shots",
  "takes",
  "segments",
  "vision",
  "cuts",
] as const;
export type AnalysisSection = (typeof ANALYSIS_SECTIONS)[number];

/** Seconds with at most two decimals: a value the model can pass straight back as an argument. */
const num = (value: number) => `${Number(value.toFixed(2))}`;

/** `mm:ss.s` (`h:mm:ss.s` from one hour on). */
export function clock(time: number): string {
  const tenths = Math.round(Math.max(0, time) * 10);
  const hours = Math.floor(tenths / 36_000);
  const minutes = Math.floor((tenths % 36_000) / 600);
  const rest = (tenths % 600) / 10;
  const seconds = rest.toFixed(1).padStart(4, "0");
  const mm = String(minutes).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${seconds}` : `${mm}:${seconds}`;
}

const span = (range: TimeRange) => `${clock(range.start)}–${clock(range.end)}`;

const cell = (value: string) => value.replace(/\s+/g, " ").trim();

/** Joins lines while they fit in the budget; the count of dropped lines is reported so the model can narrow down. */
function fitLines(lines: string[], budget: number, noun: string): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length < lines.length)
    kept.push(`… ${lines.length - kept.length} more ${noun} not shown`);
  return kept.join("\n");
}

function cap(text: string, limit = RESULT_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// ── Overview ─────────────────────────────────────────────────────────────────

function stagesLine(overview: AnalysisOverview, job: AnalysisJob | null): string {
  const parts = job
    ? job.results.map((result) => {
        const detail = result.detail ? ` — ${cell(result.detail)}` : "";
        const took = result.outcome === "computed" ? ` ${num(result.seconds)} s` : "";
        return `${result.stage} ${result.outcome}${took}${detail}`;
      })
    : overview.status.stages.map((stage) => {
        const detail = stage.detail ? ` — ${cell(stage.detail)}` : "";
        return `${stage.stage} ${stage.status}${detail}`;
      });
  return `Stages: ${parts.join(" · ")}`;
}

function transcriptLine(overview: AnalysisOverview): string {
  const { transcript } = overview;
  if (!transcript) return "Transcript: none (no speech recognizer result for this source).";
  const language = transcript.language ? ` · language ${transcript.language}` : "";
  return `Transcript: ${transcript.words} words · ${transcript.sentences} sentences${language} · speech ${clock(transcript.speechSeconds)} · version ${transcript.version} (pass it to save_segments)`;
}

function speakersBlock(overview: AnalysisOverview): string {
  const { speakers } = overview;
  if (!speakers) return "Speakers: not analyzed.";
  if (speakers.method === "single") {
    const note = speakers.note ? ` (${cell(speakers.note)})` : "";
    return `Speakers: one speaker assumed${note}.`;
  }
  const rows = speakers.speakers.map(
    (speaker) =>
      `${speaker.id}${speaker.label ? ` "${speaker.label}"` : ""} ${Math.round(speaker.share * 100)} % (${clock(speaker.seconds)})`,
  );
  return `Speakers (diarization, ${speakers.turns.length} turns): ${rows.join(", ")}`;
}

function silenceLine(overview: AnalysisOverview): string {
  const { silence } = overview;
  if (!silence) return "Pauses: not analyzed.";
  const longest = silence.longest
    .slice(0, 5)
    .map((range) => `${span(range)} (${num(range.end - range.start)} s)`)
    .join(", ");
  return `Pauses: ${silence.count} silences · ${num(silence.totalSeconds)} s in total · ${silence.over1s} of at least 1 s${longest ? `; longest ${longest}` : ""}`;
}

const problemText = (problem: VisualProblem) => `${problem.kind} ${span(problem)}`;

function shotsLine(overview: AnalysisOverview): string {
  const { shots } = overview;
  if (!shots) return "Shots: not analyzed.";
  const problems =
    shots.problems.length === 0
      ? "no black or frozen picture found"
      : `problems: ${shots.problems.map(problemText).join(", ")}`;
  return `Shots: ${shots.count} · average ${num(shots.averageSeconds)} s · ${problems}`;
}

function issueLine(issue: TakeIssue): string {
  const keep = issue.keep ? ` (keeps ${issue.keep})` : "";
  return `${issue.id} ${issue.kind} ${span(issue)} ${issue.sentences.join("+")} [${issue.action}] ${cell(issue.note)}${keep}`;
}

function takesBlock(overview: AnalysisOverview, budget: number): string {
  const { takes } = overview;
  if (!takes) return "Take issues: not analyzed.";
  const counts = Object.entries(takes.counts)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
  const head = `Take issues (${counts || "none"}; fillers and stutters are only counted — plan_cut removes fillers by default). "cut" = removed automatically, "review" = needs your decision:`;
  if (takes.issues.length === 0) return `${head}\nnone to list.`;
  return `${head}\n${fitLines(takes.issues.map(issueLine), budget, "issues")}`;
}

function segmentsBlock(segments: SegmentMap | null, budget: number, summaries: boolean): string {
  if (!segments) return "Segments: none yet.";
  const origin =
    segments.origin === "semantic"
      ? "semantic, written by an agent"
      : "draft from pauses and topic shifts — refine it with save_segments";
  const lines = segments.segments.map((segment) => {
    const summary = summaries ? `: ${cell(segment.summary).slice(0, 140)}` : "";
    return `${segment.id} ${span(segment)} ${segment.firstSentence}–${segment.lastSentence} · ${segment.role} · ${segment.priority} · "${cell(segment.title)}"${summary}`;
  });
  return `Segments (${segments.segments.length}, ${origin}):\n${fitLines(lines, budget, "segments")}`;
}

function visionTargetLine(target: VisionTarget): string {
  const ref = target.ref ? ` ${target.ref}` : "";
  return `${target.reason}${ref} ${span(target)} frames at ${target.times.map(num).join(", ")} s${target.inspected ? " (inspected)" : ""}`;
}

function visionBlock(overview: AnalysisOverview, budget: number, listNotes: boolean): string {
  const { vision, visionTargets } = overview;
  const open = visionTargets.filter((target) => !target.inspected);
  const head = vision
    ? `Vision: ${vision.notes.length} notes · ${vision.inspectedFrames} frames inspected`
    : "Vision: no notes yet";
  const lines = [head];
  if (listNotes && vision) {
    lines.push(
      ...vision.notes.map(
        (note) =>
          `${note.id} ${span(note)} ${note.quality} [${note.tags.join(", ")}] ${cell(note.finding).slice(0, 200)}`,
      ),
    );
  }
  lines.push(
    `Vision targets: ${visionTargets.length} suggested, ${open.length} not yet inspected${open.length > 0 ? " (inspect these with inspect_frames, at most 12 times per call):" : "."}`,
  );
  lines.push(...open.map(visionTargetLine));
  return fitLines(lines, budget, "lines");
}

function cutSummaryLine(plan: CutPlanSummary): string {
  const applied = plan.applied ? ` · applied to ${plan.applied.composition}` : " · not applied";
  const based = plan.basedOn ? ` · based on ${plan.basedOn}` : "";
  return `${plan.id} "${cell(plan.label)}" · ${clock(plan.stats.cutDuration)} from ${clock(plan.stats.sourceDuration)} · ${plan.stats.ranges} ranges${based}${applied}`;
}

function cutsBlock(cuts: CutPlanSummary[]): string {
  if (cuts.length === 0) return "Cut plans: none yet.";
  return `Cut plans (${cuts.length}):\n${cuts.map(cutSummaryLine).join("\n")}`;
}

/** The analysis of one source, compact. `job` (when an analysis just ran) adds what each stage did. */
export function formatOverview(overview: AnalysisOverview, job: AnalysisJob | null = null): string {
  const { status } = overview;
  const duration = status.duration !== null ? ` · ${clock(status.duration)}` : "";
  return cap(
    [
      `Analysis of ${status.source} (${status.kind}${duration})`,
      stagesLine(overview, job),
      transcriptLine(overview),
      speakersBlock(overview),
      silenceLine(overview),
      shotsLine(overview),
      takesBlock(overview, 1_800),
      segmentsBlock(overview.segments, 2_200, false),
      visionBlock(overview, 1_500, false),
      cutsBlock(overview.cuts.slice(-5)),
    ].join("\n"),
  );
}

/** One section of the analysis in full; `silences` and `shots` come from the complete artifact. */
export function formatSection(
  section: Exclude<AnalysisSection, "overview" | "silence" | "shots">,
  overview: AnalysisOverview,
): string {
  switch (section) {
    case "speakers": {
      const speakers = overview.speakers;
      const turns = speakers?.turns.map((turn) => `${turn.speaker} ${span(turn)}`) ?? [];
      return cap(
        [
          speakersBlock(overview),
          turns.length > 0 ? `Turns:\n${fitLines(turns, 6_000, "turns")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    case "takes":
      return cap(takesBlock(overview, 8_000));
    case "segments":
      return cap(segmentsBlock(overview.segments, 8_000, true));
    case "vision":
      return cap(visionBlock(overview, 8_000, true));
    case "cuts":
      return cap(cutsBlock(overview.cuts));
  }
}

export function formatSilence(silence: SilenceMap): string {
  const lines = silence.silences.map(
    (range) => `${span(range)} (${num(range.end - range.start)} s)`,
  );
  const head = `Pauses of ${silence.source}: ${silence.silences.length} silences of at least ${num(silence.minSilence)} s below ${num(silence.thresholdDb)} dB · ${num(silence.silenceSeconds)} s in total`;
  return cap(`${head}\n${fitLines(lines, 7_500, "silences")}`);
}

export function formatShots(shots: ShotMap): string {
  const lines = shots.shots.map((shot) => `${shot.id} ${span(shot)}`);
  const problems =
    shots.problems.length === 0
      ? "No black or frozen picture found."
      : `Problems:\n${shots.problems.map(problemText).join("\n")}`;
  return cap(
    `Shots of ${shots.source}: ${shots.shots.length}\n${problems}\n${fitLines(lines, 6_000, "shots")}`,
  );
}

// ── Transcript ───────────────────────────────────────────────────────────────

/** `s12 [01:02.3–01:05.8] S1: text`, sentences touched by a take issue end with `⟨t3 retake⟩`. */
export function formatTranscript(view: TranscriptView, issues: readonly TakeIssue[]): string {
  const marks = new Map<string, string[]>();
  for (const issue of issues) {
    for (const sentence of issue.sentences) {
      const list = marks.get(sentence) ?? [];
      list.push(`${issue.id} ${issue.kind}`);
      marks.set(sentence, list);
    }
  }
  const lines = view.sentences.map((sentence) => {
    const speaker = sentence.speaker ? ` ${sentence.speaker}:` : "";
    const marked = marks.get(sentence.id);
    return `${sentence.id} [${span(sentence)}]${speaker} ${cell(sentence.text)}${marked ? `  ⟨${marked.join("; ")}⟩` : ""}`;
  });
  const language = view.language ? ` · language ${view.language}` : "";
  const head = `Transcript ${clock(view.from)}–${clock(view.to)} · ${view.sentences.length} of ${view.totalSentences} sentences${language} · version ${view.version}`;
  if (lines.length === 0) return `${head}\nNo sentences in this window.`;
  const body = fitLines(lines, TRANSCRIPT_CHARS, "sentences");
  const shown = body.split("\n").filter((line) => !line.startsWith("… ")).length;
  const last = view.sentences[shown - 1];
  const more =
    shown < lines.length && last
      ? `\nContinue with read_transcript from=${num(last.end)} (seconds).`
      : "";
  return `${head}\n${body}${more}`;
}

// ── Frames ───────────────────────────────────────────────────────────────────

/** One line per frame, in the order of the images that follow. */
export function formatFrames(source: string, frames: readonly FrameImage[]): string {
  const rows = frames.map(
    (frame, index) =>
      `${index + 1}. ${num(frame.time)} s (${clock(frame.time)})${frame.cached ? " — cached" : ""}`,
  );
  return `${frames.length} frames of ${source}, attached in this order:\n${rows.join("\n")}`;
}

// ── Cut plans ────────────────────────────────────────────────────────────────

/** The kept segments in playing order (consecutive ranges of one segment collapse; the hook is named first). */
function playingOrder(plan: CutPlan): string {
  const order: string[] = [];
  for (const range of plan.ranges) {
    const name = range.hook ? "hook" : (range.segment ?? "—");
    if (order.at(-1) !== name) order.push(name);
  }
  return order.join(" → ");
}

export function formatCutPlan(plan: CutPlan): string {
  const { stats } = plan;
  const saved =
    stats.sourceDuration > 0
      ? ` (${Math.round((1 - stats.cutDuration / stats.sourceDuration) * 100)} % shorter)`
      : "";
  const removed = [
    stats.removedPauseSeconds > 0 ? `pauses ${num(stats.removedPauseSeconds)} s` : null,
    stats.removedFillers > 0 ? `fillers ${stats.removedFillers}` : null,
    stats.removedTakes > 0 ? `bad takes ${stats.removedTakes}` : null,
  ].filter((entry): entry is string => entry !== null);
  const hook = plan.request.hook
    ? `Hook: ${plan.request.hook.firstSentence}–${plan.request.hook.lastSentence}, ${num(stats.hookSeconds)} s.`
    : "";
  const lines = [
    `Cut plan ${plan.id} "${cell(plan.label)}" of ${plan.source}${plan.basedOn ? `, based on ${plan.basedOn}` : ""}`,
    `Length ${clock(stats.cutDuration)} from ${clock(stats.sourceDuration)}${saved} · ${stats.ranges} ranges · removed ${removed.join(", ") || "nothing"}`,
    stats.droppedSegments.length > 0 ? `Dropped segments: ${stats.droppedSegments.join(", ")}` : "",
    stats.movedSegments.length > 0 ? `Moved segments: ${stats.movedSegments.join(", ")}` : "",
    hook,
    `Order: ${cap(playingOrder(plan), 1_500)}`,
    plan.warnings.length > 0
      ? `Warnings:\n${plan.warnings.map((w) => `- ${cell(w)}`).join("\n")}`
      : "",
    `Build it on the timeline with build_rough_cut plan=${plan.id}.`,
  ];
  return cap(lines.filter(Boolean).join("\n"));
}

/**
 * The detected picture problems (black, frozen) that stay in a planned cut although no one looked at them yet, as one
 * line for the model, or "" when there are none.
 */
export function unseenPictureProblems(
  ranges: CutPlan["ranges"],
  targets: readonly VisionTarget[],
): string {
  const unseen = targets.filter(
    (target) =>
      target.reason === "visual_problem" &&
      !target.inspected &&
      ranges.some((range) => range.from < target.end && range.to > target.start),
  );
  if (unseen.length === 0) return "";
  const where = unseen
    .map(
      (target) =>
        `${clock(target.start)}–${clock(target.end)} (frames ${target.times.map(num).join(", ")})`,
    )
    .join("; ");
  return `Not yet inspected by Vision and kept in this cut: ${unseen.length} detected picture problem${unseen.length === 1 ? "" : "s"} at source ${where}. Have Vision (inspect_frames) confirm them before deciding how to cover them.`;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** What the model sees for a failed call: a stable code and the message. */
export function formatAnalysisError(error: AnalysisToolError): string {
  return `${error.code}: ${error.message}`;
}

// ── Saved artifacts and built cuts ───────────────────────────────────────────

export function formatSavedSegments(map: SegmentMap): string {
  const priorities = new Map<string, number>();
  for (const segment of map.segments)
    priorities.set(segment.priority, (priorities.get(segment.priority) ?? 0) + 1);
  const counts = [...priorities].map(([priority, n]) => `${priority} ${n}`).join(", ");
  return cap(
    `Saved ${map.segments.length} segments (${counts}) for the transcript version ${map.transcriptVersion}. plan_cut now uses them.\n${segmentsBlock(map, 6_000, false)}`,
  );
}

export function formatSavedVisionNotes(saved: number, vision: VisionAnalysis): string {
  return `Saved ${saved} visual ${saved === 1 ? "note" : "notes"}. The source now has ${vision.notes.length} notes and ${vision.inspectedFrames.length} inspected frames; the planner and the Editor use them.`;
}

export function formatBuiltCut(built: {
  plan: CutPlan;
  track: number;
  clips: number;
  length: number;
  replacedClips: number;
  timeline: TimelineSnapshot;
  problems: TimelineProblem[];
  /** Why the plan could not be recorded as applied, when it could not. */
  recordFailure: string | null;
}): string {
  const { plan, timeline } = built;
  const replaced =
    built.replacedClips > 0
      ? ` It replaced ${built.replacedClips} earlier ${built.replacedClips === 1 ? "clip" : "clips"} of ${plan.source}.`
      : "";
  const lines = [
    `Built ${plan.id} "${cell(plan.label)}" on ${timeline.composition.path}, track ${built.track}: ${built.clips} clips, ${clock(built.length)} long (${num(built.length)} s), composition length ${num(timeline.composition.duration)} s.${replaced} Timeline version ${timeline.version}. The Studio timeline and preview update by themselves.`,
  ];
  if (built.problems.length > 0) {
    const rows = built.problems
      .slice(0, 20)
      .map(
        (problem) =>
          `- ${problem.kind} at ${clock(problem.start)}–${clock(problem.end)} (${num(problem.start)}–${num(problem.end)} s on the timeline; source ${clock(problem.sourceStart)}–${clock(problem.sourceEnd)})`,
      );
    if (built.problems.length > rows.length)
      rows.push(`… ${built.problems.length - rows.length} more not shown`);
    lines.push(
      `Kept material that overlaps a picture problem — cover it (B-roll on a higher track) or trim it with edit_timeline:`,
      ...rows,
    );
  }
  if (built.recordFailure)
    lines.push(
      `The cut is on the timeline, but the plan could not be recorded as applied (${built.recordFailure}).`,
    );
  lines.push("Verify the result with inspect_timeline.");
  return cap(lines.join("\n"));
}
