import {
  STORY_LIMITS,
  isChapter,
  isVideoRange,
  isMaterial,
  parseStoryFields,
  validateStoryGraph,
  type AttachmentPlacement,
  type ChapterNode,
  type StoryAttachment,
  type StoryEdge,
  type StoryFrameRef,
  type StoryGraph,
  type StoryNode,
  type StoryNodeInput,
  type MissingMediaKind,
  type MissingResolution,
  type StoryNodeKind,
  type StoryOperation,
  type StoryOperationResult,
  type StorySourceRange,
  type StorySourceRangeInput,
  type StoryMaterialNode,
} from "@hyperframes/agent-protocol";
import { contentValues } from "./authorship.js";
import { StoryFailure, isStoryFailure } from "./errors.js";
import { newId, sameJson } from "./graphIo.js";
import { layoutNewNodes } from "./layout.js";

export type MediaKind = "video" | "audio" | "image";

/** What the operation engine asks of the rest of the service (all of it project facts, none of it storage). */
export interface OpsEnv {
  now: number;
  /** The agent turn making the edit. */
  turnId: string | null;
  /** Resolves an agent's range inputs (segments, sentences, raw times) against the analysis. */
  resolveRanges(inputs: StorySourceRangeInput[]): Promise<StorySourceRange[]>;
  /** A project media file: its normalized project-relative path and kind, or null when there is none. */
  mediaFile(path: string): Promise<{ path: string; kind: MediaKind } | null>;
  /** Whether the registry has a motion block or component of that name. */
  hasPreset(name: string): Promise<boolean>;
  /** Whether a caption preset of that name exists (true when the server cannot tell). */
  hasCaptionPreset(name: string): Promise<boolean>;
  /** Whether a composition file of that project path exists. */
  hasComposition(path: string): boolean;
  /** Cleaned A-roll length of ranges in seconds, or null when a source is not analysed. */
  cleanedLength(ranges: StorySourceRange[]): Promise<number | null>;
}

export interface OpsOutcome {
  graph: StoryGraph;
  results: StoryOperationResult[];
}

interface State {
  graph: StoryGraph;
  /** The graph existed before the batch. */
  existed: boolean;
  refs: Map<string, string>;
  created: Set<string>;
  taken: Set<string>;
}

const describe = (node: StoryNode) => `"${node.title}" (${node.id})`;

const DEFAULT_PLACEMENT: Record<StoryMaterialNode["kind"], AttachmentPlacement> = {
  video: "middle",
  picture: "middle",
  music: "throughout",
  motion: "start",
  missing: "middle",
};

function nodeOf(state: State, rawId: string): StoryNode {
  const id = rawId.startsWith("@") ? state.refs.get(rawId.slice(1)) : rawId;
  if (id === undefined) {
    throw new StoryFailure(
      "invalid_request",
      `${rawId} refers to no node added earlier in this batch (add_node with ref "${rawId.slice(1)}" first)`,
    );
  }
  const node = state.graph.nodes.find((candidate) => candidate.id === id);
  if (node) return node;
  if (!state.existed && state.created.size === 0) {
    throw new StoryFailure("no_story", "There is no story yet; add nodes to create one");
  }
  throw new StoryFailure("unknown_node", `No node "${id}" in the story`, undefined, { id });
}

function chapterOf(state: State, rawId: string): ChapterNode {
  const node = nodeOf(state, rawId);
  if (!isChapter(node)) {
    throw new StoryFailure("invalid_request", `${describe(node)} is not a chapter`);
  }
  return node;
}

function materialOf(state: State, rawId: string): StoryMaterialNode {
  const node = nodeOf(state, rawId);
  if (!isMaterial(node)) {
    throw new StoryFailure("invalid_request", `${describe(node)} is a chapter, not material`);
  }
  return node;
}

function locked(node: StoryNode): StoryFailure {
  return new StoryFailure(
    "locked",
    `${describe(node)} is locked: the user wants it to stay as it is. Leave it, or ask the user to unlock it.`,
  );
}

