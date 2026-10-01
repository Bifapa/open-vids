import { useState } from "react";
import { Hammer } from "@phosphor-icons/react";
import type { StoryActionOptions, StorySyncReport } from "@hyperframes/agent-protocol";
import { Button } from "../components/ui";
import { useTranslation } from "../i18n";
import { Callout, ChoiceRow, DialogGroup, EditRows, StoryDialog } from "./StoryDialog";
import { allEdits, lockedBuiltSections } from "./storySync";

/** How many replaced edits the dialog names before it only counts them. */
const EDITS_SHOWN = 5;

/**
 * Confirms a full Build Story over a story that was built already and then edited on the timeline or locked: the
 * build regenerates every section (manual edits replaced), locked sections stay unless ticked. Rebuild affected is
 * offered instead when it can run.
 */
export function FullBuildDialog({
  report,
  rebuildBlocker,
  blocker,
  onClose,
  onBuild,
  onRebuildInstead,
}: {
  report: StorySyncReport;
  /** Why Rebuild affected cannot run from the report, or null when it can. */
  rebuildBlocker: string | null;
  /** Why the agent cannot start a turn now. */
  blocker: string | null;
  onClose: () => void;
  onBuild: (options: StoryActionOptions) => void;
  onRebuildInstead: () => void;
}) {
  const { t } = useTranslation();
  const [allowLocked, setAllowLocked] = useState<string[]>([]);
  const edits = allEdits(report);
  const locked = lockedBuiltSections(report);
  const count = report.manualEdits;

  return (
    <StoryDialog
      title={t("story.fullBuild.title")}
      description={
        count > 0
          ? t("story.fullBuild.description", { count })
          : t("story.fullBuild.descriptionNoEdits")
      }
      onClose={onClose}
      footer={
        <>
          {blocker && (
            <span className="mr-auto text-xs text-fg-3" role="status">
              {blocker}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={blocker !== null}
            icon={<Hammer size={12} aria-hidden />}
            onClick={() => onBuild(allowLocked.length > 0 ? { allowLocked } : {})}
          >
            {t("story.fullBuild.confirm")}
          </Button>
        </>
      }
    >
      {edits.length > 0 && (
        <DialogGroup title={t("story.fullBuild.editsGroup")}>
          <EditRows edits={edits} limit={EDITS_SHOWN} showWhere />
        </DialogGroup>
      )}

      {locked.length > 0 && (
        <DialogGroup title={t("story.fullBuild.lockedGroup")}>
          <p className="text-xs text-fg-3">{t("story.fullBuild.lockedNote")}</p>
          <div className="flex flex-col">
            {locked.map((section) => (
              <ChoiceRow
                key={section.chapter}
                type="checkbox"
                checked={allowLocked.includes(section.chapter)}
                onChange={(checked) =>
                  setAllowLocked((current) =>
                    checked
                      ? [...current, section.chapter]
                      : current.filter((id) => id !== section.chapter),
                  )
                }
                label={t("story.fullBuild.rebuildToo", { title: section.title })}
                description={
                  report.lockedPending.includes(section.chapter)
                    ? t("story.fullBuild.lockedPending")
                    : t("story.fullBuild.lockedKept")
                }
              />
            ))}
          </div>
        </DialogGroup>
      )}

      <Callout tone="info">
        <span>{t("story.fullBuild.rebuildHint")}</span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={rebuildBlocker !== null}
            onClick={onRebuildInstead}
          >
            {t("story.fullBuild.rebuildInstead")}
          </Button>
          {rebuildBlocker && <span className="text-xs text-fg-3">{rebuildBlocker}</span>}
        </div>
      </Callout>
    </StoryDialog>
  );
}
