import { INSP_MINI_BUTTON } from "./inspectorStyles";
import { useEffect, useRef } from "react";
import { isHfColorGradingActive } from "@hyperframes/core/color-grading";
import { Compare, RotateCcw } from "../../icons/SystemIcons";
import { useTranslation } from "../../i18n";
import type { ColorGradingControllerState } from "./useColorGradingController";
import { gradeStatusText } from "./propertyPanelGradeStatus";

const STATUS_DOT_CLASS: Record<ColorGradingControllerState["runtimeStatus"]["state"], string> = {
  active: "bg-emerald-400",
  pending: "bg-amber-300",
  unavailable: "bg-red-400",
  missing: "bg-panel-text-5",
  inactive: "bg-panel-text-5",
};

export function FlatColorGradingAccessory({
  state,
}: {
  state: Pick<
    ColorGradingControllerState,
    "grading" | "compareEnabled" | "runtimeStatus" | "commitCompare" | "resetGrading"
  >;
}) {
  const { t } = useTranslation();
  const { grading, compareEnabled, runtimeStatus, commitCompare, resetGrading } = state;
  const gradingActive = isHfColorGradingActive(grading);
  const statusText = gradeStatusText(runtimeStatus.message);
  const releaseRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      releaseRef.current?.();
      releaseRef.current = null;
    },
    [],
  );

  return (
    <span className="flex items-center gap-2.5">
      <button
        type="button"
        aria-pressed={compareEnabled}
        aria-label={t("inspector.grade.holdToCompare")}
        disabled={!gradingActive}
        onPointerDown={(e) => {
          if (!gradingActive) return;
          e.preventDefault();
          e.stopPropagation();
          commitCompare(true);
          const release = () => {
            commitCompare(false);
            window.removeEventListener("pointerup", release);
            window.removeEventListener("pointercancel", release);
            window.removeEventListener("blur", release);
            releaseRef.current = null;
          };
          releaseRef.current = release;
          window.addEventListener("pointerup", release);
          window.addEventListener("pointercancel", release);
          window.addEventListener("blur", release);
        }}
        onBlur={() => {
          if (compareEnabled) commitCompare(false);
        }}
        onKeyDown={(e) => {
          if (!gradingActive || (e.key !== " " && e.key !== "Enter")) return;
          e.preventDefault();
          if (!compareEnabled) {
            commitCompare(true);
          }
        }}
        onKeyUp={(e) => {
          if (!gradingActive || (e.key !== " " && e.key !== "Enter")) return;
          e.preventDefault();
          commitCompare(false);
        }}
        title={t("inspector.grade.holdToCompare")}
        className={INSP_MINI_BUTTON}
      >
        <Compare size={12} />
      </button>
      <span className="flex min-w-0 items-center gap-1" title={statusText}>
        <span
          data-flat-grade-status-dot="true"
          title={statusText}
          className={`h-[5px] w-[5px] shrink-0 rounded-full ${STATUS_DOT_CLASS[runtimeStatus.state]}`}
        />
        <span
          data-flat-grade-status-message="true"
          className="max-w-[84px] truncate text-2xs text-fg-3"
        >
          {statusText}
        </span>
      </span>
      <button
        type="button"
        data-flat-grade-reset="true"
        title={t("inspector.grade.reset")}
        onClick={(e) => {
          e.stopPropagation();
          resetGrading();
        }}
        className={INSP_MINI_BUTTON}
      >
        <RotateCcw size={12} />
      </button>
    </span>
  );
}