function decision(message: string): StoryFailure {
  return new StoryFailure(
    "user_decision",
    `${message} That was the user's decision; keep it, or ask the user before changing it.`,
  );
}

const shortValue = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
};

function isRemoved(graph: StoryGraph, from: string, to: string): boolean {
  return graph.removedByUser.some(
    (removal) => removal.kind === "edge" && removal.from === from && removal.to === to,
  );
}

function isDetached(graph: StoryGraph, node: string, chapter: string): boolean {
  return graph.removedByUser.some(
    (removal) =>
      removal.kind === "attachment" && removal.node === node && removal.chapter === chapter,
  );
}

const nameOf = (state: State, id: string) => {
  const node = state.graph.nodes.find((candidate) => candidate.id === id);
  return node ? `"${node.title}"` : id;
};

// ── Field preparation ────────────────────────────────────────────────────────

async function mediaAsset(
  env: OpsEnv,
  path: string,
  kinds: readonly MediaKind[],
  field: string,
): Promise<string> {
  const file = await env.mediaFile(path);
  if (!file) throw new StoryFailure("unknown_asset", `${field}: no file "${path}" in this project`);
  if (!kinds.includes(file.kind)) {
    throw new StoryFailure(
      "invalid_request",
      `${field}: ${file.path} is ${file.kind === "image" ? "a picture" : `a ${file.kind} file`}, expected ${kinds.join(" or ")}`,
    );
  }
  return file.path;
}

async function checkedFrame(
  env: OpsEnv,
  frame: StoryFrameRef | null,
): Promise<StoryFrameRef | null> {
  if (frame === null) return null;
  return {
    source: await mediaAsset(env, frame.source, ["video"], "previewFrame.source"),
    time: frame.time,
  };
}

/** The frame a chapter card shows by default: the middle of its first range. */
export function middleFrame(ranges: readonly StorySourceRange[]): StoryFrameRef | null {
  const first = ranges[0];
  return first
    ? { source: first.source, time: Number(((first.from + first.to) / 2).toFixed(3)) }
    : null;
}

async function requirePreset(env: OpsEnv, name: string): Promise<void> {
  if (!(await env.hasPreset(name))) {
    throw new StoryFailure(
      "unknown_preset",
      `No motion block or component "${name}" in the registry (browse_presets lists them)`,
    );
  }
}

/** Validates and normalizes the fields of an update (assets, presets, ranges); returns the values to store. */
async function prepareFields(
  env: OpsEnv,
  kind: StoryNodeKind,
  raw: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = parseStoryFields(kind, raw);
  if (!parsed.ok) throw new StoryFailure("invalid_request", parsed.error.message);
  const value = parsed.value;
  const fields: Record<string, unknown> = { ...value };
  if ("sourceRanges" in value && value.sourceRanges !== undefined) {
    fields.sourceRanges = await env.resolveRanges(value.sourceRanges);
  }
  if ("asset" in value && typeof value.asset === "string") {
    const kinds: MediaKind[] =
      kind === "video" ? ["video"] : kind === "music" ? ["audio"] : ["image"];
    fields.asset = await mediaAsset(env, value.asset, kinds, "asset");
  }
  if ("preset" in value && value.preset !== undefined) await requirePreset(env, value.preset);
  if ("previewFrame" in value && value.previewFrame !== undefined) {
    fields.previewFrame = await checkedFrame(env, value.previewFrame);
  }
  return fields;
}

// ── add_node ─────────────────────────────────────────────────────────────────

