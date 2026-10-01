import { useState } from "react";
import type { HfColorCurvePoint, HfHueCurvePoint } from "@hyperframes/core/color-grading";
import { RotateCcw } from "../../icons/SystemIcons";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { INSP_MINI_BUTTON } from "./inspectorStyles";
import {
  CurveGraph,
  formatPointValue,
  movePoint,
  pointsFor,
  RGB_IDENTITY,
  type ColorCurveValues,
  withPoints,
} from "./propertyPanelColorCurveGraph";
import { TABS, type CurveTab } from "./propertyPanelColorCurveTabs";
import { GradingNumberField } from "./propertyPanelGradingNumberField";
import { useInspectorGestureDraft } from "./useInspectorGestureTransaction";

export type { ColorCurveValues } from "./propertyPanelColorCurveGraph";

export function ColorCurves({
  value,
  disabled,
  onPreview,
  onCommit,
}: {
  value: ColorCurveValues;
  disabled?: boolean;
  onPreview: (value: ColorCurveValues) => void;
  onCommit: (value: ColorCurveValues) => void;
}) {
  const { t } = useTranslation();
  const [activeKey, setActiveKey] = useState<CurveTab["key"]>("master");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const { draft, setDraft, transaction } = useInspectorGestureDraft({
    sourceValue: value,
    onPreview,
    onCommit,
  });
  const tab = TABS.find((candidate) => candidate.key === activeKey) ?? TABS[0];
  if (!tab) throw new Error("Color curve tabs are unavailable");
  const points = pointsFor(draft, tab);

  const previewPoints = (
    nextPoints: readonly (HfColorCurvePoint | HfHueCurvePoint)[],
    nextSelectedIndex: number,
  ) => {
    setSelectedIndex(nextSelectedIndex);
    transaction.preview(withPoints(draft, tab, nextPoints));
  };
  const resetActive = () => {
    transaction.cancel();
    const next = withPoints(draft, tab, tab.kind === "rgb" ? RGB_IDENTITY : []);
    setDraft(next);
    setSelectedIndex(null);
    onCommit(next);
  };
  const deleteSelected = () => {
    if (selectedIndex === null) return;
    if (tab.kind === "rgb" && (selectedIndex === 0 || selectedIndex === points.length - 1)) return;
    transaction.cancel();
    const nextPoints =
      tab.kind === "hue" && points.length <= 3
        ? []
        : points.filter((_, index) => index !== selectedIndex);
    const next = withPoints(draft, tab, nextPoints);
    setDraft(next);
    setSelectedIndex(null);
    onCommit(next);
  };
  const updateSelected = (axis: "input" | "output", rawValue: number) => {
    if (selectedIndex === null || !Number.isFinite(rawValue)) return;
    const point = points[selectedIndex];
    if (!point) return;
    const moved = movePoint(
      points,
      selectedIndex,
      axis === "input" ? rawValue : point[0],
      axis === "output" ? rawValue : point[1],
      tab,
    );
    previewPoints(moved.points, moved.selected);
  };
  const selectedPoint = selectedIndex === null ? null : points[selectedIndex];
  const endpointSelected =
    tab.kind === "rgb" &&
    selectedIndex !== null &&
    (selectedIndex === 0 || selectedIndex === points.length - 1);

  return (
    <div data-color-curves="true" className="grid gap-1.5">
      <div className="flex min-w-0 flex-wrap gap-px rounded-md border border-border bg-bg-1 p-0.5">
        {TABS.map((candidate) => (
          <button
            key={candidate.key}
            type="button"
            data-color-curve-tab={candidate.key}
            aria-pressed={candidate.key === tab.key}
            disabled={disabled}
            onClick={() => {
              transaction.cancel();
              setActiveKey(candidate.key);
              setSelectedIndex(null);
            }}
            className={`h-[18px] min-w-0 flex-1 truncate rounded-sm px-1 text-xs transition-colors focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent disabled:text-fg-disabled ${
              candidate.key === tab.key
                ? "bg-surface-3 text-fg"
                : "text-fg-3 hover:bg-surface-1 hover:text-fg-2"
            }`}
          >
            {t(candidate.label)}
          </button>
        ))}
      </div>
      <CurveGraph
        tab={tab}
        points={points}
        selectedIndex={selectedIndex}
        disabled={disabled}
        onBegin={transaction.begin}
        onPreview={previewPoints}
        onSelect={setSelectedIndex}
        onDelete={deleteSelected}
        onSettle={transaction.settle}
        onCancel={transaction.cancel}
      />
      <div className="flex min-h-7 items-end gap-1.5">
        {selectedPoint ? (
          <>
            <GradingNumberField
              label={tab.kind === "rgb" ? t("inspector.curves.input") : t("inspector.curves.hue")}
              ariaLabel={
                tab.kind === "rgb"
                  ? t("inspector.curves.pointInput")
                  : t("inspector.curves.pointHue")
              }
              value={formatPointValue(selectedPoint[0], tab, "input")}
              min={0}
              max={tab.kind === "rgb" ? 1 : 359.999}
              disabled={disabled || endpointSelected}
              labelClassName="min-w-0 flex-1"
              labelTextClassName="block text-2xs text-fg-3"
              inputClassName="block w-full"
              onBegin={transaction.begin}
              onPreview={(next) => updateSelected("input", next)}
              onSettle={transaction.settle}
              onCancel={transaction.cancel}
            />
            <GradingNumberField
              label={t("inspector.curves.output")}
              ariaLabel={t("inspector.curves.pointOutput")}
              value={formatPointValue(selectedPoint[1], tab, "output")}
              min={tab.min}
              max={tab.max}
              disabled={disabled}
              labelClassName="min-w-0 flex-1"
              labelTextClassName="block text-2xs text-fg-3"
              inputClassName="block w-full"
              onBegin={transaction.begin}
              onPreview={(next) => updateSelected("output", next)}
              onSettle={transaction.settle}
              onCancel={transaction.cancel}
            />
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled || endpointSelected}
              onClick={deleteSelected}
            >
              {t("inspector.curves.delete")}
            </Button>
          </>
        ) : (
          <span className="flex-1 self-center text-xs text-fg-3">
            {t("inspector.curves.addHint")}
          </span>
        )}
        <button
          type="button"
          aria-label={t("inspector.curves.reset", { name: t(tab.label) })}
          title={t("inspector.curves.reset", { name: t(tab.label) })}
          disabled={disabled}
          onClick={resetActive}
          className={INSP_MINI_BUTTON}
        >
          <RotateCcw size={12} />
        </button>
      </div>
    </div>
  );
}
