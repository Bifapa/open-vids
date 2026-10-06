import { ArrowsClockwise, Eye, LinkBreak, Warning } from "@phosphor-icons/react";
import type { ProjectDesignState } from "@hyperframes/agent-protocol";
import { Button } from "../components/ui";
import { useTranslation } from "../i18n";
import type { SnapshotFacts } from "./designFacts";
import { DesignChips, Swatches } from "./DesignParts";
import type { DesignMutation } from "./designStore";

/**
 * The system the project carries: its name and version, palette and display font as the project's own copy says,
 * the honest chips, and the three actions — Preview, Detach and, only when the library holds a newer version, an
 * explicit Update. Nothing here changes by itself.
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
  const { attached, library, updateAvailable, snapshotOk } = state;
  if (!attached) return null;
  const busy = mutation !== null;
  const palette = facts?.palette ?? [];
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
          <span>{t("studio.design.snapshotBroken")}</span>
        </p>
      ) : null}

      {library === null ? (
        <p className="m-0 text-xs text-fg-3">{t("studio.design.removedFromLibrary")}</p>
      ) : null}

      {updateAvailable && library ? (
        <div
          data-testid="design-update"
          className="flex flex-col gap-1.5 rounded-sm bg-surface-2 px-2 py-1.5"
        >
          <p className="m-0 text-xs text-fg-2">
            {t("studio.design.update.note", {
              current: attached.version,
              latest: library.version,
            })}
          </p>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            loading={mutation?.kind === "update"}
            icon={<ArrowsClockwise size={12} aria-hidden />}
            onClick={onUpdate}
          >
            {t("studio.design.update.button", { version: library.version })}
          </Button>
          <p className="m-0 text-2xs leading-[13px] text-fg-3">
            {t("studio.design.update.effect")}
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