async function buildNode(env: OpsEnv, input: StoryNodeInput, id: string): Promise<StoryNode> {
  const base = {
    id,
    position: { x: 0, y: 0 },
    locked: false,
    createdBy: "ai" as const,
    userEdited: [] as string[],
  };
  switch (input.kind) {
    case "chapter": {
      const ranges = input.sourceRanges ? await env.resolveRanges(input.sourceRanges) : [];
      const cleaned =
        input.estimatedDuration ?? (ranges.length > 0 ? await env.cleanedLength(ranges) : null);
      const estimated = cleaned !== null && cleaned > 0 ? Number(cleaned.toFixed(2)) : 30;
      return {
        ...base,
        kind: "chapter",
        title: input.title ?? "Chapter",
        purpose: input.purpose ?? "",
        description: input.description ?? "",
        narrativeRole: input.narrativeRole ?? "main",
        estimatedDuration: estimated,
        status: input.status ?? "proposed",
        sourceRanges: ranges,
        aRoll: input.aRoll ?? "",
        bRoll: input.bRoll ?? "",
        captions: input.captions ?? false,
        graphics: input.graphics ?? "",
        audio: input.audio ?? "",
        narration: input.narration ?? "",
        previewFrame:
          input.previewFrame !== undefined
            ? await checkedFrame(env, input.previewFrame)
            : middleFrame(ranges),
      };
    }
    case "video": {
      const asset = await mediaAsset(env, input.asset ?? "", ["video"], "asset");
      const sourceIn = input.sourceIn ?? 0;
      assertVideoRange(input.title ?? asset, sourceIn, input.sourceOut ?? null);
      return {
        ...base,
        kind: "video",
        title: input.title ?? asset,
        asset,
        sourceIn,
        sourceOut: input.sourceOut ?? null,
        usageIntent: input.usageIntent ?? "",
        previewFrame:
          input.previewFrame !== undefined
            ? await checkedFrame(env, input.previewFrame)
            : { source: asset, time: sourceIn },
      };
    }
    case "picture":
      return {
        ...base,
        kind: "picture",
        title: input.title ?? "Picture",
        asset: await mediaAsset(env, input.asset ?? "", ["image"], "asset"),
        usageIntent: input.usageIntent ?? "",
      };
    case "music":
      return {
        ...base,
        kind: "music",
        title: input.title ?? "Music",
        asset:
          input.asset === undefined || input.asset === null
            ? null
            : await mediaAsset(env, input.asset, ["audio"], "asset"),
        bpm: input.bpm ?? null,
        volume: input.volume ?? 1,
        usageIntent: input.usageIntent ?? "",
      };
    case "motion": {
      const preset = input.preset ?? "";
      await requirePreset(env, preset);
      return {
        ...base,
        kind: "motion",
        title: input.title ?? preset,
        preset,
        skill: input.skill ?? null,
        inputs: input.inputs ?? {},
        duration: input.duration ?? null,
        usageIntent: input.usageIntent ?? "",
      };
    }
    case "missing":
      return {
        ...base,
        kind: "missing",
        title: input.title ?? "Missing asset",
        mediaKind: input.mediaKind ?? "video",
        need: input.need ?? "",
        neededDuration: input.neededDuration ?? null,
      };
  }
}

async function addNode(
  env: OpsEnv,
  state: State,
  op: Extract<StoryOperation, { op: "add_node" }>,
): Promise<StoryOperationResult> {
  if (op.ref !== undefined && state.refs.has(op.ref)) {
    throw new StoryFailure("invalid_request", `ref "${op.ref}" is used twice in this batch`);
  }
  const id = newId(op.node.kind, state.taken);
  const node = await buildNode(env, op.node, id);
  state.taken.add(id);
  state.created.add(id);
  state.graph.nodes.push(node);
  if (op.ref !== undefined) state.refs.set(op.ref, id);
  return { op: op.op, id };
}

// ── update / remove ──────────────────────────────────────────────────────────

