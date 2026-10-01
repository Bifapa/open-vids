import { ArrowsClockwise, Check } from "@phosphor-icons/react";
import type { StoryNodeFacts, StorySyncReport } from "@hyperframes/agent-protocol";
import { Badge, Button, Tooltip } from "../components/ui";
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
  const onTimeline = facts?.timeline ?? null;
  const placed = onTimeline && (
    <Field label="On timeline">
      <span className="px-0.5 font-mono text-sm text-fg">
        {formatDuration(onTimeline.start)} – {formatDuration(onTimeline.end)}
        <span className="font-ui text-xs text-fg-3"> · {onTimeline.clips} clips</span>
      </span>
    </Field>
  );
  const section = sectionOf(report, chapter);

  let status;
  let body = null;
  if (!report || report.state === "not_built") {
    status = <Badge>Not built</Badge>;
    body = <HintNote icon={ArrowsClockwise}>Build Story puts it on the timeline.</HintNote>;
  } else if (report.state === "untracked") {
    status = <Badge>Untracked</Badge>;
    body = (
      <HintNote icon={ArrowsClockwise}>
        Built before sync tracking: Build Story takes the timeline over.
      </HintNote>
    );
  } else if (!section) {
    status = <Badge>Not on the timeline</Badge>;
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
          In sync
        </Badge>
      );
    } else {
      status = <SyncBadges badges={badges} />;
      const blocker = readOnly
        ? "The agent is working"
        : needsRebuild
          ? null
          : "Only edited on the timeline: nothing to rebuild";
      body = (
        <>
          {(section.moved || section.change !== "unchanged") && (
            <Field label="Moves to">
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
              className="w-full"
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
      <Field label="Status">
        <span className="flex min-w-0 flex-wrap items-center gap-1">{status}</span>
      </Field>
      {placed}
      {body}
    </Section>
  );
}
