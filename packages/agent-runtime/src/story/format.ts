import {
  STORY_CONTENT_FIELDS,
  isChapter,
  type ChapterNode,
  type StoryAttachment,
  type StoryBuildResult,
  type StoryEditResponse,
  type StoryGraph,
  type StoryManualEdit,
  type StoryMaterialNode,
  type StoryNode,
  type StoryRebuildResult,
  type StorySyncAction,
  type StorySyncReport,
  type StorySyncSection,
  type StorySyncUnit,
  type StoryView,
} from "@hyperframes/agent-protocol";
import { clock } from "../analysis/format.js";
import { StoryToolError } from "./host.js";

/** Everything the story tools return is compact text for the model, capped at this many characters. */
export const RESULT_CHARS = 14_000;

const num = (value: number) => `${Number(value.toFixed(2))}`;
const cell = (value: string) => value.replace(/\s+/g, " ").trim();

function cap(text: string, limit = RESULT_CHARS): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit - 60)}\n… the story is longer than this view; ask for less or work chapter by chapter`;
}

/** `00:30.0 (30 s)`: readable and directly usable as an argument. */
const duration = (seconds: number) => `${clock(seconds)} (${num(seconds)} s)`;

const SET_BY_USER = "(set by user)";

function quoted(title: string): string {
  return `"${cell(title)}"`;
}

function nodeLabel(node: StoryNode): string {
  return `${node.id} ${quoted(node.title)}`;
}

function userSet(node: StoryNode, field: string): string {
  return node.userEdited.some((edited) => edited === field) ? ` ${SET_BY_USER}` : "";
}

function textLine(node: StoryNode, label: string, field: string, value: string): string | null {
  const text = cell(value);
  return text ? `  ${label}${userSet(node, field)}: ${text}` : null;
}

function rangesLine(chapter: ChapterNode): string | null {
  if (chapter.sourceRanges.length === 0) return null;
  const rows = chapter.sourceRanges.map(
    (range) =>
      `${range.source} ${clock(range.from)}–${clock(range.to)} (${num(range.from)}–${num(range.to)} s)${range.segment ? ` ${range.segment}` : ""}`,
  );
  return `  ranges${userSet(chapter, "sourceRanges")}: ${rows.join("; ")}`;
}

function attachmentText(attachment: StoryAttachment, node: StoryNode | undefined): string {
  const parts: string[] = [attachment.placement];
  if (attachment.offset !== null) parts.push(`at +${num(attachment.offset)} s`);
  if (attachment.duration !== null) parts.push(`${num(attachment.duration)} s`);
  if (attachment.createdBy === "user") parts.push("added by user");
  const label = node ? `${node.kind} ${nodeLabel(node)}` : attachment.node;
  return `${label} [${parts.join(", ")}]`;
}

function chapterBlock(
  chapter: ChapterNode,
  index: number,
  graph: StoryGraph,
  view: StoryView,
): string[] {
  const facts = view.facts[chapter.id];
  const head = [
    `${index}. ${nodeLabel(chapter)}`,
    chapter.locked ? "LOCKED" : null,
    chapter.createdBy === "user" ? "created by user" : null,
    `role ${chapter.narrativeRole}`,
    chapter.status,
    `estimated ${duration(chapter.estimatedDuration)}${userSet(chapter, "estimatedDuration")}`,
    typeof facts?.materialDuration === "number"
      ? `material ${duration(facts.materialDuration)}`
      : null,
    chapter.captions ? `captions on${userSet(chapter, "captions")}` : null,
  ].filter(Boolean);
  const lines = [head.join(" · ")];
  if (userSet(chapter, "title")) lines.push(`  title ${SET_BY_USER}`);
  lines.push(
    ...[
      textLine(chapter, "purpose", "purpose", chapter.purpose),
      textLine(chapter, "description", "description", chapter.description),
      rangesLine(chapter),
      textLine(chapter, "A-roll", "aRoll", chapter.aRoll),
      textLine(chapter, "B-roll", "bRoll", chapter.bRoll),
      textLine(chapter, "graphics", "graphics", chapter.graphics),
      textLine(chapter, "audio", "audio", chapter.audio),
    ].filter((line): line is string => line !== null),
  );
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const attached = graph.attachments
    .filter((attachment) => attachment.chapter === chapter.id)
    .map((attachment) => attachmentText(attachment, nodes.get(attachment.node)));
  if (attached.length > 0) lines.push(`  attached: ${attached.join("; ")}`);
  const built = facts?.timeline;
  if (built)
    lines.push(
      `  on the timeline: ${clock(built.start)}–${clock(built.end)} (${built.clips} ${built.clips === 1 ? "clip" : "clips"})`,
    );
  return lines;
}

function materialLine(node: StoryMaterialNode, graph: StoryGraph): string {
  const chapters = graph.attachments
    .filter((attachment) => attachment.node === node.id)
    .map((attachment) => attachment.chapter);
  const used = chapters.length > 0 ? `attached to ${chapters.join(", ")}` : "not attached";
  const flags = [
    node.locked ? "LOCKED" : null,
    node.createdBy === "user" ? "created by user" : null,
    used,
  ].filter(Boolean);
  const mark = (field: string) => userSet(node, field);
  let detail: string;
  switch (node.kind) {
    case "video":
      detail = `${node.asset}${mark("asset")} from ${num(node.sourceIn)} s${node.sourceOut !== null ? ` to ${num(node.sourceOut)} s` : " to the end"}`;
      break;
    case "picture":
      detail = `${node.asset}${mark("asset")}`;
      break;
    case "music":
      detail = `${node.asset ? `${node.asset}${mark("asset")}` : "no file chosen yet"} · volume ${num(node.volume)}${mark("volume")}${node.bpm !== null ? ` · ${num(node.bpm)} bpm` : ""}`;
      break;
    case "motion":
      detail = `preset ${node.preset}${mark("preset")}${node.duration !== null ? ` · ${num(node.duration)} s${mark("duration")}` : ""}${Object.keys(node.inputs).length > 0 ? ` · inputs ${JSON.stringify(node.inputs)}${mark("inputs")}` : ""}`;
      break;
    case "missing":
      detail = `MISSING ${node.mediaKind}: ${cell(node.need)}${mark("need")}${node.neededDuration !== null ? ` · ${num(node.neededDuration)} s` : ""}`;
      break;
  }
  const intent =
    "usageIntent" in node && node.usageIntent
      ? ` — ${cell(node.usageIntent)}${mark("usageIntent")}`
      : "";
  const title = userSet(node, "title") ? ` title ${SET_BY_USER}` : "";
  return `- ${node.kind} ${nodeLabel(node)}${title}: ${detail}${intent} [${flags.join(", ")}]`;
}

/** What the user decided by hand, in one place: the AI must build on these, not undo them. */
function userDecisions(graph: StoryGraph): string[] {
  const lines: string[] = [];
  for (const node of graph.nodes) {
    const fields = STORY_CONTENT_FIELDS[node.kind].filter((field) =>
      node.userEdited.some((edited) => edited === field),
    );
    if (fields.length > 0) lines.push(`- ${nodeLabel(node)}: ${fields.join(", ")}`);
  }
  const createdNodes = graph.nodes.filter((node) => node.createdBy === "user");
  if (createdNodes.length > 0)
    lines.push(`- nodes created by the user: ${createdNodes.map((node) => node.id).join(", ")}`);
  const createdEdges = graph.edges.filter((edge) => edge.createdBy === "user");
  if (createdEdges.length > 0)
    lines.push(
      `- sequence links made by the user: ${createdEdges.map((edge) => `${edge.from} → ${edge.to}`).join(", ")}`,
    );
  const createdAttachments = graph.attachments.filter(
    (attachment) => attachment.createdBy === "user",
  );
  if (createdAttachments.length > 0)
    lines.push(
      `- attachments made by the user: ${createdAttachments.map((attachment) => `${attachment.node} → ${attachment.chapter}`).join(", ")}`,
    );
  for (const removal of graph.removedByUser) {
    lines.push(
      removal.kind === "edge"
        ? `- link removed by the user (do not re-add): ${removal.from} → ${removal.to}`
        : `- attachment removed by the user (do not re-add): ${removal.node} → ${removal.chapter}`,
    );
  }
  return lines;
}

/** A chapter's length is off when its cleaned A-roll and its intended length differ by more than this. */
const LENGTH_TOLERANCE = { ratio: 0.15, seconds: 10 };

/**
 * What the graph needs before it is built, stated as work: chapters whose cleaned A-roll does not fit their intended
 * length (Build Story plays the ranges as they are and never shortens a chapter) and links the user made without a
 * transition. Locked chapters are left out: nobody but the user may change them.
 */
function needsAttention(graph: StoryGraph, view: StoryView): string[] {
  const lines: string[] = [];
  for (const id of view.order.chapters) {
    const chapter = graph.nodes.find(
      (node): node is ChapterNode => node.id === id && isChapter(node),
    );
    const material = view.facts[id]?.materialDuration;
    if (!chapter || chapter.locked || material === null || material === undefined) continue;
    const target = chapter.estimatedDuration;
    const off = Math.abs(material - target);
    if (off <= Math.max(LENGTH_TOLERANCE.seconds, target * LENGTH_TOLERANCE.ratio)) continue;
    const ranges = chapter.sourceRanges
      .map(
        (range) =>
          `${range.segment ?? `${num(range.from)}–${num(range.to)} s`} ${num(range.to - range.from)} s`,
      )
      .join(", ");
    if (chapter.userEdited.includes("estimatedDuration")) {
      lines.push(
        `- ${nodeLabel(chapter)}: its A-roll runs ${duration(material)} but the user wants about ${duration(target)}. Fit the source ranges to the user's length now (drop lower-priority segments of this chapter, or use sentence ranges {source, firstSentence, lastSentence}); raw ranges: ${ranges || "none"}.`,
      );
    } else if (chapter.userEdited.includes("sourceRanges")) {
      lines.push(
        `- ${nodeLabel(chapter)}: the user chose its ranges (${duration(material)}); set estimatedDuration to match instead of ${duration(target)}.`,
      );
    } else {
      lines.push(
        `- ${nodeLabel(chapter)}: A-roll ${duration(material)} vs estimated ${duration(target)}: change the ranges or set estimatedDuration to what the story needs.`,
      );
    }
  }
  for (const edge of graph.edges) {
    if (edge.createdBy === "user" && edge.transition.trim() === "") {
      lines.push(
        `- link ${edge.from} → ${edge.to} was made by the user without a transition: write one (connect with transition).`,
      );
    }
  }
  return lines;
}

