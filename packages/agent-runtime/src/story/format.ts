import {
  STORY_CONTENT_FIELDS,
  isChapter,
  type ChapterNode,
  type StoryAttachment,
  type StoryBuildResult,
  type StoryEditResponse,
  type StoryGraph,
  type StoryMaterialNode,
  type StoryNode,
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
  return cap(lines.join("\n"), limit);
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
    `Replaced ${result.removedClips} earlier ${result.removedClips === 1 ? "clip" : "clips"}; kept ${result.keptClips} ${result.keptClips === 1 ? "clip" : "clips"} (manual additions and cutaways on other tracks).`,
  );
  if (result.captions)
    lines.push(`Captions: ${result.captions.cues} cues in the ${result.captions.preset} preset.`);
  if (result.warnings.length > 0)
    lines.push("Warnings:", ...result.warnings.slice(0, 40).map((warning) => `- ${warning}`));
  if (!result.dryRun) lines.push("Verify the result with inspect_timeline.");
  return cap(lines.join("\n"));
}

/** What the model sees for a refused call: a stable code, the failing operation of a batch, the message. */
export function formatStoryError(error: StoryToolError): string {
  const where = error.opIndex !== undefined ? ` (operations[${error.opIndex}])` : "";
  return `${error.code}${where}: ${error.message}`;
}
