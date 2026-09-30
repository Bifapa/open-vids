import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { CircleNotch, TreeStructure, X } from "@phosphor-icons/react";
import type { StoryAction, StoryActionOptions, StoryPoint } from "@hyperframes/agent-protocol";
import type { AgentStore } from "../agent/agentStore";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { Button } from "../components/ui";
import { isTextFieldTarget } from "../utils/typingTarget";
import { FullBuildDialog } from "./FullBuildDialog";
import { RebuildDialog } from "./RebuildDialog";
import { StoryCanvas } from "./StoryCanvas";
import { useStoryServices, useStoryStore } from "./storyContext";
import { addNode, newChapter, newMaterial, newStoryId, removeItems } from "./storyGraphOps";
import { StoryInspector } from "./StoryInspector";
import { StoryToolbar } from "./StoryToolbar";
import type { NewNodeRequest } from "./AddNodePopover";
import { fullBuildNeedsConfirm, syncBlocker } from "./storySync";
import { agentBlocker, useStoryAgent, useStoryAgentSync } from "./useStoryAgent";
import { useStoryLibrary } from "./useStoryLibrary";
import { useStoryTimelineSync } from "./useStoryTimelineSync";

/** The Story panel's modal: the impact of a rebuild (every affected section, or the chosen ones), or the confirm
 * of a full build over edits and locked sections. */
type StoryPanelDialog = { kind: "rebuild"; chapters: string[] | null } | { kind: "build" };

/** Card size used to keep a new node off the ones already there. */
const CARD = { width: 232, height: 200 };

/** The first free spot at or after `start`, stepping diagonally past existing cards. */
function freeSpot(start: StoryPoint, taken: readonly StoryPoint[]): StoryPoint {
  let spot = { x: Math.round(start.x), y: Math.round(start.y) };
  for (let step = 0; step < 50; step += 1) {
    const overlaps = taken.some(
      (other) =>
        Math.abs(other.x - spot.x) < CARD.width * 0.6 &&
        Math.abs(other.y - spot.y) < CARD.height * 0.6,
    );
    if (!overlaps) return spot;
    spot = { x: spot.x + 36, y: spot.y + 36 };
  }
  return spot;
}

function EmptyStory({
  onStart,
  onPlan,
  planDisabled,
}: {
  onStart: () => void;
  onPlan: () => void;
  planDisabled: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <TreeStructure size={28} className="text-text-4" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="text-step-13 font-semibold text-text-1">No story yet</p>
        <p className="max-w-sm text-step-11 text-text-3">
          Ask the agent to plan the video as chapters from your footage, or start with a chapter and
          build it yourself.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={planDisabled} onClick={onPlan}>
          Plan with AI
        </Button>
        <Button variant="secondary" size="sm" onClick={onStart}>
          Add a chapter
        </Button>
      </div>
    </div>
  );
}

