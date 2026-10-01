import { ArrowsClockwise, Check } from "@phosphor-icons/react";
import type { StoryNodeFacts, StorySyncReport } from "@hyperframes/agent-protocol";
import { Badge, Button, Tooltip } from "../components/ui";
import { useTranslation } from "../i18n";
import { Field, HintNote, Section } from "./inspectorFields";
import { EditRows } from "./StoryDialog";
import { formatDuration } from "./storyFormat";
import { chapterBadges, formatSpan, sectionEdits, sectionOf } from "./storySync";
import { SyncBadges } from "./SyncBadges";

/**
 * The selected chapter's place on the timeline: in sync, or what changed since the build, which of its generated
 * clips were edited afterwards, and a rebuild of just this section.
 */
export function ChapterTimelineSection({
  chapter,
  report,
  facts,
  readOnly,
  onRebuild,
}: {
  chapter: string;
  report: StorySyncReport | null;
  facts: StoryNodeFacts | undefined;
  readOnly: boolean;
  onRebuild: (chapter: string) => void;
}) {
  const { t } = useTranslation();
  const onTimeline = facts?.timeline ?? null;
  const placed = onTimeline && (
    <Field label={t("story.timeline.onTimeline")}>
      <span className="px-0.5 font-mono text-sm text-fg">
        {formatDuration(onTimeline.start)} – {formatDuration(onTimeline.end)}
        <span className="font-ui text-xs text-fg-3">
          {" "}
          · {t("story.timeline.clips", { count: onTimeline.clips })}
        </span>
      </span>
    </Field>
  );
  const section = sectionOf(report, chapter);

  let status;
  let body = null;
  if (!report || report.state === "not_built") {
    status = <Badge>{t("story.sync.badge.notBuilt")}</Badge>;
    body = <HintNote icon={ArrowsClockwise}>{t("story.timeline.notBuiltHint")}</HintNote>;
  } else if (report.state === "untracked") {
    status = <Badge>{t("story.timeline.untracked")}</Badge>;
    body = <HintNote icon={ArrowsClockwise}>{t("story.timeline.untrackedHint")}</HintNote>;
  } else if (!section) {
    status = <Badge>{t("story.timeline.notOnTimeline")}</Badge>;
  } else {
    const badges = chapterBadges(report, chapter);
    const edits = sectionEdits(section);
    const needsRebuild =
      report.affected.includes(chapter) ||
      report.moved.includes(chapter) ||
      report.lockedPending.includes(chapter);
    if (badges.length === 0) {
      status = (
        <Badge tone="success">
          <Check size={11} weight="bold" aria-hidden />
          {t("story.sync.change.unchanged")}
        </Badge>
      );
    } else {
      status = <SyncBadges badges={badges} />;
      const blocker = readOnly
        ? t("story.agent.working")
        : needsRebuild
          ? null
          : t("story.timeline.nothingToRebuild");
      body = (
        <>
          {(section.moved || section.change !== "unchanged") && (
            <Field label={t("story.timeline.movesTo")}>
              <span className="px-0.5 font-mono text-sm text-fg-2">
                {formatSpan(section.current)} → {formatSpan(section.next)}
              </span>
            </Field>
          )}
          {section.reasons.map((reason) => (
            <HintNote key={reason} icon={ArrowsClockwise} tone="warning">
              {reason}
            </HintNote>
          ))}
          {edits.length > 0 && (
            <EditRows edits={edits.map((edit) => ({ edit, where: section.title }))} />
          )}
          <Tooltip label={blocker ?? t("story.timeline.rebuildTip")} side="left">
            <Button
              size="sm"
              variant="secondary"
              disabled={blocker !== null}
              icon={<ArrowsClockwise size={12} aria-hidden />}
              onClick={() => onRebuild(chapter)}
              className="w-full"
            >
              {t("story.timeline.rebuildSection")}
            </Button>
          </Tooltip>
        </>
      );
    }
  }

  return (
    <Section title={t("story.timeline.title")}>
      <Field label={t("story.field.status")}>
        <span className="flex min-w-0 flex-wrap items-center gap-1">{status}</span>
      </Field>
      {placed}
      {body}
    </Section>
  );
}
