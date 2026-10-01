import type {
  HfColorGradingAdjustKey,
  HfColorGradingDetailKey,
  HfColorGradingEffectKey,
} from "@hyperframes/core/color-grading";
import type { TranslationKey } from "../../i18n";

export const COLOR_GRADING_ADJUST_SLIDERS: Array<{
  key: HfColorGradingAdjustKey;
  label: TranslationKey;
  min: number;
  max: number;
  step: number;
  scale: number;
  suffix: string;
}> = [
  {
    key: "exposure",
    label: "inspector.grade.adjust.exposure",
    min: -200,
    max: 200,
    step: 5,
    scale: 100,
    suffix: "",
  },
  {
    key: "contrast",
    label: "inspector.grade.adjust.contrast",
    min: -100,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
  {
    key: "highlights",
    label: "inspector.grade.adjust.highlights",
    min: -100,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
  {
    key: "shadows",
    label: "inspector.grade.adjust.shadows",
    min: -100,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
  {
    key: "whites",
    label: "inspector.grade.adjust.whitePoint",
    min: -100,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
  {
    key: "blacks",
    label: "inspector.grade.adjust.blackPoint",
    min: -100,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
  {
    key: "temperature",
    label: "inspector.grade.adjust.warmth",
    min: -100,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
  {
    key: "tint",
    label: "inspector.grade.adjust.tint",
    min: -100,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
  {
    key: "vibrance",
    label: "inspector.grade.adjust.vibrance",
    min: -100,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
  {
    key: "saturation",
    label: "inspector.grade.adjust.saturation",
    min: -100,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
];

export const COLOR_GRADING_DETAIL_SLIDERS: Array<{
  key: HfColorGradingDetailKey;
  label: TranslationKey;
  min: number;
  max: number;
  step: number;
  scale: number;
  suffix: string;
  defaultValue?: number;
}> = [
  {
    key: "vignette",
    label: "inspector.grade.detail.vignette",
    min: 0,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
  {
    key: "vignetteMidpoint",
    label: "inspector.grade.detail.vignetteMidpoint",
    min: 0,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
    defaultValue: 50,
  },
  {
    key: "vignetteRoundness",
    label: "inspector.grade.detail.vignetteRoundness",
    min: -100,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
  {
    key: "vignetteFeather",
    label: "inspector.grade.detail.vignetteFeather",
    min: 0,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
    defaultValue: 65,
  },
  {
    key: "grain",
    label: "inspector.grade.detail.grain",
    min: 0,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
  {
    key: "grainSize",
    label: "inspector.grade.detail.grainSize",
    min: 0,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
    defaultValue: 25,
  },
  {
    key: "grainRoughness",
    label: "inspector.grade.detail.grainRoughness",
    min: 0,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
    defaultValue: 50,
  },
];

export const EFFECT_SLIDERS: Array<{
  key: HfColorGradingEffectKey;
  label: TranslationKey;
  min: number;
  max: number;
  step: number;
  scale: number;
  suffix: string;
}> = [
  {
    key: "blur",
    label: "inspector.grade.effect.blur",
    min: 0,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
  {
    key: "pixelate",
    label: "inspector.grade.effect.pixelate",
    min: 0,
    max: 100,
    step: 1,
    scale: 100,
    suffix: "%",
  },
];

export const AMOUNT_DETAIL_SLIDERS = COLOR_GRADING_DETAIL_SLIDERS.filter(
  (slider) => slider.key === "vignette" || slider.key === "grain",
);
export const VIGNETTE_TUNE_SLIDERS = COLOR_GRADING_DETAIL_SLIDERS.filter(
  (slider) =>
    slider.key === "vignetteMidpoint" ||
    slider.key === "vignetteRoundness" ||
    slider.key === "vignetteFeather",
);
export const GRAIN_TUNE_SLIDERS = COLOR_GRADING_DETAIL_SLIDERS.filter(
  (slider) => slider.key === "grainSize" || slider.key === "grainRoughness",
);

export function normalizedColorGradingDefault(slider: {
  defaultValue?: number;
  scale: number;
}): number {
  return (slider.defaultValue ?? 0) / slider.scale;
}
