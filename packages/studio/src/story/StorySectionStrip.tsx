import { CaretRight } from "@phosphor-icons/react";
import { isChapter, storyOrder, type ChapterNode } from "@hyperframes/agent-protocol";
import { Button, cn } from "../components/ui";
import { useTranslation } from "../i18n";
import { useStoryStore } from "./storyContext";
import { formatDuration } from "./storyFormat";
import { cardImage } from "./StoryNodeCard";
import { chapterBadges, rebuildTargets } from "./storySync";
import { SyncBadges } from "./SyncBadges";

/** Ruler step: the smallest round step that keeps the ruler to about eight labels, so a long story still reads. */
function rulerStep(total: number): number {
  const steps = [5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((step) => total / step <= 8) ?? 900;
}

/**
 * The bottom strip of the Story workspace (prototype "Timeline · Main Cut"): one section per chapter in play order,
 * as long as its planned duration, showing whether Build put it on the timeline and whether it changed since.
 * A section selects and centres its chapter; Open in Edit switches to the editor.
 */
export function StorySectionStrip({
  onOpenChapter,
  onOpenEdit,
}: {
  onOpenChapter: (chapter: string) => void;
  onOpenEdit: () => void;
}) {
  const { t } = useTranslation();
  const graph = useStoryStore((state) => state.graph);
  const facts = useStoryStore((state) => state.facts);
  const sync = useStoryStore((state) => state.sync);
  const selection = useStoryStore((state) => state.selection);
  const projectId = useStoryStore((state) => state.projectId ?? "");
  if (!graph) return null;

  const byId = new Map(graph.nodes.filter(isChapter).map((node) => [node.id, node]));
  const chapters = storyOrder(graph).chapters.flatMap((id) => {
    const chapter = byId.get(id);
    return chapter ? [chapter] : [];
  });
  const total = chapters.reduce((sum, chapter) => sum + chapter.estimatedDuration, 0);
  const step = rulerStep(total);
  const ticks: number[] = [];
  for (let at = 0; at < total; at += step) ticks.push(at);
  const changed = rebuildTargets(sync).length;
  const state = sync?.state ?? "not_built";
  const status =
    state === "out_of_sync"
      ? changed > 0
        ? t("story.strip.changed", { count: changed })
        : t("story.strip.editedOnTimeline")
      : state === "in_sync"
        ? t("story.strip.built")
        : state === "untracked"
          ? t("story.strip.untracked")
          : t("story.sync.badge.notBuilt");
  const selected = selection.nodes.length === 1 ? selection.nodes[0] : null;

  const section = (chapter: ChapterNode, index: number) => {
    const onTimeline = facts[chapter.id]?.timeline ?? null;
    const badges = chapterBadges(sync, chapter.id);
    const stale = badges.some((badge) => badge.kind !== "edited");
    const built = onTimeline !== null;
    const image = built ? cardImage(chapter, projectId) : null;
    return (
      <button
        key={chapter.id}
        type="button"
        onClick={() => onOpenChapter(chapter.id)}
        style={{ flex: `${Math.max(1, chapter.estimatedDuration)} 1 0` }}
        aria-label={t("story.strip.sectionAria", {
          number: String(index + 1).padStart(2, "0"),
          title: chapter.title,
          duration: formatDuration(chapter.estimatedDuration),
          state: built ? (stale ? "changed" : "built") : "notBuilt",
        })}
        aria-pressed={selected === chapter.id}
        data-story-section={chapter.id}
        className={cn(
          "hf-sg-ts relative grid min-w-0 grid-rows-[22px_minmax(0,1fr)] gap-[3px] overflow-hidden rounded-sm border pb-1 text-left outline-hidden",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent",
          selected === chapter.id
            ? "border-accent-line bg-accent-soft"
            : built
              ? "border-border-subtle bg-bg-1 hover:border-border"
              : "border-dashed border-border bg-transparent hover:bg-surface-1",
        )}
      >
        {stale && <span className="absolute inset-x-0 top-0 h-0.5 bg-warning" aria-hidden />}
        <span className="flex min-w-0 items-center gap-1.5 px-1.5 text-xs">
          <span className="font-mono text-num font-semibold text-fg">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className="hf-sg-ts-title min-w-0 flex-1 truncate font-medium text-fg-2">
            {chapter.title}
          </span>
          <span className="hf-sg-ts-badges flex shrink-0 gap-1 [&_[data-sync-badge]]:px-1">
            <SyncBadges badges={badges} />
          </span>
          <span className="hf-sg-ts-dur shrink-0 font-mono text-num text-fg-3">
            {formatDuration(chapter.estimatedDuration)}
          </span>
        </span>
        {built ? (
          <span className="mx-1 flex min-h-0 overflow-hidden rounded-xs bg-k-video-b shadow-[inset_0_0_0_1px_var(--color-k-video-l)]">
            {image && (
              <img
                src={image}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
                className="h-full w-full object-cover opacity-90"
              />
            )}
          </span>
        ) : (
          <span className="mx-1 flex min-h-0 items-center justify-center text-xs text-fg-disabled">
            {t("story.sync.badge.notBuilt")}
          </span>
        )}
      </button>
    );
  };

  return (
    <section
      aria-label={t("story.strip.label")}
      className="flex h-[136px] shrink-0 flex-col border-t border-border-subtle bg-bg-0"
    >
      <header className="flex h-head shrink-0 items-center gap-1 border-b border-border-subtle bg-bg-1 pr-1 pl-3 select-none">
        <span className="text-sm font-medium text-fg">{t("story.timeline.title")}</span>
        {graph.build && (
          <span className="truncate px-1 text-sm font-medium text-fg-2">
            {graph.build.composition}
          </span>
        )}
        <span className="truncate pl-1 font-mono text-num text-fg-3">
          {t("story.strip.summary", {
            duration: formatDuration(total),
            count: chapters.length,
            status,
          })}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onOpenEdit}>
          {t("story.strip.openEdit")}
          <CaretRight size={12} aria-hidden />
        </Button>
      </header>
      {chapters.length === 0 ? (
        <p className="flex flex-1 items-center justify-center text-xs text-fg-3">
          {t("story.strip.empty")}
        </p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[20px_minmax(0,1fr)] px-3 pb-2.5">
          <div className="relative font-mono text-2xs text-fg-3" aria-hidden>
            {ticks.map((at) => (
              <span
                key={at}
                className="absolute top-0 h-2 border-l border-border pl-1 leading-5"
                style={{ left: `${(at / Math.max(1, total)) * 100}%` }}
              >
                <span className="absolute top-1 left-1 whitespace-nowrap">
                  {formatDuration(at)}
                </span>
              </span>
            ))}
          </div>
          <div className="flex min-h-0 gap-0.5">{chapters.map(section)}</div>
        </div>
      )}
    </section>
  );
}