async function updateNode(
  env: OpsEnv,
  state: State,
  op: Extract<StoryOperation, { op: "update_node" }>,
): Promise<StoryOperationResult> {
  const node = nodeOf(state, op.id);
  if (node.locked) throw locked(node);
  const prepared = await prepareFields(env, node.kind, { ...op.set });
  const current = contentValues(node);
  const changes: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(prepared)) {
    if (sameJson(current[field], value)) continue;
    if (node.userEdited.includes(field)) {
      throw decision(
        `The user set ${field} of ${describe(node)} by hand (now ${shortValue(current[field])}).`,
      );
    }
    changes[field] = value;
  }
  if (isChapter(node) && "sourceRanges" in changes && !("previewFrame" in prepared)) {
    const ranges = Array.isArray(changes.sourceRanges) ? changes.sourceRanges : [];
    const stillShown = ranges.some(
      (range) => isRangeOf(range) && range.source === node.previewFrame?.source,
    );
    if (!node.userEdited.includes("previewFrame") && !stillShown) {
      changes.previewFrame = middleFrame(ranges.filter(isRangeOf));
    }
  }
  if (node.kind === "video" && ("sourceIn" in changes || "sourceOut" in changes)) {
    const sourceIn = typeof changes.sourceIn === "number" ? changes.sourceIn : node.sourceIn;
    const sourceOut =
      "sourceOut" in changes
        ? typeof changes.sourceOut === "number"
          ? changes.sourceOut
          : null
        : node.sourceOut;
    assertVideoRange(node.title, sourceIn, sourceOut);
  }
  Object.assign(node, changes);
  return { op: op.op, id: node.id };
}

/** A video node's source range must be one the stored graph reads back (the same rule as the protocol's parser). */
function assertVideoRange(title: string, sourceIn: number, sourceOut: number | null): void {
  if (!isVideoRange(sourceIn, sourceOut)) {
    throw new StoryFailure(
      "invalid_request",
      `Video "${title}": sourceOut (${sourceOut}) must be after sourceIn (${sourceIn}).`,
    );
  }
}

function isRangeOf(value: unknown): value is StorySourceRange {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    typeof value.source === "string" &&
    "from" in value &&
    typeof value.from === "number" &&
    "to" in value &&
    typeof value.to === "number"
  );
}

function removeNode(
  state: State,
  op: Extract<StoryOperation, { op: "remove_node" }>,
): StoryOperationResult {
  const { graph } = state;
  const node = nodeOf(state, op.id);
  if (node.locked) throw locked(node);
  if (node.createdBy === "user") {
    throw decision(`${describe(node)} was added by the user.`);
  }
  if (node.userEdited.length > 0) {
    throw decision(
      `The user set ${node.userEdited.join(", ")} of ${describe(node)} by hand, which removing it would drop.`,
    );
  }
  const edges = graph.edges.filter((edge) => edge.from === node.id || edge.to === node.id);
  const userEdge = edges.find((edge) => edge.createdBy === "user");
  if (userEdge) {
    throw decision(
      `The user linked ${nameOf(state, userEdge.from)} → ${nameOf(state, userEdge.to)}, which removing ${describe(node)} would drop.`,
    );
  }
  const attachments = graph.attachments.filter(
    (item) => item.node === node.id || item.chapter === node.id,
  );
  for (const item of attachments) {
    const other = graph.nodes.find(
      (candidate) => candidate.id === (item.node === node.id ? item.chapter : item.node),
    );
    if (other?.locked) throw locked(other);
    if (item.createdBy === "user") {
      throw decision(
        `The user attached ${nameOf(state, item.node)} to ${nameOf(state, item.chapter)}, which removing ${describe(node)} would drop.`,
      );
    }
  }
  // Removing a chapter from the middle of the sequence closes the gap, unless the user cut that link before.
  const incoming = edges.find((edge) => edge.to === node.id);
  const outgoing = edges.find((edge) => edge.from === node.id);
  graph.edges = graph.edges.filter((edge) => !edges.includes(edge));
  graph.attachments = graph.attachments.filter((item) => !attachments.includes(item));
  graph.nodes = graph.nodes.filter((candidate) => candidate !== node);
  if (incoming && outgoing && !isRemoved(graph, incoming.from, outgoing.to)) {
    graph.edges.push({
      id: newId("edge", state.taken),
      kind: "sequence",
      from: incoming.from,
      to: outgoing.to,
      transition: "",
      createdBy: "ai",
    });
  }
  return { op: op.op, id: node.id };
}

