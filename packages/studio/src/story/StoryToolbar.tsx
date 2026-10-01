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
import { formatPercent, t as translate, useTranslation, type TranslationKey } from "../i18n";
import { useStoryStore } from "./storyContext";
import { formatAge, formatDuration } from "./storyFormat";
import type { StorySaveState } from "./storyStore";
import { rebuildTargets, syncBlocker } from "./storySync";
import { agentBlocker, researchBlocker, type StoryAgent } from "./useStoryAgent";
import { unlockedMissing } from "./storyResearch";
import type { StoryLibrary } from "./useStoryLibrary";

/** The canvas tool: Select drags cards and connects ports; Pan drags the whole canvas from anywhere. */
export type StoryTool = "select" | "pan";

const SAVE_STATES = {
  saved: { label: "story.save.saved", dot: "ok" },
  pending: { label: "story.save.pending", dot: "warn" },
  saving: { label: "story.save.saving", dot: "running" },
  failed: { label: "story.save.failed", dot: "error" },
} as const satisfies Record<
  StorySaveState,
  { label: TranslationKey; dot: "ok" | "running" | "warn" | "error" }
>;

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5] as const;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

/** Why Review/Build cannot run now, or null when they can. */
function actionBlocker(action: StoryAction, agent: StoryAgent, chapters: number): string | null {
  const busy = agentBlocker(agent);
  if (busy) return busy;
  if (chapters === 0) {
    return action === "build"
      ? translate("story.toolbar.addChapterFirst")
      : translate("story.toolbar.nothingToReview");
  }
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
  const { t } = useTranslation();
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
    researchBlocker(agent) ?? (missingCount === 0 ? t("story.toolbar.needMissing") : null);
  const now = Date.now();
  const save = SAVE_STATES[saveState];
  const reviewed = graph?.review
    ? ` · ${t("story.toolbar.reviewed", { age: formatAge(graph.review.at, now) })}`
    : "";
  const built = graph?.build
    ? ` · ${t("story.toolbar.builtAt", {
        age: formatAge(graph.build.at, now),
        duration: formatDuration(graph.build.duration),
      })}`
    : "";

  return (
    <div
      className="flex h-head min-w-0 shrink-0 items-center gap-1 overflow-hidden border-b border-border-subtle bg-bg-1 pl-3 pr-1 select-none"
      role="toolbar"
      aria-label={t("story.toolbar.label")}
    >
      <span className="shrink-0 text-sm font-medium text-fg @max-[720px]/story:hidden">
        {t("story.toolbar.title")}
      </span>
      <span className="contents @max-[720px]/story:hidden">
        <Separator />
      </span>
      <SegmentedControl<StoryTool>
        label={t("story.toolbar.canvasTool")}
        variant="icon"
        size="sm"
        value={tool}
        onChange={onTool}
        options={[
          {
            value: "select",
            label: t("story.toolbar.select"),
            title: t("story.toolbar.selectTitle", { key: "V" }),
            icon: <Cursor size={12} />,
          },
          {
            value: "pan",
            label: t("story.toolbar.pan"),
            title: t("story.toolbar.panTitle", { key: "H" }),
            icon: <Hand size={12} />,
          },
        ]}
      />
      <AddNodePopover library={library} disabled={readOnly} onAdd={onAdd} />
      <Tooltip label={t("story.toolbar.tidy")} shortcut="⇧T" side="bottom">
        <IconButton
          aria-label={t("story.toolbar.tidy")}
          size="sm"
          disabled={readOnly || graph === null || graph.nodes.length === 0}
          icon={<SquaresFour size={14} aria-hidden />}
          onClick={onTidy}
        />
      </Tooltip>
      <div
        className="ml-1 flex items-center gap-px"
        role="group"
        aria-label={t("story.toolbar.zoomGroup")}
      >
        <Tooltip label={t("story.toolbar.zoomOut")} shortcut="-" side="bottom">
          <IconButton
            aria-label={t("story.toolbar.zoomOut")}
            size="sm"
            icon={<MagnifyingGlassMinus size={14} aria-hidden />}
            onClick={() => onZoom({ by: 1 / 1.25 })}
          />
        </Tooltip>
        <Menu
          trigger={
            <button
              type="button"
              aria-label={t("story.toolbar.zoomLevel")}
              className="inline-flex h-ctl-sm min-w-[46px] items-center justify-center rounded-sm px-1.5 font-mono text-num text-fg-2 outline-hidden hover:bg-surface-2 hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent data-[popup-open]:bg-surface-2"
            >
              {formatPercent(zoom)}
            </button>
          }
        >
          {ZOOM_STEPS.map((step) => (
            <MenuItem key={step} onClick={() => onZoom({ to: step })}>
              {formatPercent(step)}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem shortcut="⇧1" onClick={onFit}>
            {t("story.toolbar.fitGraph")}
          </MenuItem>
        </Menu>
        <Tooltip label={t("story.toolbar.zoomIn")} shortcut="=" side="bottom">
          <IconButton
            aria-label={t("story.toolbar.zoomIn")}
            size="sm"
            icon={<MagnifyingGlassPlus size={14} aria-hidden />}
            onClick={() => onZoom({ by: 1.25 })}
          />
        </Tooltip>
        <Tooltip label={t("story.toolbar.fitGraphTip")} shortcut="⇧1" side="bottom">
          <IconButton
            aria-label={t("story.toolbar.fitView")}
            size="sm"
            icon={<CornersOut size={14} aria-hidden />}
            onClick={onFit}
          />
        </Tooltip>
      </div>
      <Separator />
      <Tooltip label={t("story.toolbar.undo")} shortcut={`${MOD}Z`} side="bottom">
        <IconButton
          aria-label={t("story.toolbar.undo")}
          size="sm"
          disabled={!canUndo}
          icon={<ArrowCounterClockwise size={14} aria-hidden />}
          onClick={onUndo}
        />
      </Tooltip>
      <Tooltip
        label={t("story.toolbar.redo")}
        shortcut={isMac ? "⇧⌘Z" : "Ctrl+Shift+Z"}
        side="bottom"
      >
        <IconButton
          aria-label={t("story.toolbar.redo")}
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
          <span className="@max-[980px]/story:sr-only">{t(save.label)}</span>
        </span>
      )}
      <div className="min-w-0 flex-1" />
      <div className="flex shrink-0 items-center gap-1.5 pr-0.5">
        <Tooltip
          label={findBlocker ?? t("story.toolbar.findTip", { count: missingCount })}
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
            <span className="@max-[1180px]/story:sr-only">{t("story.toolbar.findMissing")}</span>
            {missingCount > 0 && <Pill tone="warning">{missingCount}</Pill>}
          </Button>
        </Tooltip>
        <Tooltip label={(reviewBlocker ?? t("story.toolbar.reviewTip")) + reviewed} side="bottom">
          <Button
            size="sm"
            variant="secondary"
            disabled={reviewBlocker !== null}
            icon={<Sparkle size={12} aria-hidden />}
            onClick={() => onAction("review")}
          >
            <span className="@max-[880px]/story:sr-only">{t("story.toolbar.review")}</span>
          </Button>
        </Tooltip>
        {sync?.state === "in_sync" && (
          <Badge tone="success" title={t("story.toolbar.builtBadgeTip")} data-story-built="">
            <Check size={11} weight="bold" aria-hidden />
            {t("story.strip.built")}
          </Badge>
        )}
        <Tooltip
          label={rebuildBlocker ?? t("story.toolbar.rebuildTip", { count: rebuildCount })}
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
            <span className="@max-[880px]/story:sr-only">{t("story.toolbar.rebuild")}</span>
            {outOfSync && <span className="tabular-nums">{rebuildCount}</span>}
          </Button>
        </Tooltip>
        <Tooltip label={(buildBlocker ?? t("story.toolbar.buildTip")) + built} side="bottom">
          <Button
            size="sm"
            variant={outOfSync || sync?.state === "in_sync" ? "secondary" : "primary"}
            disabled={buildBlocker !== null}
            icon={<Hammer size={12} aria-hidden />}
            onClick={() => onAction("build")}
          >
            <span className="@max-[640px]/story:sr-only">{t("story.toolbar.build")}</span>
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
