import { useEffect, useMemo, useRef, useState } from "react";
import {
  HF_COLOR_GRADING_GRADE_PRESETS,
  normalizeHfColorGrading,
  serializeHfColorGrading,
  type HfColorGradingAdjustKey,
  type HfColorGradingDetailKey,
  type NormalizedHfColorGrading,
} from "@hyperframes/core/color-grading";
import { Plus, Settings } from "../../icons/SystemIcons";
import { formatPercent, useTranslation } from "../../i18n";
import { LUT_EXT } from "@hyperframes/core/media-types";
import { CaretDown } from "@phosphor-icons/react";
import { FlatSlider } from "./propertyPanelFlatPrimitives";
import { FlatSubGroup } from "./propertyPanelFlatSubGroup";
import { Badge } from "../ui/Status";
import { Button } from "../ui/Button";
import { INSP_MINI_BUTTON, INSP_SELECT, INSP_SUBGROUP_HEAD } from "./inspectorStyles";
import type {
  ColorGradingControllerState,
  ColorGradingPresetPreviews,
  ColorGradingPreviewOptions,
  MediaMetadata,
} from "./useColorGradingController";
import { presetPreviewHandlers } from "./propertyPanelPresetPreview";
import { ColorCurves } from "./propertyPanelColorCurves";
import {
  colorGradingWithAdjust,
  colorGradingWithDetail,
  createColorGradingActions,
  visibleColorGradingIntensity,
} from "./propertyPanelColorGradingControls";
import {
  COLOR_GRADING_ADJUST_SLIDERS,
  COLOR_GRADING_DETAIL_SLIDERS,
  GRAIN_TUNE_SLIDERS,
  normalizedColorGradingDefault,
  VIGNETTE_TUNE_SLIDERS,
} from "./propertyPanelColorGradingSliders";
import { PropertyPanelColorScopes } from "./propertyPanelColorScopes";
import { PropertyPanelColorSecondary } from "./propertyPanelColorSecondary";
import { ColorWheels } from "./propertyPanelColorWheels";

export { FlatColorGradingAccessory } from "./propertyPanelFlatColorGradingAccessory";

function formatAdjustValue(key: HfColorGradingAdjustKey, rawPercent: number): string {
  if (key === "exposure") {
    const stops = rawPercent / 100;
    return `${stops >= 0 ? "+" : ""}${stops.toFixed(2)}`;
  }
  return `${Math.round(rawPercent)}%`;
}

const detailByKey = (key: HfColorGradingDetailKey) => {
  const spec = COLOR_GRADING_DETAIL_SLIDERS.find((candidate) => candidate.key === key);
  if (!spec) throw new Error(`Unknown color grading detail key: ${key}`);
  return spec;
};

function resolveColorGrading(grading: Parameters<typeof normalizeHfColorGrading>[0]) {
  const resolved = normalizeHfColorGrading(grading);
  if (!resolved) throw new Error("Missing resolved color grading");
  return resolved;
}

function HdrBanner({ metadata }: { metadata: MediaMetadata | null }) {
  const { t } = useTranslation();
  if (metadata?.color.dynamicRange !== "hdr") return null;
  const details = [
    metadata.color.codecName,
    metadata.color.profile,
    metadata.color.pixelFormat,
    metadata.color.colorPrimaries,
    metadata.color.colorTransfer,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      data-flat-grade-hdr-banner="true"
      className="rounded-sm border border-warning/35 bg-warning-soft px-2 py-1.5 text-xs leading-[15px] text-fg-2"
    >
      <div className="flex items-center justify-between gap-2 text-fg">
        <span className="font-semibold">
          {t("inspector.grade.hdrSource", { label: metadata.color.label })}
        </span>
        <Badge tone="warning" size="sm">
          {t("inspector.grade.sdrPreviewBadge")}
        </Badge>
      </div>
      <p className="mt-0.5">{t("inspector.grade.hdrNote")}</p>
      {details && (
        <p data-flat-grade-hdr-detail="true" className="mt-0.5 truncate text-2xs text-fg-3">
          {details}
        </p>
      )}
    </div>
  );
}

