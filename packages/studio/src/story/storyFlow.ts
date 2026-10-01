/** The Story Graph as React Flow nodes and edges. Pure; the canvas keeps what React Flow measured. */

import { MarkerType, type BuiltInEdge, type Edge, type Node } from "@xyflow/react";
import type {
  StoryAttachment,
  StoryEdge,
  StoryGraph,
  StoryNode,
  StoryNodeFacts,
  StorySyncReport,
} from "@hyperframes/agent-protocol";
import { STORY_KIND_STYLES } from "./storyKinds";
import type { StorySelection } from "./storyStore";
import { chapterBadges, materialBadge, type SyncBadge } from "./storySync";

/** Longest transition note drawn on a play-order link before it is cut with an ellipsis. */
const TRANSITION_LABEL_MAX = 24;

/** Handle ids: sequence in/out on a chapter's sides, materials attach to its bottom from their top. */
export const HANDLES = {
  sequenceIn: "in",
  sequenceOut: "out",
  material: "material",
  attach: "attach",
} as const;

/** A chapter a material is used in, as its card names it ("Use in 02 The problem"). */
export interface CardUse {
  number: number | null;
  title: string;
}

export type StoryCardData = {
  node: StoryNode;
  facts: StoryNodeFacts | undefined;
  projectId: string;
  /** Chapters: 1-based place in the play order. */
  number: number | null;
  readOnly: boolean;
  /** How the node's built material relates to the timeline (empty when in sync or never built). */
  sync: SyncBadge[];
  /** Materials: the chapters they are attached to, in play order. */
  uses: CardUse[];
};

export type StoryFlowNode = Node<StoryCardData, "chapter" | "material">;

export interface FlowNodeInput {
  graph: StoryGraph | null;
  facts: Record<string, StoryNodeFacts>;
  projectId: string;
  selection: StorySelection;
  readOnly: boolean;
  /** Chapter ids in play order. */
  order: readonly string[];
  sync: StorySyncReport | null;
}

function sameBadges(a: readonly SyncBadge[], b: readonly SyncBadge[]): boolean {
  return (
    a.length === b.length &&
    a.every((badge, index) => {
      const other = b[index];
      return (
        badge.kind === other.kind && badge.label === other.label && badge.detail === other.detail
      );
    })
  );
}

function sameUses(a: readonly CardUse[], b: readonly CardUse[]): boolean {
  return (
    a.length === b.length &&
    a.every((use, index) => use.number === b[index].number && use.title === b[index].title)
  );
}

/**
 * The nodes and links that stay bright while one node is selected: the node itself, the chapters it is attached to
 * (or the materials attached to it) and its neighbours in play order. Empty unless exactly one node is selected.
 */
export function relatedTo(graph: StoryGraph | null, selection: StorySelection): Set<string> {
  const related = new Set<string>();
  if (!graph || selection.nodes.length !== 1 || selection.edges.length > 0) return related;
  const id = selection.nodes[0];
  related.add(id);
  for (const attachment of graph.attachments) {
    if (attachment.node !== id && attachment.chapter !== id) continue;
    related.add(attachment.id).add(attachment.node).add(attachment.chapter);
  }
  for (const edge of graph.edges) {
    if (edge.from === id || edge.to === id) related.add(edge.id).add(edge.from).add(edge.to);
  }
  return related;
}

/**
 * Builds the canvas nodes, reusing the previous object for a node nothing changed about (so React Flow skips
 * it) and carrying over what React Flow measured (so nodes never flash back to unmeasured).
 */