/**
 * The Story Graph as a model reads it: play order, every chapter with its authored fields, its attachments and where it
 * sits on the timeline, the materials, the links, and a "User decisions" section that marks everything the user set by
 * hand. Locked nodes are marked LOCKED and listed. Used by `read_story` and by the turn prompt of story-mode turns.
 */
export function formatStory(view: StoryView, limit = RESULT_CHARS): string {
  const { graph } = view;
  if (!graph) {
    return "There is no story yet in this project. Create one with edit_story (add chapters, attach material, connect them in order).";
  }
  const chapters = graph.nodes.filter(isChapter);
  const byId = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const lines: string[] = [
    `Story ${quoted(graph.title)} · version ${view.version ?? "unsaved"} · builds into ${view.composition ?? graph.settings.composition ?? "the main composition"}${graph.settings.captionPreset ? ` · caption preset ${graph.settings.captionPreset}` : ""}`,
  ];
  if (graph.brief.trim()) lines.push(`Brief: ${cell(graph.brief)}`);
  lines.push(
    "",
    `Play order (${view.order.chapters.length} ${view.order.chapters.length === 1 ? "chapter" : "chapters"}): ${view.order.chapters.map((id) => `${id} ${quoted(byId.get(id)?.title ?? id)}`).join(" → ") || "none yet"}`,
  );
  for (const note of view.order.notes) lines.push(`Note: ${note}`);
  lines.push("");
  view.order.chapters.forEach((id, index) => {
    const chapter = byId.get(id);
    if (chapter) lines.push(...chapterBlock(chapter, index + 1, graph, view));
  });
  const materials = graph.nodes.filter(
    (node): node is StoryMaterialNode => node.kind !== "chapter",
  );
  if (materials.length > 0) {
    lines.push("", `Materials (${materials.length}):`);
    lines.push(...materials.map((node) => materialLine(node, graph)));
  }
  if (graph.edges.length > 0) {
    lines.push("", "Sequence links:");
    for (const edge of graph.edges) {
      const transition = edge.transition.trim() ? ` · transition: ${cell(edge.transition)}` : "";
      lines.push(
        `- ${edge.from} → ${edge.to}${transition} [${edge.createdBy === "user" ? "made by user" : "AI"}]`,
      );
    }
  }
  const decisions = userDecisions(graph);
  lines.push(
    "",
    decisions.length > 0
      ? `User decisions (the user set these by hand: keep them, build around them, never restore the earlier AI variant):\n${decisions.join("\n")}`
      : "User decisions: none yet.",
  );
  const attention = needsAttention(graph, view);
  if (attention.length > 0) {
    lines.push(
      "",
      `Needs attention before the build (Build Story never shortens or re-times a chapter; resolve these or say why not):\n${attention.join("\n")}`,
    );
  }
  const locked = graph.nodes.filter((node) => node.locked);
  lines.push(
    locked.length > 0
      ? `Locked (never change these nodes or their attachments): ${locked.map(nodeLabel).join(", ")}`
      : "Locked: nothing.",
  );
  if (graph.review) lines.push(`Last review: ${cell(graph.review.summary).slice(0, 400)}`);
  if (graph.build) {
    lines.push(
      `Last build: ${graph.build.chapters.length} chapters, ${duration(graph.build.duration)} on ${graph.build.composition}${graph.build.warnings.length > 0 ? `, ${graph.build.warnings.length} warnings` : ""}`,
    );
  }
  const body = lines.join("\n");
  const sync = syncSection(view.sync);
  if (!sync) return cap(body, limit);
  // The sync section is bounded on its own and must not be the part a long graph cuts off.
  return `${cap(body, Math.max(limit - sync.length - 2, 1_000))}\n\n${sync}`;
}

