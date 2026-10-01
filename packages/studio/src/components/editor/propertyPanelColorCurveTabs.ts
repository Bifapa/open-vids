import type {
  HfColorGradingCurveKey,
  HfColorGradingHueCurveKey,
} from "@hyperframes/core/color-grading";
import type { TranslationKey } from "../../i18n";

type RgbTab = {
  kind: "rgb";
  key: HfColorGradingCurveKey;
  label: TranslationKey;
  color: string;
  min: 0;
  max: 1;
};
type HueTab = {
  kind: "hue";
  key: HfColorGradingHueCurveKey;
  label: TranslationKey;
  color: string;
  min: number;
  max: number;
};
export type CurveTab = RgbTab | HueTab;

export const TABS: readonly CurveTab[] = [
  // Master and the hue curves draw in the panel ink; R/G/B carry their channel's real hue
  // (a data encoding, the same oklch values as the prototype's `.fx-cv-red|green|blue`).
  {
    kind: "rgb",
    key: "master",
    label: "inspector.curves.tab.master",
    color: "var(--color-fg)",
    min: 0,
    max: 1,
  },
  {
    kind: "rgb",
    key: "red",
    label: "inspector.curves.tab.red",
    color: "oklch(66% 0.19 25)",
    min: 0,
    max: 1,
  },
  {
    kind: "rgb",
    key: "green",
    label: "inspector.curves.tab.green",
    color: "oklch(72% 0.17 145)",
    min: 0,
    max: 1,
  },
  {
    kind: "rgb",
    key: "blue",
    label: "inspector.curves.tab.blue",
    color: "oklch(64% 0.17 255)",
    min: 0,
    max: 1,
  },
  {
    kind: "hue",
    key: "hueVsHue",
    label: "inspector.curves.tab.hueVsHue",
    color: "var(--color-fg)",
    min: -180,
    max: 180,
  },
  {
    kind: "hue",
    key: "hueVsSaturation",
    label: "inspector.curves.tab.hueVsSaturation",
    color: "var(--color-fg)",
    min: -1,
    max: 1,
  },
  {
    kind: "hue",
    key: "hueVsLuma",
    label: "inspector.curves.tab.hueVsLuma",
    color: "var(--color-fg)",
    min: -1,
    max: 1,
  },
];
