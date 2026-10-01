import {
  AGENT_DISPLAY_NAMES,
  type ExecutionBudget,
  type ExecutionQualityPreset,
  type QaIssue,
  type QaIssueDraft,
  type QaOwner,
  type QaSample,
  type QaVisionRun,
  type SpecialistId,
  type TurnQaStatus,
} from "@hyperframes/agent-protocol";

const PRESET_NAMES: Record<ExecutionQualityPreset, string> = {
  fast: "Fast",
  balanced: "Balanced",
  best: "Best",
  custom: "Custom",
};

const range = (issue: QaIssueDraft): string =>
  issue.end - issue.start < 0.05
    ? `${issue.start.toFixed(1)} s`
    : `${issue.start.toFixed(1)}–${issue.end.toFixed(1)} s`;

/** The Director's view of the turn's Execution Quality, in its team roster. */
export function executionTeamLine(
  execution: { preset: ExecutionQualityPreset; budget: ExecutionBudget },
  options: { qaAvailable: boolean; visionEnabled: boolean },
): string {
  const { preset, budget } = execution;
  const name = PRESET_NAMES[preset];
  const thinking = {
    economy: "Specialists think briefly (capped at low effort)",
    configured: "Specialists think as configured",
    thorough: "Specialists think hard (at least high effort)",
  }[budget.specialistThinking];
  let qa: string;
  if (!options.qaAvailable) {
    qa =
      "Render QA is not available in this runtime: nothing renders or checks your result automatically.";
  } else if (budget.qaPasses === 0) {
    qa = "Render QA is off: the runtime does not render or check the result on its own.";
  } else {
    const review = options.visionEnabled
      ? `plus Vision's review of up to ${budget.qaMaxFrames} frames`
      : "without a visual review, because Vision is not enabled";
    const corrections = budget.qaPasses - 1;
    qa = `Render QA: after your work the runtime renders a preview and checks the render (black and frozen picture, audio gaps, flash clips, layout, ${review}); while fixable issues remain it asks you to delegate corrections — at most ${budget.qaPasses} ${budget.qaPasses === 1 ? "pass" : "passes"} (${corrections} ${corrections === 1 ? "correction" : "corrections"}). Do not render only to verify your own work — the runtime does that; render yourself only when the user asks for a render or an export. Do not tell the user the job is finished before QA: your final report comes after it.`;
  }
  return `Execution quality: ${name}. ${qa} ${thinking}; Research compares up to ${budget.researchCandidates} candidates per search; long-form analysis may inspect up to ${budget.analysisFramesPerSource} frames per source.`;
}

// ── Vision's review task ─────────────────────────────────────────────────────

export interface VisionTaskInput {
  pass: number;
  limit: number;
  render: string;
  composition: string;
  duration: number;
  samples: readonly QaSample[];
  /** What the deterministic checks already found on this render. */
  deterministic: readonly QaIssueDraft[];
  /** Issues Vision itself reported on the previous pass and that were open after it. */
  previousVision: readonly QaIssue[];
  budget: Pick<ExecutionBudget, "qaMaxFrames" | "critiqueRounds">;
}