// ── Timeline sync ────────────────────────────────────────────────────────────

const SYNC_CHARS = 4_000;
const SYNC_SECTIONS = 12;
const SYNC_UNITS = 3;
const SYNC_EDITS = 8;
const SYNC_UNRELATED = 4;
const SYNC_WARNINGS = 5;

const ACTION_TEXT: Record<StorySyncAction, string> = {
  keep: "stays",
  shift: "moves with its section",
  rebuild: "rebuilt",
  add: "added",
  remove: "removed",
  keep_edited: "kept (holds manual edits)",
  keep_locked: "kept (locked)",
  skip: "skipped (outside the requested chapters)",
};

const span = (range: { start: number; end: number } | null) =>
  range ? `${clock(range.start)}–${clock(range.end)}` : "off the timeline";

const reasonText = (reasons: readonly string[]) => {
  const text = reasons.slice(0, 3).map(cell).join("; ");
  return text ? ` (${text.length > 160 ? `${text.slice(0, 159)}…` : text})` : "";
};

function ids(list: readonly string[]): string {
  if (list.length === 0) return "none";
  return list.length > 12
    ? `${list.slice(0, 12).join(", ")}, … +${list.length - 12}`
    : list.join(", ");
}

/** Titles and labels come from the user; one line of the sync view never gets longer than a few dozen of them. */
function short(text: string): string {
  const one = cell(text);
  return `"${one.length > 60 ? `${one.slice(0, 59)}…` : one}"`;
}

