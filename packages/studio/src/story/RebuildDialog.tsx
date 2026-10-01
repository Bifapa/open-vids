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
import { Trans, formatNumber, t as translate, useTranslation } from "../i18n";
import { formatDuration } from "./storyFormat";
import { Callout, ChoiceRow, DialogGroup, EditRows, StoryDialog } from "./StoryDialog";
import {
  SYNC_ACTION_KEYS,
  SYNC_ROLE_KEYS,
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
  rebuild: "text-warning",
  add: "text-warning",
  remove: "text-error",
  keep_edited: "text-fg",
  keep_locked: "text-fg-2",
  shift: "text-fg-2",
  keep: "text-fg-3",
  skip: "text-fg-3",
};

/** How many unrelated clips the dialog names before it only counts them. */
const UNRELATED_SHOWN = 3;

function sectionBadges(report: StorySyncReport, section: StorySyncSection): SyncBadge[] {
  if (section.change !== "removed") return chapterBadges(report, section.chapter);
  return [
    {
      kind: "changed",
      label: translate("story.rebuild.leavesStory"),
      detail: translate("story.rebuild.leavesStory.detail"),
    },
  ];
}

function UnitRow({ unit, action }: { unit: StorySyncUnit; action: StorySyncAction }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="w-14 shrink-0 text-fg-3">{t(SYNC_ROLE_KEYS[unit.role])}</span>
        <span className="min-w-0 flex-1 truncate text-fg" title={unit.reasons.join("; ")}>
          {unit.title}
        </span>
        <span
          className={cn("shrink-0 font-medium", ACTION_TONES[action])}
          data-unit-action={action}
        >
          {t(SYNC_ACTION_KEYS[action])}
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
  const { t } = useTranslation();
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
      className="grid gap-1.5 rounded-md border border-border-subtle bg-bg-0 px-2.5 py-2"
      data-sync-section={section.chapter}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
          {section.title}
        </span>
        <SyncBadges badges={sectionBadges(report, section)} />
        <span className="shrink-0 font-mono text-num text-fg-3">
          {formatSpan(section.current)} → {formatSpan(section.next)}
        </span>
      </div>
      {section.reasons.length > 0 && (
        <p className="-mt-1 text-xs text-fg-3">{section.reasons.join(" · ")}</p>
      )}
      {onlyMoves ? (
        <p className="text-xs text-fg-3">{t("story.rebuild.movesWhole")}</p>
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
  const { t } = useTranslation();
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
  const startBlocker = blocker ?? (count === 0 ? t("story.rebuild.nothing") : null);
  const shown = moving.slice(0, UNRELATED_SHOWN).map((clip) =>
    t("story.rebuild.clipShift", {
      label: clip.label,
      shift: formatNumber(clip.shift, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
        signDisplay: "exceptZero",
      }),
    }),
  );
  const clips = shown.join(", ");

  return (
    <StoryDialog
      title={single ? t("story.rebuild.titleOne", { title: single }) : t("story.rebuild.title")}
      description={
        <Trans
          i18nKey="story.rebuild.description"
          values={{
            from: formatDuration(report.duration.current),
            to: formatDuration(report.duration.next),
          }}
          components={{ mono: <span className="font-mono text-fg-2" /> }}
        />
      }
      onClose={onClose}
      footer={
        <>
          {startBlocker && (
            <span className="mr-auto text-xs text-fg-3" role="status">
              {startBlocker}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={startBlocker !== null}
            icon={<ArrowsClockwise size={12} aria-hidden />}
            onClick={() => onStart(rebuildOptions(choice))}
          >
            {t("story.rebuild.start", { count })}
          </Button>
        </>
      }
    >
      <DialogGroup title={t("story.rebuild.sections")}>
        {chosen.length === 0 ? (
          <p className="text-sm text-fg-3">{t("story.rebuild.upToDate")}</p>
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
        <DialogGroup title={t("story.rebuild.alsoApplies")}>
          <ul className="flex flex-col gap-0.5">
            {alsoApplies.map((section) => (
              <li key={section.chapter} className="flex items-center gap-2 text-xs text-fg-2">
                <span className="min-w-0 flex-1 truncate">{section.title}</span>
                <span className="shrink-0 font-mono text-num text-fg-3">
                  {section.change === "removed"
                    ? t("story.rebuild.comesOff")
                    : t("story.rebuild.movesSpan", {
                        from: formatSpan(section.current),
                        to: formatSpan(section.next),
                      })}
                </span>
              </li>
            ))}
          </ul>
        </DialogGroup>
      )}

      {sideUnits.length > 0 && (
        <DialogGroup title={t("story.rebuild.musicCaptions")}>
          <ul className="flex flex-col gap-1">
            {sideUnits.map(({ unit, action }) => (
              <UnitRow key={`${unit.role}-${unit.node}`} unit={unit} action={action} />
            ))}
          </ul>
        </DialogGroup>
      )}

      {moving.length > 0 && (
        <DialogGroup title={t("story.rebuild.otherClips")}>
          <p className="text-xs leading-[15px] text-fg-2">
            {t("story.rebuild.otherClipsBody", {
              count: moving.length,
              clips:
                moving.length > UNRELATED_SHOWN
                  ? t("story.rebuild.clipsMore", {
                      clips,
                      count: moving.length - UNRELATED_SHOWN,
                    })
                  : clips,
            })}
          </p>
        </DialogGroup>
      )}

      {conflicts.length > 0 && (
        <DialogGroup title={t("story.rebuild.yourEdits")}>
          <div
            role="radiogroup"
            aria-label={t("story.dialog.manualEdits")}
            className="flex flex-col"
          >
            <ChoiceRow
              type="radio"
              name={policyName}
              checked={manualEdits === "keep"}
              onChange={() => setManualEdits("keep")}
              label={t("story.rebuild.keepEdits")}
              description={t("story.rebuild.keepEditsHint", { count: conflicts.length })}
            />
            <ChoiceRow
              type="radio"
              name={policyName}
              checked={manualEdits === "replace"}
              onChange={() => setManualEdits("replace")}
              label={t("story.rebuild.replaceEdits")}
              description={t("story.rebuild.replaceEditsHint")}
            />
          </div>
          {manualEdits === "replace" && (
            <Callout>
              <span>{t("story.rebuild.replaceWarning", { count: conflicts.length })}</span>
              <EditRows edits={conflicts} limit={5} showWhere />
            </Callout>
          )}
        </DialogGroup>
      )}

      {lockable.length > 0 && (
        <DialogGroup title={t("story.rebuild.lockedGroup")}>
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
                label={t("story.rebuild.allowLocked", { title: titles.get(chapter) ?? chapter })}
                description={t("story.rebuild.lockedHint")}
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
