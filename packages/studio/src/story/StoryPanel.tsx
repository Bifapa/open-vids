import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { TreeStructure, X } from "@phosphor-icons/react";
import type { StoryPoint } from "@hyperframes/agent-protocol";
import type { AgentStore } from "../agent/agentStore";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { useResearchServices, useSourcesStore } from "../research/researchContext";
import { Button, IconButton, Spinner } from "../components/ui";
import { useTranslation } from "../i18n";
import { isTextFieldTarget } from "../utils/typingTarget";
import { StoryCanvas } from "./StoryCanvas";
import { useStoryServices, useStoryStore } from "./storyContext";
import {
  addNode,
  moveNodes,
  newChapter,
  newMaterial,
  newStoryId,
  removeItems,
} from "./storyGraphOps";
import { StoryInspector } from "./StoryInspector";
import { tidyLayout } from "./storyLayout";
import { StorySectionStrip } from "./StorySectionStrip";
import { StoryToolbar, type StoryTool } from "./StoryToolbar";
import type { NewNodeRequest } from "./AddNodePopover";
import { useStoryActions } from "./useStoryActions";
import { agentBlocker, useStoryAgentSync } from "./useStoryAgent";
import { StoryResearchProvider, type StoryResearch } from "./storyResearch";
import { useStoryLibrary } from "./useStoryLibrary";
import { useStoryDrop } from "./useStoryDrop";
import { useStoryTimelineSync } from "./useStoryTimelineSync";

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
  planBlocker,
}: {
  onStart: () => void;
  onPlan: () => void;
  /** Why "Plan with AI" is unavailable right now, in words, or null. */
  planBlocker: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-bg-1 text-fg-3 shadow-raise">
        <TreeStructure size={20} aria-hidden />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-md font-semibold text-fg">{t("story.empty.title")}</p>
        <p className="max-w-sm text-sm leading-[17px] text-pretty text-fg-3">
          {t("story.empty.body")}
        </p>
      </div>
      <div className="flex gap-1.5">
        <Button
          variant="primary"
          size="sm"
          disabled={planBlocker !== null}
          title={planBlocker ?? undefined}
          onClick={onPlan}
        >
          {t("story.empty.plan")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onStart}>
          {t("story.empty.addChapter")}
        </Button>
      </div>
      {planBlocker !== null && (
        <p
          data-testid="story-empty-blocker"
          role="status"
          className="max-w-sm text-xs leading-[15px] text-fg-3"
        >
          {planBlocker}
        </p>
      )}
    </div>
  );
}