function editText(edit: StoryManualEdit): string {
  const by = edit.by === "user" ? " by the user" : edit.by === "ai" ? " by the AI" : "";
  const fields = edit.fields.length > 0 ? `: ${edit.fields.join(", ")}` : "";
  return `${edit.kind} ${short(edit.label)} (${edit.clip})${by}${fields}`;
}

/** A bounded bullet list of manual edits. */
function editLines(edits: readonly StoryManualEdit[], limit = SYNC_EDITS): string[] {
  return [
    ...edits.slice(0, limit).map((edit) => `- ${editText(edit)}`),
    ...(edits.length > limit ? [`… ${edits.length - limit} more`] : []),
  ];
}

function reportUnits(report: StorySyncReport): StorySyncUnit[] {
  return [
    ...report.sections.flatMap((section) => section.units),
    ...report.music,
    ...(report.captions ? [report.captions] : []),
  ];
}

const isInteresting = (unit: StorySyncUnit) => unit.change !== "unchanged" || unit.edits.length > 0;

function unitLine(unit: StorySyncUnit, indent: string): string {
  const edited =
    unit.edits.length > 0
      ? `; ${unit.edits.length} manual ${unit.edits.length === 1 ? "edit" : "edits"}`
      : "";
  return `${indent}· ${unit.role.replace("_", "-")} ${unit.node} ${short(unit.title)}: ${unit.change}${reasonText(unit.reasons)} → ${ACTION_TEXT[unit.action]}${edited}`;
}

