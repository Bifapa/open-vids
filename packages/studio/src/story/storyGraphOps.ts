/**
 * Manual Story Graph edits, as pure functions of the graph. The canvas and the inspector build every change
 * through these, the store keeps the results as undo snapshots, and the server records authorship from the
 * saved graph — so nothing here sets `createdBy`/`userEdited` on existing items.
 */

import {
  STORY_GRAPH_SCHEMA,
  STORY_LIMITS,
  isChapter,
  type ChapterNode,
  type StoryAttachment,
  type StoryEdge,
  type StoryGraph,
  type StoryMaterialKind,
  type StoryMaterialNode,
  type StoryNode,
  type StoryPoint,
} from "@hyperframes/agent-protocol";

export type StoryEditResult =
  | { ok: true; graph: StoryGraph; id: string }
  | { ok: false; reason: string };

/** One drag from a handle to a handle, as the canvas reports it. */
export interface StoryConnection {
  source: string;
  target: string;
}

function randomSuffix(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID().replace(/-/g, "").slice(0, 10);
  }
  return Math.random().toString(36).slice(2, 12);
}

/** A fresh id no node, edge or attachment uses; ids are never reused, so a random suffix is enough. */
export function newStoryId(graph: StoryGraph | null, prefix: string): string {
  const taken = new Set<string>();
  for (const item of [
    ...(graph?.nodes ?? []),
    ...(graph?.edges ?? []),
    ...(graph?.attachments ?? []),
  ]) {
    taken.add(item.id);
  }
  for (;;) {
    const id = `${prefix}_${randomSuffix()}`;
    if (!taken.has(id)) return id;
  }
}

export function emptyStoryGraph(id: string, now: number, title = "Story"): StoryGraph {
  return {
    schema: STORY_GRAPH_SCHEMA,
    id,
    title,
    brief: "",
    settings: { composition: null, captionPreset: null },
    nodes: [],
    edges: [],
    attachments: [],
    removedByUser: [],
    review: null,
    build: null,
    updatedAt: now,
    updatedBy: "user",
  };
}

const NODE_BASE = { locked: false, createdBy: "user", userEdited: [] } as const;

export function newChapter(id: string, position: StoryPoint): ChapterNode {
  return {
    ...NODE_BASE,
    userEdited: [],
    id,
    kind: "chapter",
    title: "New chapter",
    position,
    purpose: "",
    description: "",
    narrativeRole: "main",
    estimatedDuration: 30,
    status: "proposed",
    sourceRanges: [],
    aRoll: "",
    bRoll: "",
    captions: false,
    graphics: "",
    audio: "",
    previewFrame: null,
  };
}

/** What a new material needs besides its kind: the asset or preset it stands for, when it has one. */
export interface NewMaterialInput {
  kind: StoryMaterialKind;
  /** Asset path (video/picture/music) or preset name (motion). */
  source?: string;
  title?: string;
  /** Natural length of a motion preset. */
  duration?: number | null;
}

export function newMaterial(
  id: string,
  position: StoryPoint,
  input: NewMaterialInput,
): StoryMaterialNode | null {
  const base = { ...NODE_BASE, userEdited: [], id, position };
  const title = input.title?.trim();
  switch (input.kind) {
    case "video":
      if (!input.source) return null;
      return {
        ...base,
        kind: "video",
        title: title || "Video",
        asset: input.source,
        sourceIn: 0,
        sourceOut: null,
        usageIntent: "",
        previewFrame: null,
      };
    case "picture":
      if (!input.source) return null;
      return {
        ...base,
        kind: "picture",
        title: title || "Picture",
        asset: input.source,
        usageIntent: "",
      };
    case "music":
      return {
        ...base,
        kind: "music",
        title: title || "Music",
        asset: input.source ?? null,
        bpm: null,
        volume: 0.3,
        usageIntent: "",
      };
    case "motion":
      if (!input.source) return null;
      return {
        ...base,
        kind: "motion",
        title: title || input.source,
        preset: input.source,
        skill: null,
        inputs: {},
        duration: input.duration ?? null,
        usageIntent: "",
      };
    case "missing":
      return {
        ...base,
        kind: "missing",
        title: title || "Missing asset",
        mediaKind: "video",
        need: "",
        neededDuration: null,
      };
  }
}

function touched(graph: StoryGraph, change: Partial<StoryGraph>): StoryGraph {
  return { ...graph, ...change, updatedAt: Date.now(), updatedBy: "user" };
}

export function addNode(graph: StoryGraph, node: StoryNode): StoryEditResult {
  if (graph.nodes.length >= STORY_LIMITS.nodes) {
    return { ok: false, reason: `A story holds at most ${STORY_LIMITS.nodes} nodes.` };
  }
  return { ok: true, graph: touched(graph, { nodes: [...graph.nodes, node] }), id: node.id };
}

/** Replaces a node by id (the inspector builds the whole next node, so the kind stays right). */
export function replaceNode(graph: StoryGraph, next: StoryNode): StoryGraph {
  return touched(graph, {
    nodes: graph.nodes.map((node) => (node.id === next.id ? next : node)),
  });
}