// ── sequence ─────────────────────────────────────────────────────────────────

function reaches(graph: StoryGraph, from: string, target: string): boolean {
  const seen = new Set<string>();
  let current: string | undefined = from;
  while (current !== undefined && !seen.has(current)) {
    if (current === target) return true;
    seen.add(current);
    current = graph.edges.find((edge) => edge.from === current)?.to;
  }
  return false;
}

function connect(
  state: State,
  op: Extract<StoryOperation, { op: "connect" }>,
): StoryOperationResult {
  const { graph } = state;
  const from = chapterOf(state, op.from);
  const to = chapterOf(state, op.to);
  if (from.id === to.id) {
    throw new StoryFailure("invalid_request", `${describe(from)} cannot follow itself`);
  }
  const existing = graph.edges.find((edge) => edge.from === from.id && edge.to === to.id);
  if (existing) {
    if (op.transition !== undefined && op.transition !== existing.transition) {
      // A link the user drew without a transition invites one; a transition the user wrote is theirs.
      if (existing.createdBy === "user" && existing.transition.trim() !== "") {
        throw decision(
          `The user linked ${describe(from)} → ${describe(to)} with the transition "${existing.transition}".`,
        );
      }
      existing.transition = op.transition;
    }
    return { op: op.op, id: existing.id };
  }
  if (isRemoved(graph, from.id, to.id)) {
    throw decision(`The user removed the link ${describe(from)} → ${describe(to)}.`);
  }
  const next = graph.edges.find((edge) => edge.from === from.id);
  if (next) {
    throw new StoryFailure(
      "invalid_request",
      `${describe(from)} is already followed by ${nameOf(state, next.to)}; disconnect it first, or use set_order to arrange the chapters`,
    );
  }
  const previous = graph.edges.find((edge) => edge.to === to.id);
  if (previous) {
    throw new StoryFailure(
      "invalid_request",
      `${describe(to)} already follows ${nameOf(state, previous.from)}; disconnect it first, or use set_order to arrange the chapters`,
    );
  }
  if (reaches(graph, to.id, from.id)) {
    throw new StoryFailure(
      "invalid_request",
      `${describe(from)} → ${describe(to)} would make the sequence loop`,
    );
  }
  const edge: StoryEdge = {
    id: newId("edge", state.taken),
    kind: "sequence",
    from: from.id,
    to: to.id,
    transition: op.transition ?? "",
    createdBy: "ai",
  };
  state.taken.add(edge.id);
  graph.edges.push(edge);
  return { op: op.op, id: edge.id };
}

function disconnect(
  state: State,
  op: Extract<StoryOperation, { op: "disconnect" }>,
): StoryOperationResult {
  const from = chapterOf(state, op.from);
  const to = chapterOf(state, op.to);
  const edge = state.graph.edges.find((entry) => entry.from === from.id && entry.to === to.id);
  if (!edge) {
    throw new StoryFailure("invalid_request", `${describe(from)} is not linked to ${describe(to)}`);
  }
  if (edge.createdBy === "user") {
    throw decision(`The user linked ${describe(from)} → ${describe(to)}.`);
  }
  state.graph.edges = state.graph.edges.filter((entry) => entry !== edge);
  return { op: op.op, id: edge.id };
}