function StoryWorkspace({ agentStore }: { agentStore: AgentStore | null }) {
  const { t } = useTranslation();
  const { store, client } = useStoryServices();
  const projectId = useStoryStore((state) => state.projectId ?? "");
  const status = useStoryStore((state) => state.status);
  const loadError = useStoryStore((state) => state.loadError);
  const hasGraph = useStoryStore((state) => state.graph !== null);
  const agentBusy = useStoryStore((state) => state.agentBusy);
  const notice = useStoryStore((state) => state.notice);
  const [tool, setTool] = useState<StoryTool>("select");
  const actions = useStoryActions(agentStore);
  const { agent } = actions;
  const library = useStoryLibrary(client, projectId);
  const flow = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const drop = useStoryDrop(canvasRef);
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

  // Cards and the inspector ask Research through the context; the ref keeps its value stable across renders.
  const runActionRef = useRef(actions.run);
  runActionRef.current = actions.run;
  const sources = useResearchServices().store;
  const sourcesView = useSourcesStore((state) => state.view);
  const findBlocker = agentBlocker(agent);
  const research = useMemo<StoryResearch>(() => {
    const byAsset = new Map((sourcesView?.records ?? []).map((record) => [record.asset, record]));
    return {
      blocker: findBlocker,
      find: (missing) => void runActionRef.current("resolve", missing ? { missing } : undefined),
      sourceOf: (asset) => (asset ? (byAsset.get(asset) ?? null) : null),
      showInSources: (asset) => {
        sources.getState().reveal(asset);
        useDockLayoutStore.getState().activatePanel("sources");
      },
    };
  }, [findBlocker, sourcesView, sources]);

  const planWithAi = async () => {
    const result = await agent.planWithAi();
    if (!result.ok) store.getState().setNotice(result.message);
    else useDockLayoutStore.getState().activatePanel("chat");
  };

  const fit = () => void flow.fitView({ padding: 0.12, maxZoom: 1, duration: 200 });
  const zoomBy = (change: { by: number } | { to: number }) => {
    const level = "to" in change ? change.to : flow.getZoom() * change.by;
    void flow.zoomTo(Math.min(2, Math.max(0.05, level)), { duration: 150 });
  };

  /** Tidy up: one undoable move of every card into the play-order layout, then the whole graph in view. */
  const tidy = () => {
    const current = store.getState().graph;
    if (!current) return;
    const positions = tidyLayout(current, (id) => flow.getNode(id)?.measured?.height ?? null);
    if (store.getState().commit((graph) => moveNodes(graph, positions))) {
      requestAnimationFrame(fit);
    }
  };

  /** A section in the strip: select its chapter and bring it to the middle of the canvas. */
  const openChapter = (chapter: string) => {
    store.getState().select({ nodes: [chapter], edges: [] });
    const node = flow.getNode(chapter);
    if (!node) return;
    const width = node.measured?.width ?? CARD.width;
    const height = node.measured?.height ?? CARD.height;
    void flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
      zoom: Math.max(flow.getZoom(), 0.6),
      duration: 200,
    });
  };

  /** Canvas keys (prototype): V/H tools, ⇧T tidy, = / - zoom, ⇧1 fit; Delete/Backspace deletes the selection. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Fields keep their keys; an open dialog owns its keys and the canvas behind it keeps its selection.
    if (event.altKey || event.metaKey || event.ctrlKey || isTextFieldTarget(event.target)) return;
    if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
    const key = event.key.toLowerCase();
    const canvasKey = (() => {
      if (event.shiftKey && key === "t") return tidy;
      if (event.shiftKey && (event.code === "Digit1" || key === "!")) return fit;
      if (event.shiftKey) return null;
      if (key === "v") return () => setTool("select");
      if (key === "h") return () => setTool("pan");
      if (key === "=" || key === "+") return () => zoomBy({ by: 1.25 });
      if (key === "-") return () => zoomBy({ by: 1 / 1.25 });
      return null;
    })();
    if (canvasKey && hasGraph && status === "ready") {
      event.preventDefault();
      canvasKey();
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
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
        className="flex h-full items-center justify-center gap-2 text-sm text-fg-3"
        role="status"
      >
        <Spinner />
        {t("story.panel.loading")}
      </div>
    );
  } else if (status === "error") {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-md font-semibold text-fg">{t("story.panel.loadFailed")}</p>
        {loadError && <p className="max-w-sm text-sm text-fg-3">{loadError}</p>}
        <Button size="sm" variant="secondary" onClick={() => void store.getState().reload()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  } else if (!hasGraph) {
    content = (
      <EmptyStory
        onStart={() => add({ kind: "chapter" })}
        onPlan={() => void planWithAi()}
        planBlocker={agentBlocker(agent)}
      />
    );
  } else {
    content = <StoryCanvas tool={tool} onRefused={refuse} />;
  }

  return (
    <StoryResearchProvider value={research}>
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
        {...drop.handlers}
        className="@container/story relative flex h-full min-h-0 flex-col bg-bg-0 text-fg outline-hidden"
      >
        <StoryToolbar
          library={library}
          agent={agent}
          tool={tool}
          onTool={setTool}
          onAdd={add}
          onTidy={tidy}
          onZoom={zoomBy}
          onFit={fit}
          onUndo={() => store.getState().undo()}
          onRedo={() => store.getState().redo()}
          onAction={actions.request}
          onRebuild={() => actions.openRebuild(null)}
          onFindMissing={() => research.find(null)}
        />
        <div className="flex min-h-0 flex-1">
          <div ref={canvasRef} className="relative min-w-0 flex-1 bg-stage">
            {content}
            {notice && (
              <div
                role="alert"
                className="absolute top-2.5 left-1/2 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-start gap-2 rounded-md border border-border bg-bg-1 py-1.5 pr-1.5 pl-3 text-sm text-fg shadow-pop"
              >
                <span className="min-w-0 pt-0.5">{notice}</span>
                <IconButton
                  aria-label={t("common.dismissMessage")}
                  size="xs"
                  icon={<X size={10} aria-hidden />}
                  onClick={() => store.getState().setNotice(null)}
                />
              </div>
            )}
            {agentBusy && (
              <div
                role="status"
                className="absolute bottom-3 left-1/2 z-20 flex h-head max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-md border border-border bg-menu-bg px-3 text-sm whitespace-nowrap text-fg-2 shadow-pop backdrop-blur-md"
              >
                <Spinner />
                <b className="font-semibold text-fg">{t("story.panel.busyTitle")}</b>
                <span className="truncate">{t("story.panel.busyBody")}</span>
              </div>
            )}
          </div>
          {hasGraph && status === "ready" && (
            <StoryInspector
              library={library}
              onRebuildSection={(chapter) => actions.openRebuild([chapter])}
            />
          )}
        </div>
        {hasGraph && status === "ready" && (
          <StorySectionStrip
            onOpenChapter={openChapter}
            onOpenEdit={() => useDockLayoutStore.getState().activatePanel("preview")}
          />
        )}
        {actions.dialog}
        {drop.overlay}
      </div>
    </StoryResearchProvider>
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