function sectionLines(section: StorySyncSection): string[] {
  const parts = [section.change === "unchanged" ? "content unchanged" : section.change];
  if (section.moved) parts.push("moves");
  if (section.locked) parts.push("LOCKED");
  const lines = [
    `- ${section.chapter} ${short(section.title)}: ${parts.join(", ")} · ${span(section.current)} → ${span(section.next)}${reasonText(section.reasons)}`,
  ];
  const units = section.units.filter(isInteresting);
  lines.push(...units.slice(0, SYNC_UNITS).map((unit) => unitLine(unit, "  ")));
  if (units.length > SYNC_UNITS) lines.push(`  · … ${units.length - SYNC_UNITS} more units`);
  return lines;
}

/**
 * How the timeline relates to the graph since the last build, as a rebuild would treat it: which sections and units
 * changed or moved, the manual edits to generated clips and who made them, conflicts, locked chapters that stay
 * pending, music/caption units, and the clips no chapter owns. Bounded: the summary comes first and the per-section
 * detail fills what is left of the budget. Null when there is nothing to say.
 */
function syncSection(sync: StorySyncReport | null): string | null {
  if (!sync) return null;
  if (sync.state === "not_built")
    return "Timeline sync: the story is not on the timeline yet (build_story creates it).";
  if (sync.state === "untracked")
    return "Timeline sync: the timeline holds story clips built before synchronization existed; a rebuild cannot tell what changed — only the full build_story takes them over.";
  const edits = reportUnits(sync).flatMap((unit) => unit.edits);
  const bySplit = [
    `${edits.filter((edit) => edit.by === "user").length} by the user`,
    `${edits.filter((edit) => edit.by === "ai").length} by the AI`,
    ...(edits.some((edit) => edit.by === "unknown")
      ? [`${edits.filter((edit) => edit.by === "unknown").length} unattributed`]
      : []),
  ];
  const lines: string[] = [];
  if (sync.state === "in_sync") {
    lines.push(
      "Timeline sync: in sync — every built section matches the graph, there is nothing to rebuild.",
    );
  } else {
    lines.push(
      `Timeline sync: OUT OF SYNC — a rebuild would regenerate, add or remove ${sync.affected.length} ${sync.affected.length === 1 ? "section" : "sections"} (${ids(sync.affected)}) and move ${sync.moved.length} (${ids(sync.moved)}); length ${clock(sync.duration.current)} → ${clock(sync.duration.next)}.`,
    );
    if (sync.lockedPending.length > 0)
      lines.push(
        `Locked chapters with changes (rebuilt only when the user allows it in the Story workspace; they still move as a whole): ${ids(sync.lockedPending)}`,
      );
  }
  if (sync.manualEdits > 0) {
    lines.push(
      `Manual edits to generated clips: ${sync.manualEdits} (${bySplit.join(", ")})${sync.conflicts > 0 ? `; ${sync.conflicts} ${sync.conflicts === 1 ? "unit" : "units"} a rebuild must change hold edits — kept unless the user chose to replace them` : ""}:`,
      ...editLines(edits),
    );
  }
  if (sync.unrelated.length > 0) {
    const moving = sync.unrelated.filter((clip) => clip.shift !== 0);
    lines.push(
      `Unrelated clips (no chapter owns them; a rebuild never removes them): ${sync.unrelated.length}${
        moving.length > 0
          ? `; moving with their section: ${moving
              .slice(0, SYNC_UNRELATED)
              .map(
                (clip) => `${short(clip.label)} ${clip.shift > 0 ? "+" : ""}${num(clip.shift)} s`,
              )
              .join(", ")}${moving.length > SYNC_UNRELATED ? ", …" : ""}`
          : ""
      }`,
    );
  }
  lines.push(...sync.warnings.slice(0, SYNC_WARNINGS).map((warning) => `Sync warning: ${warning}`));
  if (sync.state === "out_of_sync") {
    const sideUnits = [...sync.music, ...(sync.captions ? [sync.captions] : [])].filter(
      (unit) => unit.change !== "unchanged",
    );
    if (sideUnits.length > 0)
      lines.push(
        "Music and captions that change:",
        ...sideUnits.slice(0, SYNC_UNITS).map((unit) => unitLine(unit, "  ")),
      );
    const shown = sync.sections.filter(
      (section) =>
        section.change !== "unchanged" ||
        section.moved ||
        sync.lockedPending.includes(section.chapter),
    );
    let budget = SYNC_CHARS - lines.join("\n").length - 60;
    let listed = 0;
    const details: string[] = [];
    for (const section of shown) {
      const block = sectionLines(section);
      const size = block.join("\n").length + 1;
      if (size > budget || listed >= SYNC_SECTIONS) break;
      details.push(...block);
      budget -= size;
      listed += 1;
    }
    if (shown.length > listed) details.push(`- … ${shown.length - listed} more sections`);
    if (details.length > 0) lines.push("Sections:", ...details);
  }
  const text = lines.join("\n");
  return text.length <= SYNC_CHARS
    ? text
    : `${text.slice(0, SYNC_CHARS - 40)}\n… more changes than shown`;
}