function setOrder(
  state: State,
  op: Extract<StoryOperation, { op: "set_order" }>,
): StoryOperationResult {
  const { graph } = state;
  const listed = op.chapters.map((id) => chapterOf(state, id));
  if (new Set(listed.map((chapter) => chapter.id)).size !== listed.length) {
    throw new StoryFailure("invalid_request", "set_order lists a chapter twice");
  }
  const all = graph.nodes.filter(isChapter);
  const missing = all.filter((chapter) => !listed.includes(chapter));
  if (missing.length > 0) {
    throw new StoryFailure(
      "invalid_request",
      `set_order must list every chapter; missing ${missing.map(describe).join(", ")}`,
    );
  }
  const pairs = listed.slice(0, -1).map((chapter, index) => ({
    from: chapter.id,
    to: listed[index + 1]?.id ?? "",
  }));
  const wanted = new Set(pairs.map((pair) => `${pair.from}\0${pair.to}`));
  const drop = graph.edges.filter((edge) => !wanted.has(`${edge.from}\0${edge.to}`));
  for (const edge of drop) {
    if (edge.createdBy === "user") {
      throw decision(
        `The user linked ${nameOf(state, edge.from)} → ${nameOf(state, edge.to)}, which this order would break.`,
      );
    }
  }
  const add = pairs.filter(
    (pair) => !graph.edges.some((edge) => edge.from === pair.from && edge.to === pair.to),
  );
  for (const pair of add) {
    if (isRemoved(graph, pair.from, pair.to)) {
      throw decision(
        `The user removed the link ${nameOf(state, pair.from)} → ${nameOf(state, pair.to)}, which this order would restore.`,
      );
    }
  }
  graph.edges = graph.edges.filter((edge) => !drop.includes(edge));
  for (const pair of add) {
    const edge: StoryEdge = {
      id: newId("edge", state.taken),
      kind: "sequence",
      from: pair.from,
      to: pair.to,
      transition: "",
      createdBy: "ai",
    };
    state.taken.add(edge.id);
    graph.edges.push(edge);
  }
  return { op: op.op, id: null };
}

// ── attachments ──────────────────────────────────────────────────────────────

function attach(state: State, op: Extract<StoryOperation, { op: "attach" }>): StoryOperationResult {
  const { graph } = state;
  const material = materialOf(state, op.node);
  const chapter = chapterOf(state, op.chapter);
  if (material.locked) throw locked(material);
  if (chapter.locked) throw locked(chapter);
  const existing = graph.attachments.find(
    (item) => item.node === material.id && item.chapter === chapter.id,
  );
  if (existing) {
    const next = {
      placement: op.placement ?? existing.placement,
      offset: op.offset === undefined ? existing.offset : op.offset,
      duration: op.duration === undefined ? existing.duration : op.duration,
    };
    const changed = !sameJson(next, {
      placement: existing.placement,
      offset: existing.offset,
      duration: existing.duration,
    });
    if (changed && existing.createdBy === "user") {
      throw decision(
        `The user attached ${describe(material)} to ${describe(chapter)} (placement ${existing.placement}).`,
      );
    }
    Object.assign(existing, next);
    return { op: op.op, id: existing.id };
  }
  if (isDetached(graph, material.id, chapter.id)) {
    throw decision(`The user detached ${describe(material)} from ${describe(chapter)}.`);
  }
  const item: StoryAttachment = {
    id: newId("att", state.taken),
    node: material.id,
    chapter: chapter.id,
    placement: op.placement ?? DEFAULT_PLACEMENT[material.kind],
    offset: op.offset ?? null,
    duration: op.duration ?? null,
    createdBy: "ai",
  };
  state.taken.add(item.id);
  graph.attachments.push(item);
  return { op: op.op, id: item.id };
}

function detach(state: State, op: Extract<StoryOperation, { op: "detach" }>): StoryOperationResult {
  const material = materialOf(state, op.node);
  const chapter = chapterOf(state, op.chapter);
  if (material.locked) throw locked(material);
  if (chapter.locked) throw locked(chapter);
  const item = state.graph.attachments.find(
    (entry) => entry.node === material.id && entry.chapter === chapter.id,
  );
  if (!item) {
    throw new StoryFailure(
      "invalid_request",
      `${describe(material)} is not attached to ${describe(chapter)}`,
    );
  }
  if (item.createdBy === "user") {
    throw decision(`The user attached ${describe(material)} to ${describe(chapter)}.`);
  }
  state.graph.attachments = state.graph.attachments.filter((entry) => entry !== item);
  return { op: op.op, id: item.id };
}

// ── story-level ──────────────────────────────────────────────────────────────

