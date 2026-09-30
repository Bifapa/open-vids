import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type IsValidConnection,
  type NodeChange,
} from "@xyflow/react";
import { storyOrder, type StoryPoint } from "@hyperframes/agent-protocol";
import { cn } from "../components/ui";
import { useStoryServices, useStoryStore } from "./storyContext";
import { toFlowEdges, toFlowNodes, type StoryFlowNode } from "./storyFlow";
import { connectNodes, moveNodes } from "./storyGraphOps";
import { STORY_KIND_STYLES } from "./storyKinds";
import { STORY_NODE_TYPES } from "./StoryNodeCard";
import "@xyflow/react/dist/style.css";
import "./story.css";

/** The ids of `current` after React Flow's select changes. */
function applySelect(
  current: readonly string[],
  changes: ReadonlyArray<{ id: string; selected: boolean }>,
): string[] {
  const next = new Set(current);
  for (const change of changes) {
    if (change.selected) next.add(change.id);
    else next.delete(change.id);
  }
  return [...next];
}

function selectChanges(changes: ReadonlyArray<NodeChange<StoryFlowNode> | EdgeChange>) {
  return changes.flatMap((change) =>
    change.type === "select" ? [{ id: change.id, selected: change.selected }] : [],
  );
}

/**
 * The graph canvas. Positions, connections and selection go through the story store; while the agent works
 * the canvas can still be panned, zoomed and inspected, but nothing moves or connects.
 */
export function StoryCanvas({ onRefused }: { onRefused: (reason: string) => void }) {
  const { store } = useStoryServices();
  const projectId = useStoryStore((state) => state.projectId ?? "");
  const graph = useStoryStore((state) => state.graph);
  const facts = useStoryStore((state) => state.facts);
  const selection = useStoryStore((state) => state.selection);
  const readOnly = useStoryStore((state) => state.agentBusy);
  const order = useMemo(() => (graph ? storyOrder(graph).chapters : []), [graph]);
  // Bumped when a finished drag was refused: the cards go back to where the graph has them.
  const [resync, bumpResync] = useReducer((count: number) => count + 1, 0);

  const [nodes, setNodes] = useState<StoryFlowNode[]>([]);
  useEffect(() => {
    setNodes((previous) =>
      toFlowNodes({ graph, facts, projectId, selection, readOnly, order }, previous),
    );
  }, [graph, facts, projectId, selection, readOnly, order, resync]);
  const edges = useMemo(() => toFlowEdges(graph, selection), [graph, selection]);

  const onNodesChange = useCallback(
    (changes: NodeChange<StoryFlowNode>[]) => {
      setNodes((previous) => applyNodeChanges(changes, previous));
      const selects = selectChanges(changes);
      if (selects.length > 0) {
        const current = store.getState().selection;
        store.getState().select({ ...current, nodes: applySelect(current.nodes, selects) });
      }
      // A finished drag (or a keyboard nudge) arrives as positions with `dragging: false`: one undo step.
      const moved = new Map<string, StoryPoint>();
      for (const change of changes) {
        if (change.type === "position" && change.dragging === false && change.position) {
          moved.set(change.id, change.position);
        }
      }
      if (moved.size === 0) return;
      const graphNow = store.getState().graph;
      const changed = graphNow !== null && moveNodes(graphNow, moved) !== graphNow;
      if (changed && !store.getState().commit((current) => moveNodes(current, moved))) {
        bumpResync();
      }
    },
    [store],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const selects = selectChanges(changes);
      if (selects.length === 0) return;
      const current = store.getState().selection;
      store.getState().select({ ...current, edges: applySelect(current.edges, selects) });
    },
    [store],
  );

  const isValidConnection: IsValidConnection = useCallback(
    (connection) => {
      const current = store.getState().graph;
      return current !== null && connectNodes(current, connection).ok;
    },
    [store],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      let reason: string | null = null;
      let created: string | null = null;
      store.getState().commit((current) => {
        const result = connectNodes(current, connection);
        if (!result.ok) {
          reason = result.reason;
          return current;
        }
        created = result.id;
        return result.graph;
      });
      if (reason) onRefused(reason);
      if (created) store.getState().select({ nodes: [], edges: [created] });
    },
    [store, onRefused],
  );

  /** A drop on a handle that refused the connection: say why. */
  const onConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const current = store.getState().graph;
      if (state.isValid !== false || !state.fromNode || !state.toNode || !current) return;
      const fromTarget = state.fromHandle?.type === "target";
      const result = connectNodes(current, {
        source: fromTarget ? state.toNode.id : state.fromNode.id,
        target: fromTarget ? state.fromNode.id : state.toNode.id,
      });
      if (!result.ok) onRefused(result.reason);
    },
    [store, onRefused],
  );

  // Opens on the story's beginning at a readable size; the toolbar's Fit shows the whole story.
  const [initialFit] = useState(() => {
    const opening = order.slice(0, 4).map((id) => ({ id }));
    return opening.length > 0
      ? { nodes: opening, padding: 0.15, minZoom: 0.45, maxZoom: 1 }
      : { padding: 0.2, maxZoom: 1 };
  });

  return (
    <ReactFlow<StoryFlowNode>
      className={cn("hf-story-flow", readOnly && "hf-story-readonly")}
      colorMode="dark"
      nodes={nodes}
      edges={edges}
      nodeTypes={STORY_NODE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectEnd={onConnectEnd}
      isValidConnection={isValidConnection}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      elementsSelectable
      deleteKeyCode={null}
      panActivationKeyCode={null}
      multiSelectionKeyCode={["Meta", "Control", "Shift"]}
      onlyRenderVisibleElements
      minZoom={0.05}
      maxZoom={1.75}
      fitView
      fitViewOptions={initialFit}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
      <Controls position="bottom-left" showInteractive={false} />
      <MiniMap<StoryFlowNode>
        position="bottom-right"
        pannable
        zoomable
        nodeColor={(node) => STORY_KIND_STYLES[node.data.node.kind].stroke}
        nodeBorderRadius={4}
        style={{ width: 150, height: 96 }}
      />
    </ReactFlow>
  );
}
