import {
  STORY_CONTENT_FIELDS,
  isChapter,
  isSoundEffect,
  type ChapterNode,
  type StoryAttachment,
  type StoryGraph,
  type StoryMaterialNode,
  type StoryNode,
  type StoryNodeFacts,
  type StoryView,
} from "@hyperframes/agent-protocol";
import { clock } from "../analysis/format.js";
import { StoryToolError } from "./host.js";
import { syncSection } from "./syncText.js";
import { RESULT_CHARS, cap, cell, duration, num, quoted } from "./text.js";

/** The last line of a story reading that was cut: how to read the rest. */
const PAGING_NOTICE =
  "… the story is longer than this view; read it in pages with read_story (chapter=<id>, section=<name>, offset=<n>)";

/** The marker the user's own edits carry in a reading of the story. */
const SET_BY_USER = "(set by user)";

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

/** The narration with, when the story view knows the voice (the runtime has the voice host), its generation status. */
function narrationLine(chapter: ChapterNode, voice: StoryNodeFacts["narration"]): string | null {
  const line = textLine(chapter, "narration", "narration", chapter.narration);
  if (!line || !voice) return line;
  const status = voice.generated
    ? `voice generated, ${duration(voice.seconds ?? 0)}${voice.textCurrent ? "" : "; narration text changed since: generate it again"}`
    : "voice not generated yet";
  return `${line} [${status}]`;
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
      narrationLine(chapter, facts?.narration),
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
      detail = `${isSoundEffect(node) ? "sound effect (placed in its chapter) · " : ""}${node.asset ? `${node.asset}${mark("asset")}` : "no file chosen yet"} · volume ${num(node.volume)}${mark("volume")}${node.bpm !== null ? ` · ${num(node.bpm)} bpm` : ""}`;
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
  const resolved =
    "resolvedFrom" in node && node.resolvedFrom
      ? ` · resolved Missing Asset ${node.resolvedFrom.missing} (${cell(node.resolvedFrom.need)})`
      : "";
  return `- ${node.kind} ${nodeLabel(node)}${title}: ${detail}${intent}${resolved} [${flags.join(", ")}]`;
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
 * length (Build Story plays the ranges as they are; it only trims a clearly longer A-roll to a length the user set) and links the user made without a
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

interface StoryParts {
  /** Title line, brief, play order and notes. */
  overview: string[];
  /** One block per chapter, in play order. */
  chapters: string[][];
  materials: string[];
  links: string[];
  decisions: string[];
  attention: string[];
  /** Locked nodes, the last review and the last build. */
  locks: string[];
  sync: string | null;
}

function storyParts(view: StoryView, graph: StoryGraph): StoryParts {
  const byId = new Map(graph.nodes.filter(isChapter).map((chapter) => [chapter.id, chapter]));
  const overview: string[] = [
    `Story ${quoted(graph.title)} · version ${view.version ?? "unsaved"} · builds into ${view.composition ?? graph.settings.composition ?? "the main composition"}${graph.settings.captionPreset ? ` · caption preset ${graph.settings.captionPreset}` : ""}`,
  ];
  if (graph.brief.trim()) overview.push(`Brief: ${cell(graph.brief)}`);
  overview.push(
    "",
    `Play order (${view.order.chapters.length} ${view.order.chapters.length === 1 ? "chapter" : "chapters"}): ${view.order.chapters.map((id) => `${id} ${quoted(byId.get(id)?.title ?? id)}`).join(" → ") || "none yet"}`,
  );
  for (const note of view.order.notes) overview.push(`Note: ${note}`);
  overview.push("");
  const chapters = view.order.chapters.flatMap((id, index) => {
    const chapter = byId.get(id);
    return chapter ? [chapterBlock(chapter, index + 1, graph, view)] : [];
  });
  const materialNodes = graph.nodes.filter(
    (node): node is StoryMaterialNode => node.kind !== "chapter",
  );
  const materials =
    materialNodes.length > 0
      ? [
          "",
          `Materials (${materialNodes.length}):`,
          ...materialNodes.map((node) => materialLine(node, graph)),
        ]
      : [];
  const links =
    graph.edges.length > 0
      ? [
          "",
          "Sequence links:",
          ...graph.edges.map((edge) => {
            const transition = edge.transition.trim()
              ? ` · transition: ${cell(edge.transition)}`
              : "";
            return `- ${edge.from} → ${edge.to}${transition} [${edge.createdBy === "user" ? "made by user" : "AI"}]`;
          }),
        ]
      : [];
  const decided = userDecisions(graph);
  const decisions = [
    "",
    decided.length > 0
      ? `User decisions (the user set these by hand: keep them, build around them, never restore the earlier AI variant):\n${decided.join("\n")}`
      : "User decisions: none yet.",
  ];
  const needed = needsAttention(graph, view);
  const attention =
    needed.length > 0
      ? [
          "",
          `Needs attention before the build (Build Story only trims a chapter to a length the user set, proportionally and without choosing what to cut; resolve these or say why not):\n${needed.join("\n")}`,
        ]
      : [];
  const locked = graph.nodes.filter((node) => node.locked);
  const locks = [
    locked.length > 0
      ? `Locked (never change these nodes or their attachments): ${locked.map(nodeLabel).join(", ")}`
      : "Locked: nothing.",
  ];
  if (graph.review) locks.push(`Last review: ${cell(graph.review.summary).slice(0, 400)}`);
  if (graph.build) {
    locks.push(
      `Last build: ${graph.build.chapters.length} chapters, ${duration(graph.build.duration)} on ${graph.build.composition}${graph.build.warnings.length > 0 ? `, ${graph.build.warnings.length} warnings` : ""}`,
    );
  }
  return {
    overview,
    chapters,
    materials,
    links,
    decisions,
    attention,
    locks,
    sync: syncSection(view.sync),
  };
}

const NO_STORY =
  "There is no story yet in this project. Create one with edit_story (add chapters, attach material, connect them in order).";

/**
 * The Story Graph as a model reads it: play order, every chapter with its authored fields, its attachments and where it
 * sits on the timeline, the materials, the links, and a "User decisions" section that marks everything the user set by
 * hand. Locked nodes are marked LOCKED and listed. Used by the turn prompt of story-mode turns; `read_story` pages
 * through the same text with {@link formatStoryPage}.
 */
export function formatStory(view: StoryView, limit = RESULT_CHARS): string {
  const { graph } = view;
  if (!graph) return NO_STORY;
  const parts = storyParts(view, graph);
  const body = [
    ...parts.overview,
    ...parts.chapters.flat(),
    ...parts.materials,
    ...parts.links,
    ...parts.decisions,
    ...parts.attention,
    ...parts.locks,
  ].join("\n");
  if (!parts.sync) return cap(body, limit, PAGING_NOTICE);
  // The sync section is bounded on its own and must not be the part a long graph cuts off.
  return `${cap(body, Math.max(limit - parts.sync.length - 2, 1_000), PAGING_NOTICE)}\n\n${parts.sync}`;
}

export const STORY_SECTIONS = [
  "overview",
  "chapters",
  "materials",
  "links",
  "decisions",
  "attention",
  "locks",
  "sync",
] as const;
export type StorySection = (typeof STORY_SECTIONS)[number];

/** What `read_story` was asked for: a whole chapter, or one part of the story, from a character offset. */
export interface StoryPageRequest {
  chapter?: string;
  section?: StorySection;
  offset: number;
}

/** `text` from `offset`, in whole lines, at most `limit` characters; says how to continue when more follows. */
function page(text: string, offset: number, args: string, limit = RESULT_CHARS): string {
  if (offset === 0 && text.length <= limit) return text;
  if (offset >= text.length)
    return `Nothing at offset ${offset}: this view is ${text.length} characters long.`;
  let end = Math.min(text.length, offset + limit - 200);
  if (end < text.length) {
    const lineEnd = text.lastIndexOf("\n", end);
    if (lineEnd > offset) end = lineEnd;
  }
  const more = text.length - end;
  const head = offset > 0 ? `(characters ${offset}–${end} of ${text.length})\n` : "";
  const tail =
    more > 0
      ? `\n… ${more} more characters; continue with read_story ${args ? `${args} ` : ""}offset=${end}`
      : "";
  return `${head}${text.slice(offset, end)}${tail}`;
}

/** One chapter in full: its block, the material attached to it, its links and what needs attention in it. */
function chapterPage(view: StoryView, graph: StoryGraph, id: string): string {
  const chapter = graph.nodes.find(
    (node): node is ChapterNode => node.id === id && isChapter(node),
  );
  if (!chapter) {
    const known = view.order.chapters.join(", ") || "none yet";
    throw new StoryToolError(
      "invalid_request",
      `"${id}" is not a chapter of this story. Chapters in play order: ${known}`,
    );
  }
  const position = view.order.chapters.indexOf(id);
  const lines = chapterBlock(chapter, position >= 0 ? position + 1 : 0, graph, view);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const attached = graph.attachments
    .filter((attachment) => attachment.chapter === id)
    .flatMap((attachment) => {
      const node = nodes.get(attachment.node);
      return node && node.kind !== "chapter" ? [materialLine(node, graph)] : [];
    });
  if (attached.length > 0) lines.push("", `Material attached to ${id}:`, ...attached);
  const links = graph.edges
    .filter((edge) => edge.from === id || edge.to === id)
    .map((edge) => {
      const transition = edge.transition.trim() ? ` · transition: ${cell(edge.transition)}` : "";
      return `- ${edge.from} → ${edge.to}${transition} [${edge.createdBy === "user" ? "made by user" : "AI"}]`;
    });
  if (links.length > 0) lines.push("", "Sequence links:", ...links);
  const attention = needsAttention(graph, view).filter(
    (line) =>
      line.startsWith(`- ${id} `) || line.includes(`link ${id} →`) || line.includes(`→ ${id} `),
  );
  if (attention.length > 0) lines.push("", "Needs attention:", ...attention);
  return [`Story ${quoted(graph.title)} · version ${view.version ?? "unsaved"}`, "", ...lines].join(
    "\n",
  );
}

/**
 * `read_story`: the whole story from `offset`, one chapter, or one named part (everything cut by the size cap can be
 * reached by paging with the offset the result names). The story's version is on the first line of every view.
 */
export function formatStoryPage(view: StoryView, request: StoryPageRequest): string {
  const { graph } = view;
  if (!graph) return NO_STORY;
  const { chapter, section, offset } = request;
  if (chapter !== undefined)
    return page(chapterPage(view, graph, chapter), offset, `chapter=${chapter}`);
  const parts = storyParts(view, graph);
  const versioned = (lines: string[]) =>
    [`Story ${quoted(graph.title)} · version ${view.version ?? "unsaved"}`, "", ...lines].join(
      "\n",
    );
  switch (section) {
    case undefined:
      return page(
        [
          ...parts.overview,
          ...parts.chapters.flat(),
          ...parts.materials,
          ...parts.links,
          ...parts.decisions,
          ...parts.attention,
          ...parts.locks,
          ...(parts.sync ? ["", parts.sync] : []),
        ].join("\n"),
        offset,
        "",
      );
    case "overview":
      return page(parts.overview.join("\n"), offset, "section=overview");
    case "chapters":
      return page(versioned(parts.chapters.flat()), offset, "section=chapters");
    case "materials":
      return page(
        versioned(parts.materials.length > 0 ? parts.materials : ["Materials: none yet."]),
        offset,
        "section=materials",
      );
    case "links":
      return page(
        versioned(parts.links.length > 0 ? parts.links : ["Sequence links: none yet."]),
        offset,
        "section=links",
      );
    case "decisions":
      return page(versioned(parts.decisions), offset, "section=decisions");
    case "attention":
      return page(
        versioned(parts.attention.length > 0 ? parts.attention : ["Needs attention: nothing."]),
        offset,
        "section=attention",
      );
    case "locks":
      return page(versioned(parts.locks), offset, "section=locks");
    case "sync":
      return page(
        versioned([parts.sync ?? "Timeline sync: nothing to report."]),
        offset,
        "section=sync",
      );
  }
}
