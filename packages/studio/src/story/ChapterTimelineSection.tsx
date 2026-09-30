import { ArrowsClockwise, CheckCircle } from "@phosphor-icons/react";
import type { StoryNodeFacts, StorySyncReport } from "@hyperframes/agent-protocol";
import { Button, Tooltip } from "../components/ui";
import { Section } from "./inspectorFields";
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
  const onTimeline = facts?.timeline ?? null;
  const placed = onTimeline && (
    <p className="text-step-10 text-accent">
      On the timeline {formatDuration(onTimeline.start)}–{formatDuration(onTimeline.end)} ·{" "}
      {onTimeline.clips} clips
    </p>
  );
  const section = sectionOf(report, chapter);

  let body;
  if (!report || report.state === "not_built") {
    body = (
      <p className="text-step-10 text-text-3">
        Not built yet: Build Story puts it on the timeline.
      </p>
    );
  } else if (report.state === "untracked") {
    body = (
      <p className="text-step-10 text-text-3">
        Built before sync tracking: Build Story takes the timeline over.
      </p>
    );
  } else if (!section) {
    body = <p className="text-step-10 text-text-3">Not on the timeline.</p>;
  } else {
    const badges = chapterBadges(report, chapter);
    const edits = sectionEdits(section);
    const needsRebuild =
      report.affected.includes(chapter) ||
      report.moved.includes(chapter) ||
      report.lockedPending.includes(chapter);
    if (badges.length === 0) {
      body = (
        <p className="flex items-center gap-1 text-step-10 text-text-2">
          <CheckCircle size={11} weight="fill" className="text-accent" aria-hidden />
          In sync with the timeline
        </p>
      );
    } else {
      const blocker = readOnly
        ? "The agent is working"
        : needsRebuild
          ? null
          : "Only edited on the timeline: nothing to rebuild";
      body = (
        <>
          <SyncBadges badges={badges} />
          {(section.moved || section.change !== "unchanged") && (
            <p className="text-step-10 tabular-nums text-text-2">
              {formatSpan(section.current)} → {formatSpan(section.next)}
            </p>
          )}
          {section.reasons.length > 0 && (
            <ul className="flex list-disc flex-col gap-0.5 pl-4 text-step-10 text-text-3">
              {section.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {edits.length > 0 && (
            <EditRows edits={edits.map((edit) => ({ edit, where: section.title }))} />
          )}
          <Tooltip
            label={
              blocker ??
              "Regenerate only this section's changed parts; you choose what happens to your edits"
            }
            side="left"
          >
            <Button
              size="sm"
              variant="secondary"
              disabled={blocker !== null}
              icon={<ArrowsClockwise size={12} aria-hidden />}
              onClick={() => onRebuild(chapter)}
              className="self-start"
            >
              Rebuild this section
            </Button>
          </Tooltip>
        </>
      );
    }
  }

  return (
    <Section title="Timeline">
      {placed}
      {body}
    </Section>
  );
}