/** The task of the runtime-started Vision run that reviews one pass's render. */
export function renderVisionTask(input: VisionTaskInput): string {
  const { budget } = input;
  const samples = input.samples.map(
    (sample) => `- ${sample.time.toFixed(1)} s · ${sample.reason} · ${sample.context}`,
  );
  const known = input.deterministic.map(
    (issue) => `- ${issue.severity} ${issue.kind} ${range(issue)} — ${issue.message}`,
  );
  const previous = input.previousVision.map(
    (issue) =>
      `- ${issue.id} ${issue.kind} ${range(issue)}${issue.subject ? ` (${issue.subject})` : ""} — ${issue.message}`,
  );
  return [
    `Render QA review, pass ${input.pass} of ${input.limit}. You review the RENDERED video ${input.render} (${input.duration.toFixed(1)} s, composition ${input.composition}) as a viewer would — not the timeline and not the source files.`,
    `Budget: ${budget.qaMaxFrames} frames in total, at most ${budget.critiqueRounds} inspect_render ${budget.critiqueRounds === 1 ? "call" : "calls"} (rounds), at most 12 frames per call. A call beyond the budget is refused.`,
    `Workflow: 1) call inspect_render with the most telling sample times below (the first round should cover the list as far as the budget allows, prioritising suspects, B-roll and captions); 2) use a later round only to look closer at something suspicious; 3) call report_render_findings ONCE with everything you found (an empty list when nothing is wrong), then finish with one sentence.`,
    `Content fit is YOUR job — no deterministic check judges it: for every title, on-screen text, picture and B-roll clip, compare its subject with what is said there ("said around here" in the sample context) and with the story node's need. A title, text or B-roll about a different subject than the talk (for example a cooking title over a talk about audio gear) is visual_mismatch (text/titles, owner motion) or incorrect_broll (B-roll, owner editor), even when a deterministic check already reported a layout problem at the same time.`,
    `Also look for: captions or titles overlapping each other or other graphics (caption_collision, layout_overlap); text cut off or outside the frame (out_of_bounds); black, blank or broken frames (black_frames); jarring cuts, flashes or a wrong cut point (awkward_cut); missing B-roll or an empty overlay (missing_broll); anything else that looks wrong (other). Report only what you can see in the frames, with times in seconds of the rendered video, the clip ids from the sample context where you know them, who should correct it (editor: cuts, B-roll choice, timing; motion: titles, captions, graphics and layout; audio: sound; research: missing or wrong outside material) and a concrete suggestion. fixable is true when an edit of the project can fix it. Give a subject (a clip id, caption text or asset path) when the thing itself can be named, so the same problem is recognised on the next pass. Do not repeat what the deterministic checks already found (their list covers layout, timing and signal problems only).`,
    `Frame times to look at (seconds of the rendered video, with what the timeline shows there):\n${samples.length > 0 ? samples.join("\n") : "- (none planned: choose your own times, evenly over the video)"}`,
    `Already found by the deterministic checks (do not repeat):\n${known.length > 0 ? known.join("\n") : "- nothing"}`,
    previous.length > 0
      ? `Issues you reported on the previous pass that were open after it — look at those times again and report an issue again only if it is still there:\n${previous.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ── Director prompts ─────────────────────────────────────────────────────────

const issueLine = (issue: QaIssue, marker: string): string => {
  const parts = [
    `${issue.severity} · ${issue.kind} · ${range(issue)}`,
    issue.clipIds.length > 0 ? `clips ${issue.clipIds.join(", ")}` : "",
    issue.subject ? `subject ${issue.subject}` : "",
    issue.source === "vision" ? "seen by Vision" : `found by ${issue.check}`,
  ].filter(Boolean);
  return `- [${issue.id}]${marker} ${parts.join(" · ")}\n  ${issue.message}${issue.suggestion ? `\n  Suggestion: ${issue.suggestion}` : ""}`;
};

function marker(issue: QaIssue, pass: number): string {
  if (issue.status === "persisting") return ` (still present since pass ${issue.firstSeenPass})`;
  if (issue.status === "reappeared") return ` (REAPPEARED: fixed earlier, back now)`;
  return issue.status === "new" && pass > 1 ? " (NEW after the last correction)" : "";
}

const ownerLabel = (owner: QaOwner | null): string =>
  owner === null ? "Editor (no owner named)" : AGENT_DISPLAY_NAMES[owner];

export interface CorrectionInput {
  pass: number;
  limit: number;
  render: { path: string; duration: number } | null;
  renderError: string | null;
  vision: QaVisionRun;
  /** Open issues after this pass. */
  issues: readonly QaIssue[];
  /** Issues of the previous pass that are gone. */
  resolved: readonly QaIssue[];
  enabled: readonly SpecialistId[];
  steering: readonly string[];
}

function visionLine(vision: QaVisionRun): string {
  if (vision.status === "ran")
    return `Vision reviewed ${vision.frames} ${vision.frames === 1 ? "frame" : "frames"} in ${vision.rounds} ${vision.rounds === 1 ? "round" : "rounds"}.`;
  return `Vision's review did not happen (${vision.status}${vision.reason ? `: ${vision.reason}` : ""}); only the deterministic checks stand, so picture problems they cannot see are unchecked.`;
}

const steeringBlocks = (steering: readonly string[]): string =>
  steering.map((text) => `<user-steering>\n${text}\n</user-steering>`).join("\n\n");

/** The prompt that asks the Director to delegate the corrections of one QA pass. */
export function renderCorrectionPrompt(input: CorrectionInput): string {
  const { pass, limit } = input;
  const fixable = input.issues.filter((issue) => issue.fixable);
  const informational = input.issues.filter((issue) => !issue.fixable);
  const owners = new Map<QaOwner | null, QaIssue[]>();
  for (const issue of fixable) {
    const group = owners.get(issue.owner) ?? [];
    group.push(issue);
    owners.set(issue.owner, group);
  }
  const groups = [...owners.entries()].map(([owner, issues]) => {
    const unavailable =
      owner !== null && !input.enabled.includes(owner)
        ? ` — ${AGENT_DISPLAY_NAMES[owner]} is not enabled in this chat: fix these yourself where you can, otherwise tell the user`
        : "";
    return `${ownerLabel(owner)}${unavailable}:\n${issues.map((issue) => issueLine(issue, marker(issue, pass))).join("\n")}`;
  });
  const changes: string[] = [];
  if (pass > 1) {
    const regressions = input.issues.filter((issue) => issue.status === "new");
    const persisting = input.issues.filter((issue) => issue.status === "persisting");
    const back = input.issues.filter((issue) => issue.status === "reappeared");
    changes.push(
      `Since the previous pass — fixed: ${input.resolved.length > 0 ? input.resolved.map((issue) => issue.id).join(", ") : "nothing"}; still present: ${persisting.length > 0 ? persisting.map((issue) => issue.id).join(", ") : "none"}; reappeared: ${back.length > 0 ? back.map((issue) => issue.id).join(", ") : "none"}; new after your last correction: ${regressions.length > 0 ? `${regressions.map((issue) => issue.id).join(", ")} — a regression your correction caused, fix it too and do not undo what was fixed` : "none"}.`,
    );
  }
  const left = limit - pass;
  return [
    `<render-qa pass="${pass}" limit="${limit}">`,
    input.render
      ? `Render QA checked the render ${input.render.path} (${input.render.duration.toFixed(1)} s), pass ${pass} of ${limit}. ${visionLine(input.vision)}`
      : `Render QA could not render the composition in pass ${pass} of ${limit}: ${input.renderError ?? "the render failed"}. Nothing could be checked. Find what makes the render fail (inspect the timeline: missing or unreadable files, invalid clips, a broken composition) and fix it.`,
    ...changes,
    groups.length > 0
      ? `Open issues to correct (${fixable.length}), by owner:\n${groups.join("\n")}`
      : "",
    informational.length > 0
      ? `Open issues that cannot be fixed by an edit (for information, leave them):\n${informational.map((issue) => issueLine(issue, marker(issue, pass))).join("\n")}`
      : "",
    `Delegate each group to its owner (Editor: cuts, B-roll choice, timing, gaps; Motion: titles, captions, graphics, layout; Audio: music and sound; Research: missing or wrong outside material, only if it is enabled and the policy allows) with a SELF-CONTAINED task: the issue ids, the times in seconds of the render (they are timeline times), the clip ids, what is wrong and the suggestion. Do the work yourself only when no specialist is enabled for it. Then wait_for_agents and check the result with inspect_timeline. Change only what the issues are about; keep everything that was fine. Do NOT render: the runtime re-renders and re-checks after your correction (${left} ${left === 1 ? "pass" : "passes"} left after this one). Do not report the job as finished yet: the final report comes after QA.`,
    steeringBlocks(input.steering),
    `</render-qa>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const OUTCOME_TEXT: Record<TurnQaStatus, string> = {
  running: "QA is still running",
  passed: "the last pass found no open issue",
  issues_remain: "open issues remain",
  skipped: "QA did not run",
  failed: "QA could not complete",
  aborted: "QA was stopped",
};

export interface FinalInput {
  status: TurnQaStatus;
  reason: string | null;
  passes: number;
  limit: number;
  corrections: number;
  lastRender: { path: string; duration: number; quality: string } | null;
  renderError: string | null;
  vision: QaVisionRun | null;
  open: readonly QaIssue[];
  /** Issues QA saw and that are gone now. */
  fixed: readonly QaIssue[];
  steering: readonly string[];
}

/**
 * The last block of a Director prompt given before QA, in a turn QA applies to: the reply it asks for is an interim
 * progress note, not the answer (the prompt's end outweighs the system prompt for the models that ignore the latter).
 */
export function renderInterimInstruction(): string {
  return [
    `<render-qa-pending>`,
    `The runtime renders and checks the result after your reply whenever this turn changed the project (by you or by your team) or rendered it, and sends you the outcome afterwards; the final report to the user comes after that check.`,
    `So your reply now is an interim progress note, not the answer: say briefly what you did and that the result is about to be checked. Do NOT say or imply that the video or the work is done, ready, finished, complete or good to go — it is not until the check is over. (If this turn neither changed nor rendered the project, just answer the user normally.)`,
    `</render-qa-pending>`,
  ].join("\n");
}

/**
 * The Director was told a check would follow, but QA did not run (off, too long to render unasked, service down):
 * its earlier reply is interim, so it gets one more prompt for the real final answer.
 */
export function renderSkippedPrompt(reason: string, steering: readonly string[]): string {
  return [
    `<render-qa-skipped>`,
    `Render QA did not run for this turn: ${reason}`,
    `This is your final answer to the user: say briefly what was done, that the result was NOT rendered or checked and why (in plain words), and what they can do (e.g. ask for a render or an export to get it rendered and checked). Do not claim a render or a check that did not happen. Do not edit, delegate, render, import or build anything: those tools are refused now.`,
    steeringBlocks(steering),
    `</render-qa-skipped>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The prompt that asks the Director for the final report once QA is over. */
export function renderFinalPrompt(input: FinalInput): string {
  const line = (issue: QaIssue) =>
    `- [${issue.id}] ${issue.kind} ${range(issue)} — ${issue.message}`;
  return [
    `<render-qa-final outcome="${input.status}">`,
    `Render QA is over: ${OUTCOME_TEXT[input.status]} after ${input.passes} of ${input.limit} ${input.limit === 1 ? "pass" : "passes"} (${input.corrections} ${input.corrections === 1 ? "correction" : "corrections"}).${input.reason ? ` ${input.reason}` : ""}`,
    input.lastRender
      ? `The last render is ${input.lastRender.path} (${input.lastRender.duration.toFixed(1)} s, ${input.lastRender.quality} quality${input.lastRender.quality === "draft" ? ", a preview; the user can ask for a final export" : ""}). It is the current state of the project unless the user changed it since.`
      : input.renderError
        ? `The last render failed: ${input.renderError}. There is no render of the current project.`
        : "",
    input.vision ? visionLine(input.vision) : "",
    input.fixed.length > 0
      ? `Fixed during QA (${input.fixed.length}):\n${input.fixed.map(line).join("\n")}`
      : "",
    input.open.length > 0
      ? `Still open (${input.open.length}):\n${input.open.map(line).join("\n")}`
      : "",
    `This is your final answer to the user: write the final report for them now — what was done, where the render is, what QA fixed and what remains — specific and honest. Do not claim the result is flawless while issues are open, and do not claim a visual check that did not happen. Do not edit, delegate, render, import or build anything: those tools are refused now.`,
    steeringBlocks(input.steering),
    `</render-qa-final>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
