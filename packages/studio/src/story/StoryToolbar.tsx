import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsClockwise,
  Check,
  CornersOut,
  Cursor,
  Hammer,
  Hand,
  MagnifyingGlass,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  SquaresFour,
  Sparkle,
} from "@phosphor-icons/react";
import { useViewport } from "@xyflow/react";
import { isChapter, type StoryAction } from "@hyperframes/agent-protocol";
import {
  Badge,
  Button,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Pill,
  SegmentedControl,
  StatusDot,
  Tooltip,
  cn,
} from "../components/ui";
import { AddNodePopover, type NewNodeRequest } from "./AddNodePopover";
import { useStoryStore } from "./storyContext";
import { formatAge, formatDuration } from "./storyFormat";
import type { StorySaveState } from "./storyStore";
import { rebuildTargets, syncBlocker } from "./storySync";
import { agentBlocker, researchBlocker, type StoryAgent } from "./useStoryAgent";
import { unlockedMissing } from "./storyResearch";
import type { StoryLibrary } from "./useStoryLibrary";

/** The canvas tool: Select drags cards and connects ports; Pan drags the whole canvas from anywhere. */
export type StoryTool = "select" | "pan";

const SAVE_STATES: Record<
  StorySaveState,
  { label: string; dot: "ok" | "running" | "warn" | "error" }
> = {
  saved: { label: "Saved", dot: "ok" },
  pending: { label: "Unsaved", dot: "warn" },
  saving: { label: "Saving…", dot: "running" },
  failed: { label: "Not saved", dot: "error" },
};

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5] as const;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

/** Why Review/Build cannot run now, or null when they can. */
function actionBlocker(action: StoryAction, agent: StoryAgent, chapters: number): string | null {
  const busy = agentBlocker(agent);
  if (busy) return busy;
  if (chapters === 0) return action === "build" ? "Add a chapter first" : "Nothing to review yet";
  return null;
}

/** A hairline between head groups. */
function Separator() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />;
}

