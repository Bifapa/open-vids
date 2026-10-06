import { Check, Eye, PencilSimple, Warning } from "@phosphor-icons/react";
import type { DesignSystemSummary } from "@hyperframes/agent-protocol";
import { IconButton, Spinner, Tooltip, cn } from "../components/ui";
import { useTranslation } from "../i18n";
import { designChips, swatchColors } from "./designFacts";
import { Swatches } from "./DesignParts";
import type { DesignMutation } from "./designStore";

/**
 * The library as a picker: choosing a row attaches that system to the project. Each row also previews the system and
 * hands it to the agent for an edit. A row that has licence or portability notes says so with its warning mark.
 */
export function DesignLibraryList({
  systems,
  attachedId,
  mutation,
  onAttach,
  onPreview,
  onEdit,
}: {
  systems: readonly DesignSystemSummary[];
  attachedId: string | null;
  mutation: DesignMutation | null;
  onAttach(id: string): void;
  onPreview(system: DesignSystemSummary): void;
  onEdit(system: DesignSystemSummary): void;
}) {
  const { t } = useTranslation();
  const busy = mutation !== null;
  return (
    <ul
      aria-label={t("studio.design.library.label")}
      data-testid="design-library"
      className="m-0 flex list-none flex-col gap-px p-0"
    >
      {systems.map((system) => {
        const attached = system.id === attachedId;
        const attaching = mutation?.kind === "attach" && mutation.id === system.id;
        const notes = designChips(system);
        return (
          <li
            key={system.id}
            data-design-id={system.id}
            className="group flex items-center gap-0.5 rounded-md hover:bg-surface-2 focus-within:bg-surface-2"
          >
            <button
              type="button"
              disabled={attached || busy}
              aria-label={t("studio.design.library.attach", { name: system.name })}
              onClick={() => onAttach(system.id)}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-hidden",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                "disabled:cursor-default",
              )}
            >
              <Swatches colors={swatchColors(system.palette)} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-fg" title={system.name}>
                  {system.name}
                </span>
                <span className="truncate text-xs text-fg-3">
                  {system.displayFont
                    ? t("studio.design.library.meta", {
                        version: system.version,
                        font: system.displayFont,
                      })
                    : t("studio.design.version", { version: system.version })}
                </span>
              </span>
              {notes.length > 0 ? (
                <span
                  role="img"
                  aria-label={t("studio.design.library.notes", {
                    notes: notes.map((note) => note.label).join("; "),
                  })}
                  title={notes.map((note) => note.label).join("\n")}
                  className="shrink-0 text-warning"
                >
                  <Warning size={12} weight="fill" aria-hidden />
                </span>
              ) : null}
              {attaching ? (
                <Spinner className="shrink-0" />
              ) : attached ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-fg-2">
                  <Check size={12} weight="bold" aria-hidden />
                  {t("studio.design.library.attached")}
                </span>
              ) : (
                <span className="shrink-0 text-xs font-medium text-fg-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                  {t("studio.design.library.attachShort")}
                </span>
              )}
            </button>
            <Tooltip label={t("studio.design.library.previewTip")} side="bottom">
              <IconButton
                size="sm"
                aria-label={t("studio.design.library.preview", { name: system.name })}
                icon={<Eye size={13} aria-hidden />}
                onClick={() => onPreview(system)}
              />
            </Tooltip>
            <Tooltip label={t("studio.design.library.editTip")} side="bottom">
              <IconButton
                size="sm"
                aria-label={t("studio.design.library.edit", { name: system.name })}
                icon={<PencilSimple size={13} aria-hidden />}
                onClick={() => onEdit(system)}
              />
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