function StoryWorkspace({ agentStore }: { agentStore: AgentStore | null }) {
  const { store, client } = useStoryServices();
  const projectId = useStoryStore((state) => state.projectId ?? "");
  const status = useStoryStore((state) => state.status);
  const loadError = useStoryStore((state) => state.loadError);
  const hasGraph = useStoryStore((state) => state.graph !== null);
  const agentBusy = useStoryStore((state) => state.agentBusy);
  const notice = useStoryStore((state) => state.notice);
  const sync = useStoryStore((state) => state.sync);
  const [dialog, setDialog] = useState<StoryPanelDialog | null>(null);
  const agent = useStoryAgent(agentStore);
  const library = useStoryLibrary(client, projectId);
  const flow = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useStoryAgentSync(agentStore, store);
  useStoryTimelineSync(store);

  const refuse = useCallback((reason: string) => store.getState().setNotice(reason), [store]);

  const viewportCenter = (): StoryPoint => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { x: 0, y: 0 };
    const center = flow.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    return { x: center.x - CARD.width / 2, y: center.y - CARD.height / 2 };
  };

  const add = (request: NewNodeRequest) => {
    let created: string | null = null;
    store.getState().commit((graph) => {
      const id = newStoryId(graph, request.kind === "chapter" ? "ch" : request.kind);
      const position = freeSpot(
        viewportCenter(),
        graph.nodes.map((node) => node.position),
      );
      const node =
        request.kind === "chapter" ? newChapter(id, position) : newMaterial(id, position, request);
      if (!node) return graph;
      const result = addNode(graph, node);
      if (!result.ok) {
        store.getState().setNotice(result.reason);
        return graph;
      }
      created = result.id;
      return result.graph;
    });
    if (created) store.getState().select({ nodes: [created], edges: [] });
  };

  const runAction = async (action: StoryAction, options?: StoryActionOptions) => {
    setDialog(null);
    if (!(await store.getState().flush())) return;
    const result = await agent.runStoryAction(action, options);
    if (!result.ok) {
      store.getState().setNotice(result.message);
      return;
    }
    useDockLayoutStore.getState().activatePanel("chat");
  };

  /** A full build over a story built and then edited on the timeline (or locked) asks first. */
  const requestAction = (action: StoryAction) => {
    if (action === "build" && fullBuildNeedsConfirm(store.getState().sync)) {
      setDialog({ kind: "build" });
      return;
    }
    void runAction(action);
  };

  const blocker = agentBlocker(agent);
  let dialogView = null;
  if (dialog && sync && status === "ready") {
    dialogView =
      dialog.kind === "rebuild" ? (
        <RebuildDialog
          report={sync}
          chapters={dialog.chapters}
          blocker={blocker}
          onClose={() => setDialog(null)}
          onStart={(options) => void runAction("rebuild", options)}
        />
      ) : (
        <FullBuildDialog
          report={sync}
          rebuildBlocker={syncBlocker(sync) ?? blocker}
          blocker={blocker}
          onClose={() => setDialog(null)}
          onBuild={(options) => void runAction("build", options)}
          onRebuildInstead={() => setDialog({ kind: "rebuild", chapters: null })}
        />
      );
  }

  const planWithAi = async () => {
    const result = await agent.planWithAi();
    if (!result.ok) store.getState().setNotice(result.message);
    else useDockLayoutStore.getState().activatePanel("chat");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Fields keep their keys; anywhere else in the panel Delete/Backspace deletes the selection.
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (event.altKey || event.metaKey || event.ctrlKey || isTextFieldTarget(event.target)) return;
    // An open dialog owns its keys; the canvas behind it keeps its selection.
    if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
    const { selection } = store.getState();
    const ids = [...selection.nodes, ...selection.edges];
    if (ids.length === 0) return;
    event.preventDefault();
    store.getState().commit((graph) => removeItems(graph, ids));
  };

  // Clicking the canvas must put focus inside the panel, or its shortcuts would go to the editor behind it.
  const onPointerDownCapture = () => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  };

  // Deleting the focused card (or the inspector's button with it) drops focus to the body, where ⌘Z would undo
  // file history instead of the story. While the user works in the panel, an edit brings focus back to it.
  const focusWithin = useRef(false);
  const onBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !rootRef.current?.contains(next)) focusWithin.current = false;
  };
  useEffect(() => {
    // A click elsewhere in the editor leaves focus on the body too, but the user has left the panel.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        focusWithin.current = false;
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.graph === previous.graph || !focusWithin.current) return;
      requestAnimationFrame(() => {
        if (document.activeElement === document.body)
          rootRef.current?.focus({ preventScroll: true });
      });
    });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      unsubscribe();
    };
  }, [store]);

  let content;
  if (status === "loading" || status === "idle") {
    content = (
      <div
        className="flex h-full items-center justify-center text-step-11 text-text-3"
        role="status"
      >
        Loading story…
      </div>
    );
  } else if (status === "error") {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-step-12 text-text-1">Couldn't load the story</p>
        {loadError && <p className="text-step-11 text-text-3">{loadError}</p>}
        <Button size="sm" variant="secondary" onClick={() => void store.getState().reload()}>
          Retry
        </Button>
      </div>
    );
  } else if (!hasGraph) {
    content = (
      <EmptyStory
        onStart={() => add({ kind: "chapter" })}
        onPlan={() => void planWithAi()}
        planDisabled={!agent.available || agent.busy}
      />
    );
  } else {
    content = <StoryCanvas onRefused={refuse} />;
  }

  return (
    <div
      ref={rootRef}
      data-studio-story=""
      data-keyboard-owner=""
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDownCapture={onPointerDownCapture}
      onFocusCapture={() => {
        focusWithin.current = true;
      }}
      onBlurCapture={onBlurCapture}
      className="relative flex h-full min-h-0 flex-col bg-bg-1 text-text-1 outline-hidden"
    >
      <StoryToolbar
        library={library}
        agent={agent}
        onAdd={add}
        onFit={() => void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 200 })}
        onUndo={() => store.getState().undo()}
        onRedo={() => store.getState().redo()}
        onAction={requestAction}
        onRebuild={() => setDialog({ kind: "rebuild", chapters: null })}
      />
      {agentBusy && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-border bg-selection/10 px-3 py-1.5 text-step-11 text-selection"
        >
          <CircleNotch size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
          AI is working on the story… The canvas is read-only until it finishes.
        </div>
      )}
      {notice && (
        <div
          role="alert"
          className="flex shrink-0 items-start justify-between gap-2 border-b border-border bg-container/10 px-3 py-1.5 text-step-11 text-text-1"
        >
          <span>{notice}</span>
          <button
            type="button"
            aria-label="Dismiss message"
            onClick={() => store.getState().setNotice(null)}
            className="shrink-0 rounded-sm text-text-3 outline-hidden hover:text-text-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div ref={canvasRef} className="relative min-w-0 flex-1">
          {content}
        </div>
        {hasGraph && status === "ready" && (
          <StoryInspector
            library={library}
            onRebuildSection={(chapter) => setDialog({ kind: "rebuild", chapters: [chapter] })}
          />
        )}
      </div>
      {dialogView}
    </div>
  );
}

/**
 * The Story dock panel: the project's Story Graph as an editable canvas with an inspector. Opens the project's
 * story in the shared store and keeps it in step with agent turns.
 */
export function StoryPanel({
  projectId,
  agentStore,
}: {
  projectId: string;
  agentStore: AgentStore | null;
}) {
  const { store } = useStoryServices();
  useEffect(() => {
    void store.getState().open(projectId);
  }, [store, projectId]);
  return (
    <ReactFlowProvider>
      <StoryWorkspace agentStore={agentStore} />
    </ReactFlowProvider>
  );
}