export function StoryToolbar({
  library,
  agent,
  tool,
  onTool,
  onAdd,
  onTidy,
  onZoom,
  onFit,
  onUndo,
  onRedo,
  onAction,
  onRebuild,
  onFindMissing,
}: {
  library: StoryLibrary;
  agent: StoryAgent;
  tool: StoryTool;
  onTool: (tool: StoryTool) => void;
  onAdd: (request: NewNodeRequest) => void;
  /** Lays the graph out again (one undoable move). */
  onTidy: () => void;
  /** Zooms around the canvas centre: a factor (`in`/`out`) or an absolute level. */
  onZoom: (zoom: { by: number } | { to: number }) => void;
  onFit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onAction: (action: StoryAction) => void;
  /** Opens the impact of Rebuild affected. */
  onRebuild: () => void;
  /** Starts a resolve turn for every unlocked Missing Asset node. */
  onFindMissing: () => void;
}) {
  const graph = useStoryStore((state) => state.graph);
  const canUndo = useStoryStore((state) => state.past.length > 0 && !state.agentBusy);
  const canRedo = useStoryStore((state) => state.future.length > 0 && !state.agentBusy);
  const readOnly = useStoryStore((state) => state.agentBusy);
  const saveState = useStoryStore((state) => state.saveState);
  const sync = useStoryStore((state) => state.sync);
  const { zoom } = useViewport();
  const chapters = graph?.nodes.filter(isChapter).length ?? 0;
  const reviewBlocker = actionBlocker("review", agent, chapters);
  const buildBlocker = actionBlocker("build", agent, chapters);
  const rebuildCount = rebuildTargets(sync).length;
  const outOfSync = sync?.state === "out_of_sync" && rebuildCount > 0;
  const rebuildBlocker = syncBlocker(sync) ?? agentBlocker(agent);
  const missingCount = unlockedMissing(graph).length;
  const findBlocker =
    researchBlocker(agent) ??
    (missingCount === 0 ? "No missing material: nothing is waiting for an asset" : null);
  const now = Date.now();
  const save = SAVE_STATES[saveState];
  const reviewed = graph?.review ? ` · Reviewed ${formatAge(graph.review.at, now)}` : "";
  const built = graph?.build
    ? ` · Built ${formatAge(graph.build.at, now)} (${formatDuration(graph.build.duration)})`
    : "";

  return (
    <div
      className="flex h-head min-w-0 shrink-0 items-center gap-1 overflow-hidden border-b border-border-subtle bg-bg-1 pl-3 pr-1 select-none"
      role="toolbar"
      aria-label="Story toolbar"
    >
      <span className="shrink-0 text-sm font-medium text-fg @max-[720px]/story:hidden">
        Story Graph
      </span>
      <span className="contents @max-[720px]/story:hidden">
        <Separator />
      </span>
      <SegmentedControl<StoryTool>
        label="Canvas tool"
        variant="icon"
        size="sm"
        value={tool}
        onChange={onTool}
        options={[
          { value: "select", label: "Select", title: "Select (V)", icon: <Cursor size={12} /> },
          { value: "pan", label: "Pan", title: "Pan (H)", icon: <Hand size={12} /> },
        ]}
      />
      <AddNodePopover library={library} disabled={readOnly} onAdd={onAdd} />
      <Tooltip label="Tidy up" shortcut="⇧T" side="bottom">
        <IconButton
          aria-label="Tidy up"
          size="sm"
          disabled={readOnly || graph === null || graph.nodes.length === 0}
          icon={<SquaresFour size={14} aria-hidden />}
          onClick={onTidy}
        />
      </Tooltip>
      <div className="ml-1 flex items-center gap-px" role="group" aria-label="Canvas zoom">
        <Tooltip label="Zoom out" shortcut="-" side="bottom">
          <IconButton
            aria-label="Zoom out"
            size="sm"
            icon={<MagnifyingGlassMinus size={14} aria-hidden />}
            onClick={() => onZoom({ by: 1 / 1.25 })}
          />
        </Tooltip>
        <Menu
          trigger={
            <button
              type="button"
              aria-label="Zoom level"
              className="inline-flex h-ctl-sm min-w-[46px] items-center justify-center rounded-sm px-1.5 font-mono text-num text-fg-2 outline-hidden hover:bg-surface-2 hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent data-[popup-open]:bg-surface-2"
            >
              {Math.round(zoom * 100)}%
            </button>
          }
        >
          {ZOOM_STEPS.map((step) => (
            <MenuItem key={step} onClick={() => onZoom({ to: step })}>
              {Math.round(step * 100)}%
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem shortcut="⇧1" onClick={onFit}>
            Fit Graph
          </MenuItem>
        </Menu>
        <Tooltip label="Zoom in" shortcut="=" side="bottom">
          <IconButton
            aria-label="Zoom in"
            size="sm"
            icon={<MagnifyingGlassPlus size={14} aria-hidden />}
            onClick={() => onZoom({ by: 1.25 })}
          />
        </Tooltip>
        <Tooltip label="Fit graph" shortcut="⇧1" side="bottom">
          <IconButton
            aria-label="Fit view"
            size="sm"
            icon={<CornersOut size={14} aria-hidden />}
            onClick={onFit}
          />
        </Tooltip>
      </div>
      <Separator />
      <Tooltip label="Undo story edit" shortcut={`${MOD}Z`} side="bottom">
        <IconButton
          aria-label="Undo story edit"
          size="sm"
          disabled={!canUndo}
          icon={<ArrowCounterClockwise size={14} aria-hidden />}
          onClick={onUndo}
        />
      </Tooltip>
      <Tooltip label="Redo story edit" shortcut={isMac ? "⇧⌘Z" : "Ctrl+Shift+Z"} side="bottom">
        <IconButton
          aria-label="Redo story edit"
          size="sm"
          disabled={!canRedo}
          icon={<ArrowClockwise size={14} aria-hidden />}
          onClick={onRedo}
        />
      </Tooltip>
      {graph && (
        <span
          className={cn(
            "ml-1 flex shrink-0 items-center gap-1.5 text-xs",
            saveState === "failed" ? "text-error" : "text-fg-3",
          )}
          role="status"
        >
          <StatusDot tone={save.dot} />
          <span className="@max-[980px]/story:sr-only">{save.label}</span>
        </span>
      )}
      <div className="min-w-0 flex-1" />
      <div className="flex shrink-0 items-center gap-1.5 pr-0.5">
        <Tooltip
          label={
            findBlocker ??
            `Research looks for the material of ${missingCount === 1 ? "the missing asset" : `all ${missingCount} missing assets`} within your Asset Search policy (one revertable turn)`
          }
          side="bottom"
        >
          <Button
            size="sm"
            variant="ghost"
            disabled={findBlocker !== null}
            icon={<MagnifyingGlass size={12} aria-hidden />}
            onClick={onFindMissing}
            data-story-action="resolve"
          >
            <span className="@max-[1180px]/story:sr-only">Find missing material</span>
            {missingCount > 0 && <Pill tone="warning">{missingCount}</Pill>}
          </Button>
        </Tooltip>
        <Tooltip
          label={
            (reviewBlocker ??
              "The agent adapts its plan to your changes; locked nodes stay as they are") + reviewed
          }
          side="bottom"
        >
          <Button
            size="sm"
            variant="secondary"
            disabled={reviewBlocker !== null}
            icon={<Sparkle size={12} aria-hidden />}
            onClick={() => onAction("review")}
          >
            <span className="@max-[880px]/story:sr-only">Review with AI</span>
          </Button>
        </Tooltip>
        {sync?.state === "in_sync" && (
          <Badge tone="success" title="The timeline matches the story" data-story-built="">
            <Check size={11} weight="bold" aria-hidden />
            Built
          </Badge>
        )}
        <Tooltip
          label={
            rebuildBlocker ??
            `Regenerate only the ${rebuildCount === 1 ? "section" : `${rebuildCount} sections`} the story changed; the rest of the timeline stays`
          }
          side="bottom"
        >
          <Button
            size="sm"
            variant={outOfSync ? "primary" : "ghost"}
            disabled={rebuildBlocker !== null}
            icon={<ArrowsClockwise size={12} aria-hidden />}
            onClick={onRebuild}
            aria-haspopup="dialog"
            data-story-action="rebuild"
          >
            <span className="@max-[880px]/story:sr-only">Rebuild affected</span>
            {outOfSync && <span className="tabular-nums">{rebuildCount}</span>}
          </Button>
        </Tooltip>
        <Tooltip
          label={
            (buildBlocker ?? "Compile the story into the timeline (one revertable turn)") + built
          }
          side="bottom"
        >
          <Button
            size="sm"
            variant={outOfSync || sync?.state === "in_sync" ? "secondary" : "primary"}
            disabled={buildBlocker !== null}
            icon={<Hammer size={12} aria-hidden />}
            onClick={() => onAction("build")}
          >
            <span className="@max-[640px]/story:sr-only">Build Story</span>
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