/** What the model sees for an applied batch: the operations' results and the story's new shape. */
export function formatStoryEdit(response: StoryEditResponse): string {
  const rows = response.results.map(
    (result, index) => `${index + 1}. ${result.op}${result.id ? ` → ${result.id}` : ""}`,
  );
  const { view } = response;
  const graph = view.graph;
  const summary = graph
    ? `Story now: ${graph.nodes.filter(isChapter).length} chapters, ${graph.nodes.length - graph.nodes.filter(isChapter).length} materials, ${graph.attachments.length} attachments, version ${view.version ?? "unsaved"}. Play order: ${view.order.chapters.join(" → ") || "none"}.`
    : "The story is still empty.";
  return cap(
    [
      `Applied ${response.results.length} ${response.results.length === 1 ? "operation" : "operations"}. The Story canvas updates by itself and the change belongs to this turn's checkpoint.`,
      ...rows.slice(0, 60),
      ...(rows.length > 60 ? [`… ${rows.length - 60} more`] : []),
      summary,
    ].join("\n"),
  );
}

export function formatStoryBuild(result: StoryBuildResult): string {
  const lines = [
    result.dryRun
      ? `Dry run (nothing was written): the story would build ${duration(result.duration)} on ${result.composition}.`
      : `Built the story on ${result.composition}: ${duration(result.duration)}, timeline version ${result.timelineVersion}. The Studio timeline and preview update by themselves.`,
    "Chapters on the timeline:",
    ...result.chapters.map(
      (chapter) =>
        `- ${chapter.node} ${quoted(chapter.title)} ${clock(chapter.start)}–${clock(chapter.end)} (estimated ${num(chapter.estimatedDuration)} s, ${chapter.clips} ${chapter.clips === 1 ? "clip" : "clips"})`,
    ),
  ];
  if (result.materials.length > 0) {
    const perChapter = new Map<string, number>();
    for (const material of result.materials)
      perChapter.set(material.chapter, (perChapter.get(material.chapter) ?? 0) + 1);
    lines.push(
      `Material placed: ${result.materials.length} (${[...perChapter].map(([chapter, n]) => `${chapter} ${n}`).join(", ")}).`,
    );
  }
  lines.push(
    `Replaced ${result.removedClips} earlier ${result.removedClips === 1 ? "clip" : "clips"}; kept ${result.keptClips} ${result.keptClips === 1 ? "clip" : "clips"} (manual additions and cutaways on other tracks, locked sections).`,
  );
  if (result.replacedEdits.length > 0)
    lines.push(
      `Manual edits to generated clips that the build replaced (${result.replacedEdits.length}):`,
      ...editLines(result.replacedEdits),
    );
  if (result.keptLocked.length > 0)
    lines.push(
      `Locked chapters whose built section was kept as it was: ${chapterList(
        result.keptLocked,
        titlesOf(
          result.view,
          result.chapters.map((chapter) => [chapter.node, chapter.title]),
        ),
      )} (only the user can allow rebuilding them).`,
    );
  if (result.captions)
    lines.push(`Captions: ${result.captions.cues} cues in the ${result.captions.preset} preset.`);
  if (result.warnings.length > 0)
    lines.push("Warnings:", ...result.warnings.slice(0, 40).map((warning) => `- ${warning}`));
  if (!result.dryRun) lines.push("Verify the result with inspect_timeline.");
  return cap(lines.join("\n"));
}