export function replaceEdge(graph: StoryGraph, next: StoryEdge): StoryGraph {
  return touched(graph, { edges: graph.edges.map((edge) => (edge.id === next.id ? next : edge)) });
}

export function replaceAttachment(graph: StoryGraph, next: StoryAttachment): StoryGraph {
  return touched(graph, {
    attachments: graph.attachments.map((item) => (item.id === next.id ? next : item)),
  });
}

/** Canvas positions only; returns the same graph when nothing moved (so a click is not an edit). */
export function moveNodes(
  graph: StoryGraph,
  positions: ReadonlyMap<string, StoryPoint>,
): StoryGraph {
  let moved = false;
  const nodes = graph.nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position || (position.x === node.position.x && position.y === node.position.y))
      return node;
    moved = true;
    return { ...node, position: { x: Math.round(position.x), y: Math.round(position.y) } };
  });
  return moved ? touched(graph, { nodes }) : graph;
}

/**
 * Deletes nodes, sequence edges and attachments by id. A deleted node takes its edges and attachments with it.
 * Returns the same graph when none of the ids exist.
 */
export function removeItems(graph: StoryGraph, ids: Iterable<string>): StoryGraph {
  const doomed = new Set(ids);
  const nodes = graph.nodes.filter((node) => !doomed.has(node.id));
  const gone = new Set(graph.nodes.filter((node) => doomed.has(node.id)).map((node) => node.id));
  const edges = graph.edges.filter(
    (edge) => !doomed.has(edge.id) && !gone.has(edge.from) && !gone.has(edge.to),
  );
  const attachments = graph.attachments.filter(
    (item) => !doomed.has(item.id) && !gone.has(item.node) && !gone.has(item.chapter),
  );
  if (
    nodes.length === graph.nodes.length &&
    edges.length === graph.edges.length &&
    attachments.length === graph.attachments.length
  ) {
    return graph;
  }
  return touched(graph, { nodes, edges, attachments });
}

/** Would `from → to` close a loop, given the edges that stay? */
function makesCycle(edges: readonly StoryEdge[], from: string, to: string): boolean {
  const next = new Map(edges.map((edge) => [edge.from, edge.to]));
  const seen = new Set<string>();
  let current: string | undefined = to;
  while (current !== undefined && !seen.has(current)) {
    if (current === from) return true;
    seen.add(current);
    current = next.get(current);
  }
  return false;
}

/**
 * Applies a drag between two nodes:
 * - chapter → chapter: a sequence edge. It replaces the source's outgoing and the target's incoming edge
 *   (rewiring the order), and is refused when it would make the story loop.
 * - material → chapter: an attachment (once per pair).
 * Anything else is refused with a reason the canvas can show.
 */
export function connectNodes(graph: StoryGraph, connection: StoryConnection): StoryEditResult {
  const source = graph.nodes.find((node) => node.id === connection.source);
  const target = graph.nodes.find((node) => node.id === connection.target);
  if (!source || !target) return { ok: false, reason: "That node no longer exists." };
  if (source.id === target.id) return { ok: false, reason: "A node cannot connect to itself." };

  if (isChapter(source) && isChapter(target)) {
    if (graph.edges.some((edge) => edge.from === source.id && edge.to === target.id)) {
      return { ok: false, reason: `“${target.title}” already follows “${source.title}”.` };
    }
    const kept = graph.edges.filter((edge) => edge.from !== source.id && edge.to !== target.id);
    if (makesCycle(kept, source.id, target.id)) {
      return { ok: false, reason: "That connection would make the story loop back on itself." };
    }
    const edge: StoryEdge = {
      id: newStoryId(graph, "e"),
      kind: "sequence",
      from: source.id,
      to: target.id,
      transition: "",
      createdBy: "user",
    };
    return { ok: true, graph: touched(graph, { edges: [...kept, edge] }), id: edge.id };
  }

  if (!isChapter(source) && isChapter(target)) {
    if (graph.attachments.some((item) => item.node === source.id && item.chapter === target.id)) {
      return { ok: false, reason: `“${source.title}” is already attached to “${target.title}”.` };
    }
    if (graph.attachments.length >= STORY_LIMITS.attachments) {
      return { ok: false, reason: "The story has too many attachments." };
    }
    const attachment: StoryAttachment = {
      id: newStoryId(graph, "a"),
      node: source.id,
      chapter: target.id,
      placement: source.kind === "music" || source.kind === "missing" ? "throughout" : "start",
      offset: null,
      duration: null,
      createdBy: "user",
    };
    return {
      ok: true,
      graph: touched(graph, { attachments: [...graph.attachments, attachment] }),
      id: attachment.id,
    };
  }

  if (isChapter(source)) {
    return { ok: false, reason: "Drag from the material to the chapter it belongs to." };
  }
  return { ok: false, reason: "Materials attach to chapters, not to each other." };
}
