import { useId, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import type {
  ManualEditPolicy,
  StoryActionOptions,
  StorySyncAction,
  StorySyncReport,
  StorySyncSection,
  StorySyncUnit,
} from "@hyperframes/agent-protocol";
import { Button, cn } from "../components/ui";
import { formatDuration } from "./storyFormat";
import { Callout, ChoiceRow, DialogGroup, EditRows, StoryDialog } from "./StoryDialog";
import {
  SYNC_ACTION_LABELS,
  SYNC_ROLE_LABELS,
  chapterBadges,
  conflictingEdits,
  formatSpan,
  lockedChoices,
  plannedAction,
  plannedSections,
  rebuildOptions,
  type RebuildChoice,
  type SyncBadge,
} from "./storySync";
import { SyncBadges } from "./SyncBadges";

const ACTION_TONES: Record<StorySyncAction, string> = {
  rebuild: "text-container",
  add: "text-container",
  remove: "text-danger",
  keep_edited: "text-selection",
  keep_locked: "text-text-2",
  shift: "text-text-2",
  keep: "text-text-4",
  skip: "text-text-4",
};

/** How many unrelated clips the dialog names before it only counts them. */
const UNRELATED_SHOWN = 3;

function sectionBadges(report: StorySyncReport, section: StorySyncSection): SyncBadge[] {
  if (section.change !== "removed") return chapterBadges(report, section.chapter);
  return [
    {
      kind: "changed",
      label: "Leaves the story",
      detail: "The chapter is no longer in the story: its section comes off the timeline",
    },
  ];
}

function UnitRow({ unit, action }: { unit: StorySyncUnit; action: StorySyncAction }) {
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 text-step-10">
        <span className="w-14 shrink-0 text-text-3">{SYNC_ROLE_LABELS[unit.role]}</span>
        <span className="min-w-0 flex-1 truncate text-text-1" title={unit.reasons.join("; ")}>
          {unit.title}
        </span>
        <span
          className={cn("shrink-0 font-medium", ACTION_TONES[action])}
          data-unit-action={action}
        >
          {SYNC_ACTION_LABELS[action]}
        </span>
      </div>
      {unit.edits.length > 0 && (
        <div className="pl-16">
          <EditRows edits={unit.edits.map((edit) => ({ edit, where: unit.title }))} />
        </div>
      )}
    </li>
  );
}

