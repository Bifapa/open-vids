/** The Story Graph as React Flow nodes and edges. Pure; the canvas keeps what React Flow measured. */

import { MarkerType, type Edge, type Node } from "@xyflow/react";
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

/** Handle ids: sequence in/out on a chapter's sides, materials attach to its bottom from their top. */
export const HANDLES = {
  sequenceIn: "in",
  sequenceOut: "out",
  material: "material",
  attach: "attach",
} as const;

export type StoryCardData = {
  node: StoryNode;
  facts: StoryNodeFacts | undefined;
  projectId: string;
  /** Chapters: 1-based place in the play order. */
  number: number | null;
  readOnly: boolean;
  /** How the node's built material relates to the timeline (empty when in sync or never built). */
  sync: SyncBadge[];
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
  const numbers = new Map(order.map((id, index) => [id, index + 1]));
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
    };
    const isSelected = selected.has(node.id);
    if (
      old &&
      old.data.node === node &&
      old.data.facts === data.facts &&
      old.data.number === data.number &&
      old.data.readOnly === readOnly &&
      sameBadges(old.data.sync, data.sync) &&
      old.data.projectId === projectId &&
      Boolean(old.selected) === isSelected &&
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
      ...(old?.measured ? { measured: old.measured } : {}),
    };
  });
}

function sequenceEdge(edge: StoryEdge, selected: boolean): Edge {
  return {
    id: edge.id,
    source: edge.from,
    target: edge.to,
    sourceHandle: HANDLES.sequenceOut,
    targetHandle: HANDLES.sequenceIn,
    selected,
    label: edge.transition || undefined,
    labelStyle: { fill: "var(--color-text-2)", fontSize: 10, fontWeight: 500 },
    labelBgStyle: { fill: "var(--color-bg-2)" },
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 4,
    style: { stroke: "var(--color-text-2)", strokeWidth: 1.75 },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "var(--color-text-2)",
      width: 14,
      height: 14,
    },
    zIndex: 1,
  };
}

function attachmentEdge(
  attachment: StoryAttachment,
  kind: StoryNode["kind"],
  selected: boolean,
): Edge {
  return {
    id: attachment.id,
    source: attachment.node,
    target: attachment.chapter,
    sourceHandle: HANDLES.attach,
    targetHandle: HANDLES.material,
    selected,
    style: {
      stroke: STORY_KIND_STYLES[kind].stroke,
      strokeWidth: 1.25,
      strokeDasharray: "5 4",
      opacity: 0.85,
    },
  };
}

export function toFlowEdges(graph: StoryGraph | null, selection: StorySelection): Edge[] {
  if (!graph) return [];
  const selected = new Set(selection.edges);
  const kinds = new Map(graph.nodes.map((node) => [node.id, node.kind]));
  const edges = graph.edges.map((edge) => sequenceEdge(edge, selected.has(edge.id)));
  for (const attachment of graph.attachments) {
    const kind = kinds.get(attachment.node);
    if (kind) edges.push(attachmentEdge(attachment, kind, selected.has(attachment.id)));
  }
  return edges;
}
