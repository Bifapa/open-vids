import type { GsapAnimation } from "@hyperframes/parsers/gsap-parser";
import type { TFunction } from "i18next";
import { formatNumber } from "../../i18n";
import {
  EASE_LABELS,
  PERCENT_PROPS,
  PROP_UNITS,
  propLabel as translatePropLabel,
} from "./gsapAnimationConstants";

function formatPropValue(prop: string, v: number | string): string {
  const unit = PROP_UNITS[prop] ?? "";
  if (PERCENT_PROPS.has(prop)) return `${Math.round(Number(v) * 100)}${unit}`;
  return `${v}${unit}`;
}

/** A position or duration in seconds as shown in prose; a relative position (`"<"`, `"+=1"`) stays as written. */
function formatSeconds(value: number | string, round = false): string {
  if (typeof value !== "number") return value;
  return formatNumber(round ? parseFloat(value.toFixed(3)) : value, {
    maximumFractionDigits: 20,
    useGrouping: false,
  });
}

export function buildTweenSummary(t: TFunction, animation: GsapAnimation): string {
  const easeName = animation.ease ?? "none";
  const ease = (EASE_LABELS[easeName] ?? easeName).toLowerCase();
  const props = Object.entries(animation.properties);
  const target = animation.targetSelector;
  const pos = formatSeconds(animation.position, true);
  const dur = formatSeconds(animation.duration ?? 0);
  const propDescs = props.map(([p, v]) =>
    t("editor.animation.summary.propTo", {
      label: translatePropLabel(t, p).toLowerCase(),
      value: formatPropValue(p, v),
    }),
  );
  const propText =
    propDescs.length > 0 ? propDescs.join(", ") : t("editor.animation.summary.noProperties");
  if (animation.method === "set")
    return t("editor.animation.summary.set", { pos, target, props: propText });
  if (animation.method === "from")
    return t("editor.animation.summary.from", { pos, dur, target, props: propText, ease });
  if (animation.method === "fromTo") {
    const fromProps = Object.entries(animation.fromProperties ?? {});
    const fromDescs = fromProps.map(([p, v]) =>
      t("editor.animation.summary.propFrom", {
        label: translatePropLabel(t, p).toLowerCase(),
        value: formatPropValue(p, v),
      }),
    );
    const fromText = fromDescs.length > 0 ? fromDescs.join(", ") : "—";
    return t("editor.animation.summary.fromTo", {
      pos,
      dur,
      target,
      from: fromText,
      props: propText,
      ease,
    });
  }
  return t("editor.animation.summary.to", { pos, dur, target, props: propText, ease });
}