/** Chapter titles by id: the graph's, then the ones a result names for chapters that left it. */
function titlesOf(view: StoryView, named: Array<[string, string]> = []): Map<string, string> {
  const titles = new Map(named);
  for (const node of view.graph?.nodes ?? []) titles.set(node.id, node.title);
  return titles;
}

function chapterList(list: readonly string[], titles: ReadonlyMap<string, string>): string {
  if (list.length === 0) return "none";
  return list
    .map((id) => {
      const title = titles.get(id);
      return title ? `${id} ${quoted(title)}` : id;
    })
    .join(", ");
}

/** What the model sees for a rebuild: which chapters were rebuilt/removed/moved, the manual edits kept or replaced. */
export function formatStoryRebuild(result: StoryRebuildResult): string {
  const titles = titlesOf(
    result.view,
    result.report.sections.map((section) => [section.chapter, section.title]),
  );
  const length = duration(result.duration);
  const heldBack = !result.changed && result.report.state === "out_of_sync";
  const lines = [
    result.changed
      ? result.dryRun
        ? `Dry run (nothing was written): the rebuild would change ${result.composition}; it would be ${length} long.`
        : `Rebuilt the affected sections on ${result.composition}: ${length}, timeline version ${result.timelineVersion}. The Studio timeline and preview update by themselves.`
      : heldBack
        ? `Nothing was written: the story still differs from the timeline on ${result.composition} (${length}), but every remaining change is held back — manual edits kept, locked chapters the user has not allowed, or chapters outside this rebuild's scope (listed below). The user decides in the Story workspace.`
        : `Already in sync: the timeline on ${result.composition} matches the story (${length}); nothing to rebuild and nothing was written.`,
  ];
  if (result.changed) {
    const dry = result.dryRun;
    lines.push(
      `${dry ? "Would be rebuilt" : "Rebuilt"} (regenerated or built for the first time): ${chapterList(result.rebuilt, titles)}`,
      `${dry ? "Would be removed" : "Removed"} (taken off the timeline): ${chapterList(result.removed, titles)}`,
      `${dry ? "Would move" : "Moved"} (content untouched): ${chapterList(result.moved, titles)}`,
    );
  }
  if (heldBack) {
    const skipped = result.report.sections
      .filter((section) => section.units.some((unit) => unit.action === "skip"))
      .map((section) => section.chapter);
    if (skipped.length > 0)
      lines.push(`Changed but outside this rebuild's scope: ${chapterList(skipped, titles)}`);
  }
  if (result.keptEdits.length > 0)
    lines.push(
      `Manual edits kept although the story changed that unit (${result.keptEdits.length}):`,
      ...editLines(result.keptEdits),
    );
  if (result.replacedEdits.length > 0)
    lines.push(
      `Manual edits ${result.dryRun ? "that would be replaced" : "replaced by the rebuild"} (${result.replacedEdits.length}):`,
      ...editLines(result.replacedEdits),
    );
  if (result.keptLocked.length > 0)
    lines.push(
      `Locked chapters with changes that were not rebuilt (the user has to allow them in the Story workspace): ${chapterList(result.keptLocked, titles)}`,
    );
  if (result.warnings.length > 0)
    lines.push("Warnings:", ...result.warnings.slice(0, 40).map((warning) => `- ${warning}`));
  if (result.changed && !result.dryRun) lines.push("Verify the result with inspect_timeline.");
  return cap(lines.join("\n"));
}

/** What the model sees for a refused call: a stable code, the failing operation of a batch, the message. */
export function formatStoryError(error: StoryToolError): string {
  const where = error.opIndex !== undefined ? ` (operations[${error.opIndex}])` : "";
  return `${error.code}${where}: ${error.message}`;
}
