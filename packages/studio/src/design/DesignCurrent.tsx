import { ArrowsClockwise, Eye, LinkBreak, Warning } from "@phosphor-icons/react";
import type { ProjectDesignState } from "@hyperframes/agent-protocol";
import { Button } from "../components/ui";
import { useTranslation } from "../i18n";
import type { SnapshotFacts } from "./designFacts";
import { DesignChips, Swatches } from "./DesignParts";
import type { DesignMutation } from "./designStore";

/**
 * What the one explicit repair action (`update()`) does for the attached system, or null when there is nothing to do:
 * `update` — the library holds a newer version; `replace` — the library's system of this id is a different one (it was
 * deleted and created again, so its version is not newer but it is not the project's copy); `restore` — the project's
 * copy of the files is missing or damaged and the library can put them back.
 */
type RepairMode = "update" | "replace" | "restore";

function repairModeOf(state: ProjectDesignState): RepairMode | null {
  const { attached, library, updateAvailable, snapshotOk } = state;
  if (!attached || !library) return null;
  if (library.version > attached.version) return "update";
  if (updateAvailable) return "replace";
  return snapshotOk ? null : "restore";
}

/**
 * The system the project carries: its name and version, palette and display font as the project's own copy says,
 * the honest chips, and the actions — Preview, Detach and, when the library can change or repair the project's copy,
 * one explicit button for it (Update, Replace or Restore). Nothing here changes by itself.
 */
export function DesignCurrent({
  state,
  facts,
  mutation,
  onPreview,
  onDetach,
  onUpdate,
}: {
  state: ProjectDesignState;
  facts: SnapshotFacts | null;
  mutation: DesignMutation | null;
  onPreview(): void;
  onDetach(): void;
  onUpdate(): void;
}) {
  const { t } = useTranslation();
  const { attached, library, snapshotOk } = state;
  if (!attached) return null;
  const busy = mutation !== null;
  const palette = facts?.palette ?? [];
  const repair = repairModeOf(state);
  return (
    <section
      aria-label={t("studio.design.current.label")}
      data-testid="design-current"
      className="flex flex-col gap-2 rounded-md border border-border bg-surface-1 p-2.5"
    >
      <div className="flex items-center gap-2.5">
        <Swatches colors={palette} className="h-7 w-16" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-baseline gap-1.5">
            <span className="min-w-0 truncate text-md font-semibold text-fg" title={attached.name}>
              {attached.name}
            </span>
            <span className="shrink-0 text-xs text-fg-3 tabular-nums">
              {t("studio.design.version", { version: attached.version })}
            </span>
          </div>
          <span className="truncate text-xs text-fg-3">
            {facts?.displayFont
              ? t("studio.design.displayFont", { font: facts.displayFont })
              : t("studio.design.displayFont.unknown")}
          </span>
        </div>
      </div>

      <DesignChips facts={attached} />

      {!snapshotOk ? (
        <p role="alert" className="m-0 flex items-start gap-1.5 text-xs text-warning">
          <Warning size={12} weight="fill" aria-hidden className="mt-px shrink-0" />
          <span>
            {library === null
              ? t("studio.design.snapshotBroken.removed")
              : t("studio.design.snapshotBroken")}
          </span>
        </p>
      ) : null}

      {library === null && snapshotOk ? (
        <p className="m-0 text-xs text-fg-3">{t("studio.design.removedFromLibrary")}</p>
      ) : null}

      {repair && library ? (
        <div
          data-testid="design-update"
          data-repair={repair}
          className="flex flex-col gap-1.5 rounded-sm bg-surface-2 px-2 py-1.5"
        >
          {repair === "update" ? (
            <p className="m-0 text-xs text-fg-2">
              {t("studio.design.update.note", {
                current: attached.version,
                latest: library.version,
              })}
            </p>
          ) : null}
          {repair === "replace" ? (
            <p className="m-0 text-xs text-fg-2">
              {t("studio.design.update.recreated", {
                name: library.name,
                current: attached.version,
                latest: library.version,
              })}
            </p>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            loading={mutation?.kind === "update"}
            icon={<ArrowsClockwise size={12} aria-hidden />}
            onClick={onUpdate}
          >
            {repair === "update"
              ? t("studio.design.update.button", { version: library.version })
              : repair === "replace"
                ? t("studio.design.update.replace", { version: library.version })
                : t("studio.design.update.restore")}
          </Button>
          <p className="m-0 text-2xs leading-[13px] text-fg-3">
            {repair === "restore"
              ? t("studio.design.update.restoreEffect")
              : t("studio.design.update.effect")}
          </p>
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={!snapshotOk}
          icon={<Eye size={12} aria-hidden />}
          onClick={onPreview}
        >
          {t("studio.design.preview")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          loading={mutation?.kind === "detach"}
          icon={<LinkBreak size={12} aria-hidden />}
          onClick={onDetach}
        >
          {t("studio.design.detach")}
        </Button>
      </div>
      <p className="m-0 text-2xs leading-[13px] text-fg-3">{t("studio.design.detach.note")}</p>
    </section>
  );
}