async function setStory(
  env: OpsEnv,
  state: State,
  op: Extract<StoryOperation, { op: "set_story" }>,
): Promise<StoryOperationResult> {
  const { graph } = state;
  if (op.title !== undefined) graph.title = op.title;
  if (op.brief !== undefined) graph.brief = op.brief;
  if (op.captionPreset !== undefined) {
    if (op.captionPreset !== null && !(await env.hasCaptionPreset(op.captionPreset))) {
      throw new StoryFailure("unknown_preset", `No caption preset "${op.captionPreset}"`);
    }
    graph.settings.captionPreset = op.captionPreset;
  }
  if (op.composition !== undefined) {
    if (op.composition !== null && !env.hasComposition(op.composition)) {
      throw new StoryFailure("unknown_asset", `No composition "${op.composition}" in this project`);
    }
    graph.settings.composition = op.composition;
  }
  if (op.reviewSummary !== undefined) {
    graph.review = { at: env.now, turnId: env.turnId, summary: op.reviewSummary };
  }
  return { op: op.op, id: graph.id };
}

// ── resolve_missing ──────────────────────────────────────────────────────────

/** Which project media kinds can stand in for a Missing Asset node of a media kind. */
const RESOLVING_KINDS: Record<MissingMediaKind, readonly MediaKind[]> = {
  video: ["video"],
  picture: ["image", "video"],
  graphics: ["image", "video"],
  music: ["audio"],
  sfx: ["audio"],
};

/**
 * Replaces a Missing Asset node with the concrete material node for `asset`: same position, a new never-reused id,
 * every attachment re-pointed (ids, placement, offset and duration kept). The Missing Asset node is removed without a
 * tombstone: it was not the user's decision to drop it. A chapter that only waited for this material stops needing it.
 */
async function resolveMissing(
  env: OpsEnv,
  state: State,
  op: Extract<StoryOperation, { op: "resolve_missing" }>,
): Promise<StoryOperationResult> {
  const { graph } = state;
  const missing = nodeOf(state, op.id);
  if (missing.kind !== "missing") {
    throw new StoryFailure(
      "invalid_request",
      `${describe(missing)} is not a Missing Asset node; resolve_missing replaces only those`,
    );
  }
  if (missing.locked) throw locked(missing);
  const attachments = graph.attachments.filter((item) => item.node === missing.id);
  for (const item of attachments) {
    const chapter = graph.nodes.find((candidate) => candidate.id === item.chapter);
    if (chapter?.locked) throw locked(chapter);
  }
  const file = await env.mediaFile(op.asset);
  if (!file) {
    throw new StoryFailure("unknown_asset", `asset: no file "${op.asset}" in this project`);
  }
  const accepted = RESOLVING_KINDS[missing.mediaKind];
  if (!accepted.includes(file.kind)) {
    throw new StoryFailure(
      "invalid_request",
      `asset: ${file.path} is ${file.kind === "image" ? "a picture" : `a ${file.kind} file`}, but ${describe(missing)} needs ${accepted.map((kind) => (kind === "image" ? "a picture" : kind)).join(" or ")}`,
    );
  }
  const id = newId(
    file.kind === "audio" ? "music" : file.kind === "image" ? "picture" : "video",
    state.taken,
  );
  const base = {
    id,
    title: op.title ?? missing.title,
    position: { ...missing.position },
    locked: false,
    createdBy: "ai" as const,
    userEdited: [] as string[],
  };
  const resolvedFrom: MissingResolution = {
    missing: missing.id,
    mediaKind: missing.mediaKind,
    need: missing.need,
    at: env.now,
    turnId: env.turnId,
  };
  const usageIntent = op.usageIntent ?? missing.need;
  let node: StoryNode;
  switch (file.kind) {
    case "video": {
      const sourceIn = op.sourceIn ?? 0;
      const sourceOut = op.sourceOut ?? null;
      if (sourceOut !== null && sourceOut <= sourceIn) {
        throw new StoryFailure("invalid_request", "sourceOut must be after sourceIn");
      }
      node = {
        ...base,
        kind: "video",
        asset: file.path,
        sourceIn,
        sourceOut,
        usageIntent,
        previewFrame: { source: file.path, time: sourceIn },
        resolvedFrom,
      };
      break;
    }
    case "image":
      node = { ...base, kind: "picture", asset: file.path, usageIntent, resolvedFrom };
      break;
    case "audio":
      node = {
        ...base,
        kind: "music",
        asset: file.path,
        bpm: null,
        volume: 1,
        usageIntent,
        resolvedFrom,
      };
      break;
  }
  state.taken.add(id);
  graph.nodes = graph.nodes.map((candidate) => (candidate === missing ? node : candidate));
  for (const item of attachments) item.node = id;
  graph.removedByUser = graph.removedByUser.filter(
    (removal) => removal.kind !== "attachment" || removal.node !== missing.id,
  );
  for (const chapterId of new Set(attachments.map((item) => item.chapter))) {
    const chapter = graph.nodes.find((candidate) => candidate.id === chapterId);
    if (!chapter || !isChapter(chapter) || chapter.status !== "needs_material") continue;
    if (chapter.userEdited.includes("status")) continue;
    const stillWaiting = graph.attachments.some((item) => {
      if (item.chapter !== chapter.id) return false;
      return graph.nodes.find((candidate) => candidate.id === item.node)?.kind === "missing";
    });
    if (!stillWaiting) chapter.status = "proposed";
  }
  return { op: op.op, id };
}

