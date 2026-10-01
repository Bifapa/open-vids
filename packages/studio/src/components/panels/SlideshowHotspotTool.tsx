/**
 * SlideshowHotspotTool — the hotspot sub-surface of SlideshowPanel.
 * Not exported from the package index; used only by SlideshowPanel.tsx.
 */

import { useState, useCallback } from "react";
import type { SlideRef, SlideHotspot, SlideSequence } from "@hyperframes/core/slideshow";
import type { DomEditSelection } from "../editor/domEditing";
import { generateId } from "../../utils/generateId";
import { X } from "@phosphor-icons/react";
import { buttonBase, buttonSizes, buttonVariants } from "../ui/Button";
import { INSP_MINI_BUTTON, INSP_SELECT } from "../editor/inspectorStyles";
import { Trans, useTranslation } from "../../i18n";
import { SLIDE_FIELD } from "./slideshowStyles";

// ── Sub-surface: Hotspot Tool ─────────────────────────────────────────────

export interface HotspotToolProps {
  selectedSceneId: string | null;
  slide: SlideRef | undefined;
  domEditSelection: DomEditSelection | null;
  sequences: SlideSequence[];
  onAddHotspot: (sceneId: string, hotspot: SlideHotspot) => void;
  onRemoveHotspot: (sceneId: string, hotspotId: string) => void;
}

export function HotspotTool({
  selectedSceneId,
  slide,
  domEditSelection,
  sequences,
  onAddHotspot,
  onRemoveHotspot,
}: HotspotToolProps) {
  const { t } = useTranslation();
  const [targetSequenceId, setTargetSequenceId] = useState("");
  const [hotspotLabel, setHotspotLabel] = useState("");
  const hotspots = slide?.hotspots ?? [];

  const selectedElementId = domEditSelection?.element?.id ?? null;
  const selectedHfId = domEditSelection?.hfId ?? null;
  const elementKey = selectedElementId || selectedHfId;

  const handleMakeHotspot = useCallback(() => {
    if (!selectedSceneId || !targetSequenceId || !elementKey) return;
    const id = `hotspot-${elementKey}-${generateId()}`;
    const label = hotspotLabel.trim() || elementKey;
    onAddHotspot(selectedSceneId, { id, label, target: targetSequenceId });
    setHotspotLabel("");
  }, [selectedSceneId, targetSequenceId, elementKey, hotspotLabel, onAddHotspot]);

  if (!selectedSceneId) {
    return (
      <div className="px-3 py-2">
        <p className="m-0 text-sm text-fg-3">{t("panels.slideshow.hotspot.selectScene")}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-2 px-3 py-2">
      <div className="grid gap-1.5">
        <p className="m-0 text-sm text-fg-3">
          <Trans
            i18nKey="panels.slideshow.hotspot.selectedElement"
            values={{ element: elementKey ?? t("panels.slideshow.hotspot.none") }}
            components={{ mono: <span className="font-mono text-num text-fg" /> }}
          />
        </p>
        {!elementKey && (
          <p className="m-0 text-xs text-fg-3">{t("panels.slideshow.hotspot.clickElement")}</p>
        )}
        {sequences.length === 0 && (
          <p className="m-0 text-xs text-fg-3">{t("panels.slideshow.hotspot.needsBranch")}</p>
        )}
        <label className="text-sm text-fg-3">{t("panels.slideshow.hotspot.label")}</label>
        <input
          type="text"
          className={`${SLIDE_FIELD} h-ctl-sm`}
          placeholder={t("panels.slideshow.hotspot.labelPlaceholder")}
          value={hotspotLabel}
          onChange={(e) => setHotspotLabel(e.target.value)}
          aria-label={t("panels.slideshow.hotspot.label")}
        />
        <label className="text-sm text-fg-3">{t("panels.slideshow.hotspot.target")}</label>
        <select
          className={INSP_SELECT}
          value={targetSequenceId}
          onChange={(e) => setTargetSequenceId(e.target.value)}
          aria-label={t("panels.slideshow.hotspot.targetLabel")}
        >
          <option value="">{t("panels.slideshow.hotspot.selectBranch")}</option>
          {sequences.map((seq) => (
            <option key={seq.id} value={seq.id}>
              {seq.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!elementKey || !targetSequenceId}
          title={
            !elementKey
              ? t("panels.slideshow.hotspot.needElementFirst")
              : !targetSequenceId
                ? t("panels.slideshow.hotspot.needTargetFirst")
                : undefined
          }
          className={`${buttonBase} ${buttonVariants.primary} ${buttonSizes.sm} justify-self-start`}
          onClick={handleMakeHotspot}
        >
          {t("panels.slideshow.hotspot.make")}
        </button>
      </div>

      {hotspots.length > 0 && (
        <div className="grid gap-1">
          <p className="m-0 text-xs font-semibold text-fg-2">
            {t("panels.slideshow.hotspot.onSlide")}
          </p>
          {hotspots.map((h) => {
            const seqLabel = sequences.find((s) => s.id === h.target)?.label ?? h.target;
            return (
              <div
                key={h.id}
                className="flex h-row-sm items-center gap-2 rounded-sm border border-border-subtle bg-bg-1 pr-1 pl-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-fg">
                  {h.label} → <span className="text-fg-3">{seqLabel}</span>
                </span>
                <button
                  type="button"
                  aria-label={t("panels.slideshow.hotspot.removeLabel", { label: h.label })}
                  className={`${INSP_MINI_BUTTON} hover:text-error`}
                  onClick={() => onRemoveHotspot(selectedSceneId, h.id)}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
