import type { GsapPercentageKeyframe } from "@hyperframes/core/gsap-parser";
import { formatPercent, useTranslation } from "../../i18n";
import { EASE_LABELS } from "./gsapAnimationConstants";
import { EaseCurveSection } from "./EaseCurveSection";
import type { AnimationKeyframeTarget } from "../../hooks/gsapTweenSynth";
import { INSP_SELECT } from "./inspectorStyles";

// The full GSAP easing vocabulary offered by the "Set all…" bulk control —
// every standard family in in/out/inOut, so authors aren't limited to a curated
// few. All are valid GSAP runtime eases; the non-cubic families (sine/circ/
// elastic/bounce) approximate in the per-segment curve preview.
const APPLY_ALL_EASES = [
  "none",
  "power1.in",
  "power1.out",
  "power1.inOut",
  "power2.in",
  "power2.out",
  "power2.inOut",
  "power3.in",
  "power3.out",
  "power3.inOut",
  "power4.in",
  "power4.out",
  "power4.inOut",
  "sine.in",
  "sine.out",
  "sine.inOut",
  "expo.in",
  "expo.out",
  "expo.inOut",
  "circ.in",
  "circ.out",
  "circ.inOut",
  "back.in",
  "back.out",
  "back.inOut",
  "elastic.in",
  "elastic.out",
  "elastic.inOut",
  "bounce.in",
  "bounce.out",
  "bounce.inOut",
] as const;

export function KeyframeEaseList({
  keyframes,
  globalEase,
  expandedPct,
  collidingAnimationTargets,
  onToggle,
  onEaseCommit,
  onApplyAll,
}: {
  keyframes: GsapPercentageKeyframe[];
  globalEase: string;
  expandedPct: number | null;
  collidingAnimationTargets?: AnimationKeyframeTarget[];
  onToggle: (pct: number | null) => void;
  onEaseCommit: (pct: number, ease: string) => void;
  /** Apply one ease to every segment at once (clears per-segment overrides). */
  onApplyAll?: (ease: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <p className="text-2xs font-semibold uppercase tracking-wider text-fg-3">
          {t("editor.keyframe.perKeyframeEasing")}
        </p>
        {onApplyAll && (
          <select
            aria-label={t("editor.keyframe.applyAllAria")}
            title={t("editor.keyframe.applyAllTitle")}
            value=""
            onChange={(e) => {
              const next = e.target.value;
              if (next) onApplyAll(next);
            }}
            className={`${INSP_SELECT} ml-auto w-auto`}
          >
            <option value="" disabled>
              {t("editor.keyframe.setAll")}
            </option>
            {APPLY_ALL_EASES.map((name) => (
              <option key={name} value={name}>
                {EASE_LABELS[name] ?? name}
              </option>
            ))}
          </select>
        )}
      </div>
      {keyframes.map((kf, i) => {
        if (i === 0) return null;
        const segEase = kf.ease ?? globalEase;
        const isExpanded = expandedPct === kf.percentage;
        const label = t("editor.keyframe.segment", {
          from: formatPercent(keyframes[i - 1].percentage / 100, 2),
          to: formatPercent(kf.percentage / 100, 2),
        });
        const easeLabel = segEase.startsWith("custom(")
          ? t("editor.keyframe.customEase")
          : (EASE_LABELS[segEase] ?? segEase);
        return (
          <div
            key={`${i}-${kf.percentage}`}
            data-ease-segment-pct={kf.percentage}
            className="rounded-md bg-surface-1/50"
          >
            <button
              type="button"
              onClick={() => onToggle(isExpanded ? null : kf.percentage)}
              aria-expanded={isExpanded}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left active:scale-[0.99]"
            >
              <span className="text-xs font-medium text-fg-2">{label}</span>
              <span className="ml-auto text-2xs text-fg-3">{easeLabel}</span>
              <svg
                width="8"
                height="8"
                viewBox="0 0 10 10"
                fill="currentColor"
                className={`text-fg-3 transition-transform duration-150 ${isExpanded ? "" : "-rotate-90"}`}
              >
                <path d="M2 3l3 4 3-4z" />
              </svg>
            </button>
            {isExpanded && (
              <div className="px-2 pb-2">
                <EaseCurveSection
                  ease={segEase}
                  collidingAnimationTargets={collidingAnimationTargets}
                  onCustomEaseCommit={(ease) => onEaseCommit(kf.percentage, ease)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