// ── batch ────────────────────────────────────────────────────────────────────

async function applyOne(
  env: OpsEnv,
  state: State,
  op: StoryOperation,
): Promise<StoryOperationResult> {
  switch (op.op) {
    case "add_node":
      return addNode(env, state, op);
    case "update_node":
      return updateNode(env, state, op);
    case "remove_node":
      return removeNode(state, op);
    case "connect":
      return connect(state, op);
    case "disconnect":
      return disconnect(state, op);
    case "set_order":
      return setOrder(state, op);
    case "attach":
      return attach(state, op);
    case "detach":
      return detach(state, op);
    case "set_story":
      return setStory(env, state, op);
    case "resolve_missing":
      return resolveMissing(env, state, op);
  }
}

/**
 * Runs an agent's batch against a copy of the graph. Every operation is checked against the user's decisions: a locked
 * node is never changed, a field the user set by hand is never overwritten, a user-created node/edge/attachment is
 * never removed and what the user removed is never put back. The first refusal aborts the batch (`opIndex`); the input
 * graph is not touched. New nodes are laid out, existing positions never move.
 */
export async function applyStoryOperations(
  env: OpsEnv,
  base: StoryGraph | null,
  emptyGraph: () => StoryGraph,
  operations: readonly StoryOperation[],
): Promise<OpsOutcome> {
  const graph: StoryGraph = base ? structuredClone(base) : emptyGraph();
  const state: State = {
    graph,
    existed: base !== null,
    refs: new Map(),
    created: new Set(),
    taken: new Set([
      ...graph.nodes.map((node) => node.id),
      ...graph.edges.map((edge) => edge.id),
      ...graph.attachments.map((item) => item.id),
    ]),
  };
  const results: StoryOperationResult[] = [];
  for (const [index, op] of operations.entries()) {
    try {
      results.push(await applyOne(env, state, op));
    } catch (error) {
      throw isStoryFailure(error) ? error.atOperation(index) : error;
    }
  }
  if (
    graph.nodes.length > STORY_LIMITS.nodes ||
    graph.edges.length > STORY_LIMITS.edges ||
    graph.attachments.length > STORY_LIMITS.attachments
  ) {
    throw new StoryFailure("invalid_request", "The story would grow past its size limits");
  }
  const problems = validateStoryGraph(graph);
  if (problems.length > 0) throw new StoryFailure("invalid_request", problems.join(" "));
  layoutNewNodes(graph, state.created);
  return { graph, results };
}