export function toFlowNodes(
  input: FlowNodeInput,
  previous: readonly StoryFlowNode[],
): StoryFlowNode[] {
  const { graph, facts, projectId, selection, readOnly, order, sync } = input;
  if (!graph) return [];
  const before = new Map(previous.map((node) => [node.id, node]));
  const selected = new Set(selection.nodes);
  const related = relatedTo(graph, selection);
  const numbers = new Map(order.map((id, index) => [id, index + 1]));
  const titles = new Map(graph.nodes.map((node) => [node.id, node.title]));
  const uses = new Map<string, CardUse[]>();
  for (const attachment of graph.attachments) {
    const list = uses.get(attachment.node) ?? [];
    list.push({
      number: numbers.get(attachment.chapter) ?? null,
      title: titles.get(attachment.chapter) ?? "",
    });
    uses.set(attachment.node, list);
  }
  return graph.nodes.map((node) => {
    const old = before.get(node.id);
    const material = node.kind === "chapter" ? null : materialBadge(sync, node.id);
    const data: StoryCardData = {
      node,
      facts: facts[node.id],
      projectId,
      number: numbers.get(node.id) ?? null,
      readOnly,
      sync: node.kind === "chapter" ? chapterBadges(sync, node.id) : material ? [material] : [],
      uses: (uses.get(node.id) ?? []).sort(
        (a, b) => (a.number ?? Infinity) - (b.number ?? Infinity),
      ),
    };
    const isSelected = selected.has(node.id);
    const className = related.has(node.id) && !isSelected ? "hf-rel" : undefined;
    if (
      old &&
      old.data.node === node &&
      old.data.facts === data.facts &&
      old.data.number === data.number &&
      old.data.readOnly === readOnly &&
      sameBadges(old.data.sync, data.sync) &&
      sameUses(old.data.uses, data.uses) &&
      old.data.projectId === projectId &&
      Boolean(old.selected) === isSelected &&
      old.className === className &&
      old.position.x === node.position.x &&
      old.position.y === node.position.y
    ) {
      return old;
    }
    return {
      id: node.id,
      type: node.kind === "chapter" ? "chapter" : "material",
      position: node.position,
      data,
      selected: isSelected,
      ...(className ? { className } : {}),
      ...(old?.measured ? { measured: old.measured } : {}),
    };
  });
}

/** A play-order link: the prototype's spine between chapters, with its transition as a label. */
function sequenceEdge(edge: StoryEdge, selected: boolean, related: boolean): Edge {
  return {
    id: edge.id,
    source: edge.from,
    target: edge.to,
    sourceHandle: HANDLES.sequenceOut,
    targetHandle: HANDLES.sequenceIn,
    selected,
    className: related ? "hf-sg-spine hf-rel" : "hf-sg-spine",
    // The canvas shows a short tag; the edge inspector carries the whole transition note.
    label:
      edge.transition.length > TRANSITION_LABEL_MAX
        ? `${edge.transition.slice(0, TRANSITION_LABEL_MAX - 1).trimEnd()}…`
        : edge.transition || undefined,
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 4,
    markerEnd: {
      type: MarkerType.Arrow,
      color: selected ? "var(--color-accent)" : "var(--color-fg-3)",
      width: 14,
      height: 14,
      strokeWidth: 1.6,
    },
    zIndex: 1,
  };
}

/** A material's link into its chapter: an orthogonal rail in the material's kind hue. */
function attachmentEdge(
  attachment: StoryAttachment,
  kind: StoryNode["kind"],
  selected: boolean,
  related: boolean,
): BuiltInEdge {
  return {
    id: attachment.id,
    source: attachment.node,
    target: attachment.chapter,
    sourceHandle: HANDLES.attach,
    targetHandle: HANDLES.material,
    selected,
    type: "smoothstep",
    pathOptions: { borderRadius: 8 },
    className: `hf-sg-link ${STORY_KIND_STYLES[kind].kindClass}${related ? " hf-rel" : ""}`,
  };
}

export function toFlowEdges(graph: StoryGraph | null, selection: StorySelection): Edge[] {
  if (!graph) return [];
  const selected = new Set(selection.edges);
  const related = relatedTo(graph, selection);
  const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const edges = graph.edges.map((edge) =>
    sequenceEdge(edge, selected.has(edge.id), related.has(edge.id)),
  );
  for (const attachment of graph.attachments) {
    const kind = kinds.get(attachment.node);
    if (!kind) continue;
    edges.push(
      attachmentEdge(attachment, kind, selected.has(attachment.id), related.has(attachment.id)),
    );
  }
  return edges;
}
