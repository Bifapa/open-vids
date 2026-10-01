import { useState } from "react";
import type { RegistryItem } from "@hyperframes/core/registry";
import { useBlockCatalog } from "../../hooks/useBlockCatalog";
import { Film, Plus } from "../../icons/SystemIcons";
import { useTranslation } from "../../i18n";
import type { DomEditSelection } from "./domEditing";
import type { ElementTiming } from "./propertyPanelFlatTimingDerivation";

export const MEDIA_TREATMENT_OVERLAY_TAG = "media-treatment-overlay";

export function filterMediaTreatmentOverlays(items: readonly RegistryItem[]): RegistryItem[] {
  return items.filter(
    (item) =>
      item.type === "hyperframes:block" &&
      item.tags?.includes(MEDIA_TREATMENT_OVERLAY_TAG) === true,
  );
}

export function deriveMediaOverlayPlacement(
  element: Pick<DomEditSelection, "dataAttributes" | "sourceFile">,
  timing: Pick<ElementTiming, "start" | "duration">,
) {
  const authoredTrack = Number.parseInt(element.dataAttributes["track-index"] ?? "", 10);
  return {
    start: timing.start,
    ...(timing.duration > 0 ? { duration: timing.duration } : {}),
    ...(Number.isFinite(authoredTrack) ? { track: authoredTrack + 1 } : {}),
    compositionPath: element.sourceFile,
  };
}

export function FlatOverlaysSection({
  onAddOverlay,
}: {
  onAddOverlay: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { blocks, loading, error } = useBlockCatalog();
  const overlays = filterMediaTreatmentOverlays(blocks);
  const [adding, setAdding] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="py-4 text-center text-xs text-fg-3">{t("inspector.overlays.loading")}</div>
    );
  }
  if (error) {
    return <div className="py-4 text-center text-xs text-error">{error}</div>;
  }

  const busy = adding !== null;
  const described = overlays.find((overlay) => overlay.name === previewing);
  return (
    <div className="grid gap-1.5">
      <p className="m-0 text-xs leading-[15px] text-fg-3">{t("inspector.overlays.hint")}</p>
      <div data-flat-overlays="true" className="grid grid-cols-2 gap-2">
        {overlays.map((overlay) => (
          <button
            key={overlay.name}
            type="button"
            data-flat-overlay={overlay.name}
            aria-label={t("inspector.overlays.add", { title: overlay.title })}
            disabled={busy}
            title={overlay.description}
            onPointerEnter={() => setPreviewing(overlay.name)}
            onPointerLeave={() => setPreviewing(null)}
            onFocus={() => setPreviewing(overlay.name)}
            onBlur={() => setPreviewing(null)}
            onClick={() => {
              setAdding(overlay.name);
              void onAddOverlay(overlay.name).finally(() => setAdding(null));
            }}
            className={`group grid min-w-0 gap-1 overflow-hidden rounded-sm border bg-surface-1 pb-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent active:bg-surface-2 disabled:cursor-wait disabled:opacity-50 ${
              previewing === overlay.name
                ? "border-border-strong text-fg"
                : "border-border-subtle text-fg-2 hover:border-border-strong hover:text-fg"
            }`}
          >
            <span className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-bg-1">
              {previewing === overlay.name && overlay.preview?.video ? (
                <video
                  src={overlay.preview.video}
                  poster={overlay.preview.poster}
                  autoPlay
                  muted
                  loop
                  playsInline
                  className="block h-full w-full object-cover"
                />
              ) : overlay.preview?.poster ? (
                <img
                  data-flat-overlay-preview={overlay.name}
                  src={overlay.preview.poster}
                  alt=""
                  draggable={false}
                  loading="lazy"
                  className="block h-full w-full object-cover"
                />
              ) : (
                <Film size={15} className="text-fg-3" />
              )}
              <span className="absolute right-1 top-1 inline-flex size-[18px] items-center justify-center rounded-full bg-on-media-bg text-on-media opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Plus size={12} />
              </span>
            </span>
            <span className="block truncate px-1.5 text-xs leading-[14px]">
              {adding === overlay.name ? t("inspector.overlays.adding") : overlay.title}
            </span>
          </button>
        ))}
      </div>
      {described?.description ? (
        <p className="m-0 min-h-7 text-xs leading-[14px] text-fg-3">{described.description}</p>
      ) : null}
    </div>
  );
}
