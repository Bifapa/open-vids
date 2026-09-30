import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsClockwise,
  CornersOut,
  Hammer,
  Sparkle,
} from "@phosphor-icons/react";
import { isChapter, type StoryAction } from "@hyperframes/agent-protocol";
import { Button, IconButton, Tooltip } from "../components/ui";
import { AddNodePopover, type NewNodeRequest } from "./AddNodePopover";
import { useStoryStore } from "./storyContext";
import { formatAge, formatDuration } from "./storyFormat";
import type { StorySaveState } from "./storyStore";
import { rebuildTargets, syncBlocker } from "./storySync";
import { agentBlocker, type StoryAgent } from "./useStoryAgent";
import type { StoryLibrary } from "./useStoryLibrary";

const SAVE_LABELS: Record<StorySaveState, string> = {
  saved: "Saved",
  pending: "Unsaved",
  saving: "Saving…",
  failed: "Not saved",
};

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

/** Why Review/Build cannot run now, or null when they can. */
function actionBlocker(action: StoryAction, agent: StoryAgent, chapters: number): string | null {
  const busy = agentBlocker(agent);
  if (busy) return busy;
  if (chapters === 0) return action === "build" ? "Add a chapter first" : "Nothing to review yet";
  return null;
}

export function StoryToolbar({
  library,
  agent,
  onAdd,
  onFit,
  onUndo,
  onRedo,
  onAction,
  onRebuild,
}: {
  library: StoryLibrary;
  agent: StoryAgent;
  onAdd: (request: NewNodeRequest) => void;
  onFit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onAction: (action: StoryAction) => void;
  /** Opens the impact of Rebuild affected. */
  onRebuild: () => void;
}) {
  const graph = useStoryStore((state) => state.graph);
  const canUndo = useStoryStore((state) => state.past.length > 0 && !state.agentBusy);
  const canRedo = useStoryStore((state) => state.future.length > 0 && !state.agentBusy);
  const readOnly = useStoryStore((state) => state.agentBusy);
  const saveState = useStoryStore((state) => state.saveState);
  const sync = useStoryStore((state) => state.sync);
  const chapters = graph?.nodes.filter(isChapter).length ?? 0;
  const reviewBlocker = actionBlocker("review", agent, chapters);
  const buildBlocker = actionBlocker("build", agent, chapters);
  const rebuildCount = rebuildTargets(sync).length;
  const rebuildBlocker = syncBlocker(sync) ?? agentBlocker(agent);
  const now = Date.now();

  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-bg-1 px-2">
      <AddNodePopover library={library} disabled={readOnly} onAdd={onAdd} />
      <div className="mx-1 h-4 w-px bg-border-strong" aria-hidden />
      <Tooltip label={`Undo story edit (${MOD}Z)`} side="bottom">
        <IconButton
          aria-label="Undo story edit"
          size="sm"
          disabled={!canUndo}
          icon={<ArrowCounterClockwise size={13} aria-hidden />}
          onClick={onUndo}
        />
      </Tooltip>
      <Tooltip label={`Redo story edit (${MOD}${isMac ? "⇧Z" : "Shift+Z"})`} side="bottom">
        <IconButton
          aria-label="Redo story edit"
          size="sm"
          disabled={!canRedo}
          icon={<ArrowClockwise size={13} aria-hidden />}
          onClick={onRedo}
        />
      </Tooltip>
      <Tooltip label="Fit the story in view" side="bottom">
        <IconButton
          aria-label="Fit view"
          size="sm"
          icon={<CornersOut size={13} aria-hidden />}
          onClick={onFit}
        />
      </Tooltip>
      {graph && (
        <span
          className={
            saveState === "failed"
              ? "ml-1 text-step-10 text-danger"
              : "ml-1 text-step-10 text-text-4"
          }
          role="status"
        >
          {SAVE_LABELS[saveState]}
        </span>
      )}
      <div className="min-w-0 flex-1" />
      {graph?.review && (
        <Tooltip label={graph.review.summary.slice(0, 160) || "Reviewed"} side="bottom">
          <span className="hidden truncate text-step-10 text-text-3 min-[1200px]:inline">
            Reviewed {formatAge(graph.review.at, now)}
          </span>
        </Tooltip>
      )}
      {graph?.build && (
        <span className="hidden truncate text-step-10 text-text-3 min-[1200px]:inline">
          · Built {formatAge(graph.build.at, now)} ({formatDuration(graph.build.duration)})
        </span>
      )}
      <Tooltip
        label={
          reviewBlocker ??
          "The agent adapts its plan to your changes; locked nodes stay as they are"
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
          Review with AI
        </Button>
      </Tooltip>
      <Tooltip
        label={
          rebuildBlocker ??
          `Regenerate only the ${rebuildCount === 1 ? "section" : `${rebuildCount} sections`} the story changed; the rest of the timeline stays`
        }
        side="bottom"
      >
        <Button
          size="sm"
          variant="secondary"
          disabled={rebuildBlocker !== null}
          icon={<ArrowsClockwise size={12} aria-hidden />}
          onClick={onRebuild}
          data-story-action="rebuild"
        >
          Rebuild affected
          {sync?.state === "out_of_sync" && rebuildCount > 0 && (
            <span className="ml-1 rounded-sm bg-container/20 px-1 text-step-10 font-semibold tabular-nums text-container">
              {rebuildCount}
            </span>
          )}
        </Button>
      </Tooltip>
      <Tooltip
        label={buildBlocker ?? "Compile the story into the timeline (one revertable turn)"}
        side="bottom"
      >
        <Button
          size="sm"
          variant="primary"
          disabled={buildBlocker !== null}
          icon={<Hammer size={12} aria-hidden />}
          onClick={() => onAction("build")}
        >
          Build Story
        </Button>
      </Tooltip>
    </div>
  );
}