export function FlatColorGradingSection({
  grading,
  assets,
  onImportAssets,
  onCommitColorGrading,
  onPreviewColorGrading,
  applyScope,
  applyBusy,
  onSetApplyScope,
  onApplyToScope,
  onApplyScopeAvailable,
  mediaMetadata,
  presetPreviews,
  onRequestPresetPreviews,
  captureGradedFrame,
}: {
  grading: NormalizedHfColorGrading;
  assets: string[];
  onImportAssets?: (files: FileList, dir?: string) => Promise<string[]>;
  onCommitColorGrading: (next: NormalizedHfColorGrading) => void;
  onPreviewColorGrading: (
    next: NormalizedHfColorGrading | null,
    options?: ColorGradingPreviewOptions,
  ) => void;
  applyScope: "source-file" | "project";
  applyBusy: boolean;
  onSetApplyScope: (scope: "source-file" | "project") => void;
  onApplyToScope: () => void;
  onApplyScopeAvailable: boolean;
  mediaMetadata: MediaMetadata | null;
  presetPreviews: ColorGradingPresetPreviews;
  onRequestPresetPreviews: () => void;
  captureGradedFrame: ColorGradingControllerState["captureGradedFrame"];
}) {
  const { t } = useTranslation();
  const lutInputRef = useRef<HTMLInputElement>(null);
  const [lutOpen, setLutOpen] = useState(false);
  const [detailSettingsOpen, setDetailSettingsOpen] = useState<"vignette" | "grain" | null>(null);
  const lutAssets = useMemo(
    () => assets.filter((asset) => LUT_EXT.test(asset)).sort((a, b) => a.localeCompare(b)),
    [assets],
  );
  const lut = grading.lut;
  const selectedLutName = lut?.src ? (lut.src.split("/").pop() ?? lut.src) : null;
  const resolvedGrading = useMemo(() => resolveColorGrading(grading), [grading]);
  const secondaryInputGrading = useMemo(
    () =>
      resolveColorGrading({
        intensity: 1,
        adjust: resolvedGrading.adjust,
        wheels: resolvedGrading.wheels,
        curves: resolvedGrading.curves,
        hueCurves: resolvedGrading.hueCurves,
        colorSpace: resolvedGrading.colorSpace,
      }),
    [
      resolvedGrading.adjust,
      resolvedGrading.colorSpace,
      resolvedGrading.curves,
      resolvedGrading.hueCurves,
      resolvedGrading.wheels,
    ],
  );
  const actions = createColorGradingActions(grading, onCommitColorGrading);
  const scopesRefreshKey = useMemo(() => serializeHfColorGrading(grading), [grading]);

  useEffect(() => {
    if (presetPreviews.status === "idle") onRequestPresetPreviews();
  }, [onRequestPresetPreviews, presetPreviews.status]);

  const resolvePreset = (presetId: string) => {
    const resolved = normalizeHfColorGrading({ preset: presetId, lut: grading.lut });
    return resolved
      ? {
          ...resolved,
          effects: grading.effects,
          palette: grading.palette,
        }
      : grading;
  };

  useEffect(() => () => onPreviewColorGrading(null), [onPreviewColorGrading]);

  const settingsLabel = (key: "vignette" | "grain") =>
    key === "vignette" ? t("inspector.grade.vignetteSettings") : t("inspector.grade.grainSettings");
  const renderDetailSlider = (key: HfColorGradingDetailKey) => {
    const spec = detailByKey(key);
    const value = grading.details[key];
    const defaultValue = normalizedColorGradingDefault(spec);
    const isSet = Math.abs(value - defaultValue) > 1e-4;
    return (
      <FlatSlider
        key={key}
        label={t(spec.label)}
        value={Math.round(value * spec.scale)}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        tier={isSet ? "explicitCustom" : "default"}
        displayValue={`${Math.round(value * spec.scale)}${spec.suffix}`}
        centerTick={key === "vignetteRoundness"}
        onCommit={(next) =>
          onCommitColorGrading(colorGradingWithDetail(grading, key, next / spec.scale))
        }
        onReset={() => onCommitColorGrading(colorGradingWithDetail(grading, key, defaultValue))}
      />
    );
  };

  const selectedPreset = HF_COLOR_GRADING_GRADE_PRESETS.find((p) => p.id === grading.preset);
  const primaryAdjusted = COLOR_GRADING_ADJUST_SLIDERS.some(
    (slider) => Math.abs(grading.adjust[slider.key]) > 1e-6,
  );

  return (
    <div className="grid gap-1.5">
      <HdrBanner metadata={mediaMetadata} />
      <PropertyPanelColorScopes
        captureFrame={() => captureGradedFrame()}
        refreshKey={scopesRefreshKey}
      />
      <FlatSubGroup
        title={t("inspector.grade.looks")}
        meta={t("inspector.grade.looksMeta", {
          preset: selectedPreset?.label ?? t("inspector.fill.none"),
          intensity: formatPercent(grading.intensity),
        })}
      >
        <div data-flat-grade-presets="true" className="grid gap-1.5">
          {presetPreviews.status === "unavailable" && (
            <Button
              size="xs"
              variant="ghost"
              className="justify-self-start"
              onClick={onRequestPresetPreviews}
            >
              {t("inspector.grade.retryPreviews")}
            </Button>
          )}
          <div data-flat-grade-preset-group="presets" className="grid grid-cols-3 gap-1.5">
            {HF_COLOR_GRADING_GRADE_PRESETS.map((preset) => {
              const label = preset.label;
              const selected = grading.preset === preset.id;
              const preview = presetPreviews.images[preset.id];
              return (
                <button
                  key={preset.id}
                  type="button"
                  data-flat-grade-preset={preset.id}
                  aria-pressed={selected}
                  {...presetPreviewHandlers({
                    id: preset.id,
                    label,
                    resolve: () => resolvePreset(preset.id),
                    onPreview: onPreviewColorGrading,
                    onCommit: onCommitColorGrading,
                  })}
                  className={`grid min-w-0 overflow-hidden rounded-sm border text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                    selected
                      ? "border-accent bg-surface-1 text-fg shadow-[inset_0_0_0_1px_var(--color-accent)]"
                      : "border-border-subtle bg-surface-1 text-fg-2 hover:border-border-strong hover:text-fg"
                  }`}
                >
                  <span
                    data-flat-grade-preview-frame={preset.id}
                    className="flex w-full items-center justify-center overflow-hidden bg-bg-1"
                    style={{ aspectRatio: `${presetPreviews.width} / ${presetPreviews.height}` }}
                  >
                    {preview ? (
                      <img
                        data-flat-grade-preview={preset.id}
                        src={preview}
                        alt=""
                        draggable={false}
                        className="block h-full w-full object-cover"
                      />
                    ) : (
                      <span
                        data-flat-grade-preview-placeholder={presetPreviews.status}
                        className="h-full w-full bg-surface-1"
                      />
                    )}
                  </span>
                  <span className="block truncate px-[5px] pt-[3px] pb-1 text-2xs leading-[13px]">
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <FlatSlider
          label={t("inspector.grade.amount")}
          value={Math.round(grading.intensity * 100)}
          min={0}
          max={100}
          tier={grading.intensity === 1 ? "default" : "explicitCustom"}
          displayValue={`${Math.round(grading.intensity * 100)}%`}
          onCommit={actions.setIntensityPercent}
          onReset={() => actions.setIntensityPercent(100)}
        />
      </FlatSubGroup>

      <FlatSubGroup
        title={t("inspector.grade.primary")}
        meta={primaryAdjusted ? t("inspector.grade.adjusted") : undefined}
      >
        {COLOR_GRADING_ADJUST_SLIDERS.map((slider) => {
          const rawPercent = grading.adjust[slider.key] * slider.scale;
          const isSet = Math.abs(grading.adjust[slider.key]) > 1e-6;
          return (
            <div key={slider.key} data-flat-grade-adjust="true">
              <FlatSlider
                label={t(slider.label)}
                value={rawPercent}
                min={slider.min}
                max={slider.max}
                step={slider.step}
                tier={isSet ? "explicitCustom" : "default"}
                displayValue={formatAdjustValue(slider.key, rawPercent)}
                centerTick
                onCommit={(next) =>
                  onCommitColorGrading(
                    colorGradingWithAdjust(grading, slider.key, next / slider.scale),
                  )
                }
                onReset={() => onCommitColorGrading(colorGradingWithAdjust(grading, slider.key, 0))}
              />
            </div>
          );
        })}
      </FlatSubGroup>

      <FlatSubGroup title={t("inspector.grade.colorWheels")}>
        <ColorWheels
          value={resolvedGrading.wheels}
          onPreview={(wheels) =>
            onPreviewColorGrading({
              ...grading,
              intensity: visibleColorGradingIntensity(grading),
              wheels,
            })
          }
          onCommit={(wheels) =>
            onCommitColorGrading({
              ...grading,
              intensity: visibleColorGradingIntensity(grading),
              wheels,
            })
          }
        />
      </FlatSubGroup>

      <FlatSubGroup title={t("inspector.grade.curves")}>
        <ColorCurves
          value={{ curves: resolvedGrading.curves, hueCurves: resolvedGrading.hueCurves }}
          onPreview={({ curves, hueCurves }) =>
            onPreviewColorGrading({
              ...grading,
              intensity: visibleColorGradingIntensity(grading),
              curves,
              hueCurves,
            })
          }
          onCommit={({ curves, hueCurves }) =>
            onCommitColorGrading({
              ...grading,
              intensity: visibleColorGradingIntensity(grading),
              curves,
              hueCurves,
            })
          }
        />
      </FlatSubGroup>

      <FlatSubGroup title={t("inspector.grade.secondary")}>
        <PropertyPanelColorSecondary
          secondaries={resolvedGrading.secondaries}
          captureFrame={() => captureGradedFrame({ grading: secondaryInputGrading })}
          onCommit={(secondaries) =>
            onCommitColorGrading({
              ...grading,
              intensity: visibleColorGradingIntensity(grading),
              secondaries,
            })
          }
        />
      </FlatSubGroup>

      <div className="min-w-0 border-t border-border-subtle">
        <button
          type="button"
          data-flat-grade-lut-toggle="true"
          aria-expanded={lutOpen}
          onClick={() => setLutOpen((v) => !v)}
          className={INSP_SUBGROUP_HEAD}
        >
          <CaretDown
            size={12}
            aria-hidden="true"
            className={`shrink-0 text-fg-3 transition-transform ${lutOpen ? "" : "-rotate-90"}`}
          />
          {t("inspector.grade.customLut")}
          <span className="ml-auto min-w-0 truncate font-normal text-fg-3">
            {selectedLutName ?? t("inspector.fill.none")}
          </span>
        </button>
        {lutOpen && (
          <div className="grid gap-1.5 pt-0.5 pb-2.5">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
              <select
                data-flat-grade-lut-select="true"
                aria-label={t("inspector.grade.customLut")}
                value={lut?.src ?? ""}
                onChange={(e) => {
                  const src = e.target.value;
                  actions.applyLut(src || null, src && lut?.src === src ? lut.intensity : 1);
                }}
                className={`${INSP_SELECT} font-mono text-num`}
              >
                <option value="">{t("inspector.fill.none")}</option>
                {lutAssets.map((asset) => (
                  <option key={asset} value={asset}>
                    {asset.split("/").pop() ?? asset}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={!onImportAssets}
                onClick={() => lutInputRef.current?.click()}
                title={t("inspector.grade.importLut")}
                icon={<Plus size={12} />}
              >
                {t("inspector.grade.import")}
              </Button>
              <input
                ref={lutInputRef}
                type="file"
                accept=".cube"
                className="hidden"
                onChange={(e) => {
                  void actions.importLut(e.currentTarget.files, onImportAssets);
                  e.currentTarget.value = "";
                }}
              />
            </div>
            {lut && (
              <FlatSlider
                label={t("inspector.grade.lutStrengthShort")}
                value={Math.round((lut.intensity ?? 1) * 100)}
                min={0}
                max={100}
                tier={lut.intensity === 1 ? "default" : "explicitCustom"}
                displayValue={`${Math.round((lut.intensity ?? 1) * 100)}%`}
                onCommit={(v) => actions.applyLut(lut.src, v / 100)}
                onReset={() => actions.applyLut(lut.src, 1)}
              />
            )}
          </div>
        )}
      </div>

      <FlatSubGroup title={t("inspector.grade.finish")}>
        {(["vignette", "grain"] as const).map((key) => (
          <div key={key} className="grid grid-cols-[minmax(0,1fr)_20px] items-center gap-1">
            {renderDetailSlider(key)}
            <button
              type="button"
              data-flat-grade-settings={key}
              title={settingsLabel(key)}
              aria-label={settingsLabel(key)}
              aria-expanded={detailSettingsOpen === key}
              onClick={() => setDetailSettingsOpen((c) => (c === key ? null : key))}
              className={`${INSP_MINI_BUTTON} aria-expanded:bg-surface-3 aria-expanded:text-fg`}
            >
              <Settings size={12} />
            </button>
          </div>
        ))}
        {detailSettingsOpen && (
          <div className="grid gap-1.5 border-l-2 border-border pl-2.5">
            {(detailSettingsOpen === "vignette" ? VIGNETTE_TUNE_SLIDERS : GRAIN_TUNE_SLIDERS).map(
              (slider) => renderDetailSlider(slider.key),
            )}
          </div>
        )}
      </FlatSubGroup>

      {onApplyScopeAvailable && (
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1.5 border-t border-border-subtle pt-2">
          <span className="whitespace-nowrap text-sm text-fg-3">{t("inspector.grade.copyTo")}</span>
          <select
            aria-label={t("inspector.grade.copyTo")}
            value={applyScope}
            onChange={(e) => {
              onSetApplyScope(e.target.value as "source-file" | "project");
            }}
            disabled={applyBusy}
            className={INSP_SELECT}
          >
            <option value="source-file">{t("inspector.grade.scopeFile")}</option>
            <option value="project">{t("inspector.grade.scopeProject")}</option>
          </select>
          <Button
            size="sm"
            data-flat-grade-apply="true"
            disabled={applyBusy}
            onClick={() => {
              onApplyToScope();
            }}
          >
            {applyBusy ? t("inspector.grade.applying") : t("inspector.grade.apply")}
          </Button>
        </div>
      )}
    </div>
  );
}