function SectionPlan({
  report,
  section,
  choice,
}: {
  report: StorySyncReport;
  section: StorySyncSection;
  choice: RebuildChoice;
}) {
  const planned = section.units.map((unit) => ({
    unit,
    action: plannedAction(unit, section, choice),
  }));
  const worthListing = planned.filter(
    ({ unit, action }) => action !== "keep" || unit.edits.length > 0 || unit.change !== "unchanged",
  );
  const onlyMoves = worthListing.every(
    ({ unit, action }) => action === "shift" && unit.edits.length === 0,
  );
  return (
    <li
      className="flex flex-col gap-1 rounded-md border border-border bg-bg-1 px-2.5 py-2"
      data-sync-section={section.chapter}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-step-11 font-semibold text-text-0">
          {section.title}
        </span>
        <SyncBadges badges={sectionBadges(report, section)} />
        <span className="shrink-0 text-step-10 tabular-nums text-text-3">
          {formatSpan(section.current)} → {formatSpan(section.next)}
        </span>
      </div>
      {section.reasons.length > 0 && (
        <p className="text-step-10 text-text-3">{section.reasons.join(" · ")}</p>
      )}
      {onlyMoves ? (
        <p className="text-step-10 text-text-3">Moves as a whole; its clips stay as they are.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {worthListing.map(({ unit, action }) => (
            <UnitRow key={`${unit.role}-${unit.node}`} unit={unit} action={action} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Rebuild affected sections: what the rebuild does to each section (and to music, captions and clips no section
 * owns) with the user's choices — keep or replace manual edits, which locked chapters may change. `chapters`
 * narrows it to those sections (the inspector's "Rebuild this section"); order and removals still apply.
 */
export function RebuildDialog({
  report,
  chapters,
  blocker,
  onClose,
  onStart,
}: {
  report: StorySyncReport;
  chapters: readonly string[] | null;
  /** Why the agent cannot start it now. */
  blocker: string | null;
  onClose: () => void;
  onStart: (options: StoryActionOptions) => void;
}) {
  const policyName = useId();
  const [manualEdits, setManualEdits] = useState<ManualEditPolicy>("keep");
  const [allowLocked, setAllowLocked] = useState<string[]>([]);
  const lockable = lockedChoices(report, chapters);
  const choice: RebuildChoice = {
    chapters,
    manualEdits,
    allowLocked: allowLocked.filter((id) => lockable.includes(id)),
  };
  const { chosen, alsoApplies } = plannedSections(report, chapters);
  const conflicts = conflictingEdits(report, choice);
  const count = chapters
    ? chapters.length
    : new Set([...report.affected, ...report.moved, ...choice.allowLocked]).size;
  const titles = new Map(report.sections.map((section) => [section.chapter, section.title]));
  const sideUnits = [...report.music, ...(report.captions ? [report.captions] : [])]
    .map((unit) => ({ unit, action: plannedAction(unit, null, choice) }))
    .filter(
      ({ unit, action }) =>
        action !== "keep" || unit.edits.length > 0 || unit.change !== "unchanged",
    );
  const moving = report.unrelated.filter((clip) => clip.shift !== 0);
  const single = chapters?.length === 1 ? titles.get(chapters[0]) : undefined;
  const startBlocker = blocker ?? (count === 0 ? "Nothing to rebuild" : null);

  return (
    <StoryDialog
      title={single ? `Rebuild “${single}”` : "Rebuild affected sections"}
      description={
        <>
          Only what the story changed is regenerated; the rest of the timeline stays as it is.
          Duration{" "}
          <span className="tabular-nums text-text-1">
            {formatDuration(report.duration.current)} → {formatDuration(report.duration.next)}
          </span>
          .
        </>
      }
      onClose={onClose}
      footer={
        <>
          {startBlocker && (
            <span className="mr-auto text-step-10 text-text-3" role="status">
              {startBlocker}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={startBlocker !== null}
            icon={<ArrowsClockwise size={12} aria-hidden />}
            onClick={() => onStart(rebuildOptions(choice))}
          >
            {`Rebuild ${count} ${count === 1 ? "section" : "sections"}`}
          </Button>
        </>
      }
    >
      <DialogGroup title="Sections">
        {chosen.length === 0 ? (
          <p className="text-step-11 text-text-3">
            Nothing to rebuild: the timeline matches the story.
          </p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {chosen.map((section) => (
              <SectionPlan
                key={section.chapter}
                report={report}
                section={section}
                choice={choice}
              />
            ))}
          </ol>
        )}
      </DialogGroup>

      {alsoApplies.length > 0 && (
        <DialogGroup title="Also applies">
          <ul className="flex flex-col gap-0.5">
            {alsoApplies.map((section) => (
              <li
                key={section.chapter}
                className="flex items-center gap-2 text-step-10 text-text-2"
              >
                <span className="min-w-0 flex-1 truncate">{section.title}</span>
                <span className="shrink-0 tabular-nums text-text-3">
                  {section.change === "removed"
                    ? "Comes off the timeline"
                    : `Moves ${formatSpan(section.current)} → ${formatSpan(section.next)}`}
                </span>
              </li>
            ))}
          </ul>
        </DialogGroup>
      )}

      {sideUnits.length > 0 && (
        <DialogGroup title="Music & captions">
          <ul className="flex flex-col gap-1">
            {sideUnits.map(({ unit, action }) => (
              <UnitRow key={`${unit.role}-${unit.node}`} unit={unit} action={action} />
            ))}
          </ul>
        </DialogGroup>
      )}

      {moving.length > 0 && (
        <DialogGroup title="Other clips">
          <p className="text-step-10 text-text-2">
            {moving.length} {moving.length === 1 ? "clip" : "clips"} no section owns will move with
            their section:{" "}
            {moving
              .slice(0, UNRELATED_SHOWN)
              .map(
                (clip) => `${clip.label} (${clip.shift > 0 ? "+" : ""}${clip.shift.toFixed(1)} s)`,
              )
              .join(", ")}
            {moving.length > UNRELATED_SHOWN && `, +${moving.length - UNRELATED_SHOWN} more`}.
          </p>
        </DialogGroup>
      )}

      {conflicts.length > 0 && (
        <DialogGroup title="Your edits on the timeline">
          <div role="radiogroup" aria-label="Manual edits" className="flex flex-col">
            <ChoiceRow
              type="radio"
              name={policyName}
              checked={manualEdits === "keep"}
              onChange={() => setManualEdits("keep")}
              label="Keep my edits (skip conflicting parts)"
              description={`${conflicts.length} edited ${conflicts.length === 1 ? "part stays" : "parts stay"} as ${conflicts.length === 1 ? "it is" : "they are"}, even where the story changed them.`}
            />
            <ChoiceRow
              type="radio"
              name={policyName}
              checked={manualEdits === "replace"}
              onChange={() => setManualEdits("replace")}
              label="Replace my edits"
              description="Those parts are regenerated from the story."
            />
          </div>
          {manualEdits === "replace" && (
            <Callout>
              <span>
                {conflicts.length} manual {conflicts.length === 1 ? "edit" : "edits"} will be
                replaced (Revert the turn to get them back):
              </span>
              <EditRows edits={conflicts} limit={5} showWhere />
            </Callout>
          )}
        </DialogGroup>
      )}

      {lockable.length > 0 && (
        <DialogGroup title="Locked chapters">
          <div className="flex flex-col">
            {lockable.map((chapter) => (
              <ChoiceRow
                key={chapter}
                type="checkbox"
                checked={allowLocked.includes(chapter)}
                onChange={(checked) =>
                  setAllowLocked((current) =>
                    checked ? [...current, chapter] : current.filter((id) => id !== chapter),
                  )
                }
                label={`Allow rebuilding “${titles.get(chapter) ?? chapter}”`}
                description="Locked: it stays as built unless you allow it (it may still move in time)."
              />
            ))}
          </div>
        </DialogGroup>
      )}

      {report.warnings.length > 0 && (
        <Callout>
          {report.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </Callout>
      )}
    </StoryDialog>
  );
}
