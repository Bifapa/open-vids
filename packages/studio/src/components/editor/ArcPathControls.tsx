import { memo, useCallback } from "react";
import type { ArcPathConfig, ArcPathSegment } from "@hyperframes/core/gsap-parser";
import { useTranslation } from "../../i18n";
import { SliderControl } from "./propertyPanelPrimitives";
import { LABEL } from "./propertyPanelHelpers";
import { P } from "./panelTokens";

interface ArcPathControlsProps {
  arcPath: ArcPathConfig;
  segmentCount: number;
  onToggle: (enabled: boolean) => void;
  onUpdateSegment: (index: number, update: Partial<ArcPathSegment>) => void;
  onToggleAutoRotate: (autoRotate: boolean) => void;
  disabled?: boolean;
}

export const ArcPathControls = memo(function ArcPathControls({
  arcPath,
  segmentCount,
  onToggle,
  onUpdateSegment,
  onToggleAutoRotate,
  disabled,
}: ArcPathControlsProps) {
  const { t } = useTranslation();
  const handleToggle = useCallback(() => {
    onToggle(!arcPath.enabled);
  }, [arcPath.enabled, onToggle]);

  const handleAutoRotate = useCallback(() => {
    onToggleAutoRotate(!arcPath.autoRotate);
  }, [arcPath.autoRotate, onToggleAutoRotate]);

  if (segmentCount < 1) {
    return (
      <div className="rounded-md border border-border bg-surface-1/50 px-3 py-2">
        <p className="text-sm text-fg-3">{t("editor.arcPath.needKeyframes")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className={LABEL}>{t("editor.arcPath.arcMotion")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={Boolean(arcPath.enabled)}
          aria-label={t("editor.arcPath.arcMotionAria")}
          onClick={handleToggle}
          disabled={disabled}
          className="relative rounded-full transition-colors duration-200"
          style={{ width: 28, height: 16, background: arcPath.enabled ? P.accent : P.borderInput }}
          title={arcPath.enabled ? t("editor.arcPath.disableArc") : t("editor.arcPath.enableArc")}
        >
          <span
            className="absolute top-[2px] left-0 rounded-full transition-transform duration-200"
            style={{
              width: 12,
              height: 12,
              background: arcPath.enabled ? P.white : P.textMuted,
              transform: arcPath.enabled ? "translateX(14px)" : "translateX(2px)",
            }}
          />
        </button>
      </div>

      {arcPath.enabled && (
        <>
          <div className="flex items-center justify-between">
            <span className={LABEL}>{t("editor.arcPath.autoRotate")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(arcPath.autoRotate)}
              aria-label={t("editor.arcPath.autoRotateAria")}
              onClick={handleAutoRotate}
              disabled={disabled}
              className="relative rounded-full transition-colors duration-200"
              style={{
                width: 28,
                height: 16,
                background: arcPath.autoRotate ? P.accent : "#27272A",
              }}
              title={
                arcPath.autoRotate
                  ? t("editor.arcPath.disableAutoRotate")
                  : t("editor.arcPath.enableAutoRotate")
              }
            >
              <span
                className="absolute top-[2px] left-0 rounded-full transition-transform duration-200"
                style={{
                  width: 12,
                  height: 12,
                  background: arcPath.autoRotate ? P.white : P.textMuted,
                  transform: arcPath.autoRotate ? "translateX(14px)" : "translateX(2px)",
                }}
              />
            </button>
          </div>

          {arcPath.segments.map((seg, i) => (
            <div key={i} className="grid min-w-0 gap-1.5">
              <div className="flex items-center justify-between">
                <span className={LABEL}>
                  {segmentCount === 1
                    ? t("editor.arcPath.curviness")
                    : t("editor.arcPath.segment", { index: i + 1 })}
                </span>
                {seg.cp1 && seg.cp2 && (
                  <button
                    type="button"
                    onClick={() => onUpdateSegment(i, { cp1: undefined, cp2: undefined })}
                    className="text-2xs font-medium text-fg-3 transition-colors hover:text-fg-2"
                    title={t("editor.arcPath.resetTitle")}
                  >
                    {t("common.reset")}
                  </button>
                )}
              </div>
              <SliderControl
                trackName={
                  segmentCount === 1
                    ? t("editor.arcPath.curviness")
                    : t("editor.arcPath.segmentCurviness", { index: i + 1 })
                }
                value={seg.curviness}
                min={0}
                max={3}
                step={0.1}
                disabled={disabled}
                displayValue={seg.curviness.toFixed(1)}
                formatDisplayValue={(v) => v.toFixed(1)}
                onCommit={(v) => onUpdateSegment(i, { curviness: v })}
              />
            </div>
          ))}
        </>
      )}
    </div>
  );
});
