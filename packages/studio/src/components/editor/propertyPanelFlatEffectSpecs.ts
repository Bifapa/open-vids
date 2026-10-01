import {
  getHfColorGradingCapabilities,
  normalizeHfColorGrading,
  type HfColorGradingActiveEffectKey,
  type HfColorGradingEffectKey,
  type HfColorGradingPresetId,
} from "@hyperframes/core/color-grading";
import type { TranslationKey } from "../../i18n";

type SliderControl = {
  kind: "slider";
  key: HfColorGradingEffectKey;
  label: TranslationKey;
  min?: number;
  max?: number;
  step?: number;
  scale?: number;
  unit?: string;
  format?: (value: number) => string;
};

export type EffectControl =
  | SliderControl
  | { kind: "toggle"; key: HfColorGradingEffectKey; label: TranslationKey }
  | {
      kind: "select";
      key: HfColorGradingEffectKey;
      label: TranslationKey;
      options: Array<{ value: string; label: TranslationKey }>;
    };

export type EffectSpec = {
  key: HfColorGradingActiveEffectKey;
  label: TranslationKey;
  showMaster?: false;
  masterLabel?: TranslationKey;
  masterFormat?: (value: number) => string;
  max?: number;
  settings?: readonly EffectControl[];
  palette?: "mono" | "art";
};

type EffectGroup = {
  /** Stable DOM id (`data-flat-effect-group`); the visible name is `label`. */
  id: string;
  label: TranslationKey;
  effects: readonly EffectSpec[];
  presets?: readonly HfColorGradingPresetId[];
};

const EFFECT_CONTROL_LIMITS = new Map(
  getHfColorGradingCapabilities().effects.flatMap((effect) =>
    effect.controls.map((control) => [control.key, control] as const),
  ),
);

function controlRange(key: HfColorGradingEffectKey, scale: number) {
  const control = EFFECT_CONTROL_LIMITS.get(key);
  return control ? { min: control.min * scale, max: control.max * scale, scale } : { scale };
}

const percent = (key: HfColorGradingEffectKey, label: TranslationKey): SliderControl => ({
  kind: "slider",
  key,
  label,
  ...controlRange(key, 100),
});

const degrees = (
  key: HfColorGradingEffectKey,
  label: TranslationKey,
  max: number,
): SliderControl => ({
  kind: "slider",
  key,
  label,
  ...controlRange(key, max),
  unit: "deg",
});

function enumOptions(key: HfColorGradingEffectKey, labels: readonly TranslationKey[]) {
  const control = EFFECT_CONTROL_LIMITS.get(key);
  const first = control?.min ?? 0;
  const count = (control?.max ?? labels.length - 1) - first + 1;
  if (labels.length !== count) throw new Error(`${key} labels do not match Core capabilities`);
  return labels.map((label, index) => ({ value: String(first + index), label }));
}

const ASCII_STYLES = enumOptions("asciiStyle", [
  "inspector.effects.ascii.standard",
  "inspector.effects.ascii.dense",
  "inspector.effects.ascii.minimal",
  "inspector.effects.ascii.blocks",
  "inspector.effects.ascii.braille",
  "inspector.effects.ascii.technical",
  "inspector.effects.ascii.matrix",
  "inspector.effects.ascii.hatching",
]);

const SCREEN_SHAPES = enumOptions("monoScreenShape", [
  "inspector.effects.shape.circle",
  "inspector.effects.shape.square",
  "inspector.effects.shape.diamond",
  "inspector.effects.shape.triangle",
  "inspector.effects.shape.line",
]);

export const EFFECT_GROUPS: readonly EffectGroup[] = [
  {
    id: "Essentials",
    label: "inspector.effects.group.essentials",
    effects: [
      {
        key: "blur",
        label: "inspector.effects.effect.blur",
        masterLabel: "inspector.effects.master.blur",
        masterFormat: (value) => `${(0.75 + Math.pow(value, 1.35) * 32).toFixed(1)}px`,
      },
      {
        key: "pixelate",
        label: "inspector.effects.effect.pixelate",
        masterLabel: "inspector.effects.master.pixelate",
        masterFormat: (value) => `${Math.round(1 + value * 47)}px`,
      },
      {
        key: "bloom",
        label: "inspector.effects.effect.bloom",
        masterLabel: "inspector.effects.master.bloom",
        max: controlRange("bloom", 100).max,
        settings: [
          {
            kind: "slider",
            key: "bloomRadius",
            label: "inspector.effects.control.bloomRadius",
            ...controlRange("bloomRadius", 1),
            unit: "px",
          },
        ],
      },
    ],
  },
  {
    id: "Retro & Glitch",
    label: "inspector.effects.group.retroGlitch",
    presets: ["creator-camcorder", "vhs-playback", "home-movie-8mm"],
    effects: [
      {
        key: "chromaBleed",
        label: "inspector.effects.effect.chromaBleed",
        masterLabel: "inspector.effects.master.chromaBleed",
      },
      {
        key: "tapeDamage",
        label: "inspector.effects.effect.tapeDamage",
        showMaster: false,
        settings: [
          percent("tapeTracking", "inspector.effects.control.tapeTracking"),
          percent("tapeNoise", "inspector.effects.control.tapeNoise"),
          percent("tapeSpeed", "inspector.effects.control.tapeSpeed"),
        ],
      },
      {
        key: "filmArtifacts",
        label: "inspector.effects.effect.filmArtifacts",
        masterLabel: "inspector.effects.master.filmArtifacts",
      },
      {
        key: "scanlines",
        label: "inspector.effects.effect.scanlines",
        masterLabel: "inspector.effects.master.scanlines",
        settings: [
          {
            ...percent("scanlineCount", "inspector.effects.control.scanlineCount"),
            format: (value) => `${Math.round(50 + value * 450)}`,
          },
          percent("scanlineSoftness", "inspector.effects.control.scanlineSoftness"),
        ],
      },
      {
        key: "crtCurvature",
        label: "inspector.effects.effect.crtCurvature",
        masterLabel: "inspector.effects.master.crtCurvature",
      },
      {
        key: "chromaticAberration",
        label: "inspector.effects.effect.chromaticAberration",
        masterLabel: "inspector.effects.master.chromaticAberration",
        settings: [degrees("chromaticAngle", "inspector.effects.control.chromaticAngle", 360)],
      },
      {
        key: "digitalGlitch",
        label: "inspector.effects.effect.digitalGlitch",
        showMaster: false,
        settings: [
          percent("digitalGlitchColorSplit", "inspector.effects.control.digitalGlitchColorSplit"),
          percent("digitalGlitchLineTear", "inspector.effects.control.digitalGlitchLineTear"),
          percent("digitalGlitchPixelate", "inspector.effects.control.digitalGlitchPixelate"),
          percent("digitalGlitchBlockAmount", "inspector.effects.control.digitalGlitchBlockAmount"),
          percent(
            "digitalGlitchBlockDisplacement",
            "inspector.effects.control.digitalGlitchBlockDisplacement",
          ),
          percent(
            "digitalGlitchBlockOpacity",
            "inspector.effects.control.digitalGlitchBlockOpacity",
          ),
          percent("digitalGlitchSpeed", "inspector.effects.control.digitalGlitchSpeed"),
        ],
      },
    ],
  },
  {
    id: "Print",
    label: "inspector.effects.group.print",
    presets: ["editorial-halftone", "two-ink-print"],
    effects: [
      {
        key: "halftone",
        label: "inspector.effects.effect.halftone",
        showMaster: false,
        settings: [percent("halftoneSize", "inspector.effects.control.halftoneSize")],
      },
      {
        key: "twoInkPrint",
        label: "inspector.effects.effect.twoInkPrint",
        showMaster: false,
        settings: [percent("twoInkPrintSize", "inspector.effects.control.twoInkPrintSize")],
      },
      {
        key: "dither",
        label: "inspector.effects.effect.dither",
        showMaster: false,
        palette: "mono",
        settings: [
          {
            ...percent("ditherSize", "inspector.effects.control.ditherSize"),
            format: (value) => `${(1 + value * 4).toFixed(1)}px`,
          },
        ],
      },
      {
        key: "monoScreen",
        label: "inspector.effects.effect.monoScreen",
        showMaster: false,
        palette: "mono",
        settings: [
          {
            ...percent("monoScreenSize", "inspector.effects.control.monoScreenSize"),
            format: (value) => `${Math.round(4 + value * 14)}px`,
          },
          degrees("monoScreenAngle", "inspector.effects.control.monoScreenAngle", 90),
          percent("monoScreenSpread", "inspector.effects.control.monoScreenSpread"),
          {
            kind: "select",
            key: "monoScreenShape",
            label: "inspector.effects.control.monoScreenShape",
            options: SCREEN_SHAPES,
          },
          {
            kind: "toggle",
            key: "monoScreenInvert",
            label: "inspector.effects.control.monoScreenInvert",
          },
        ],
      },
    ],
  },
  {
    id: "Art",
    label: "inspector.effects.group.art",
    effects: [
      {
        key: "ascii",
        label: "inspector.effects.effect.ascii",
        showMaster: false,
        palette: "mono",
        settings: [
          {
            ...percent("asciiSize", "inspector.effects.control.asciiSize"),
            format: (value) => `${Math.round(4 + value * 76)}px`,
          },
          {
            kind: "select",
            key: "asciiStyle",
            label: "inspector.effects.control.asciiStyle",
            options: ASCII_STYLES,
          },
          { kind: "toggle", key: "asciiInvert", label: "inspector.effects.control.asciiInvert" },
          { kind: "toggle", key: "asciiColor", label: "inspector.effects.control.asciiColor" },
          percent("asciiRotation", "inspector.effects.control.asciiRotation"),
        ],
      },
      {
        key: "engraving",
        label: "inspector.effects.effect.engraving",
        showMaster: false,
        palette: "art",
        settings: [
          percent("engravingSpacing", "inspector.effects.control.engravingSpacing"),
          percent("engravingMinThickness", "inspector.effects.control.engravingMinThickness"),
          percent("engravingMaxThickness", "inspector.effects.control.engravingMaxThickness"),
          degrees("engravingAngle", "inspector.effects.control.engravingAngle", 180),
          percent("engravingContrast", "inspector.effects.control.engravingContrast"),
          percent("engravingSharpness", "inspector.effects.control.engravingSharpness"),
          percent("engravingWave", "inspector.effects.control.engravingWave"),
          percent("engravingWaveFrequency", "inspector.effects.control.engravingWaveFrequency"),
        ],
      },
      {
        key: "crosshatch",
        label: "inspector.effects.effect.crosshatch",
        showMaster: false,
        palette: "art",
        settings: [
          percent("crosshatchSpacing", "inspector.effects.control.crosshatchSpacing"),
          percent("crosshatchThickness", "inspector.effects.control.crosshatchThickness"),
          degrees("crosshatchAngle", "inspector.effects.control.crosshatchAngle", 180),
          percent("crosshatchContrast", "inspector.effects.control.crosshatchContrast"),
          percent("crosshatchEdges", "inspector.effects.control.crosshatchEdges"),
          percent("crosshatchLineWeight", "inspector.effects.control.crosshatchLineWeight"),
          percent("crosshatchWave", "inspector.effects.control.crosshatchWave"),
          percent("crosshatchWaveFrequency", "inspector.effects.control.crosshatchWaveFrequency"),
        ],
      },
      {
        key: "kuwahara",
        label: "inspector.effects.effect.kuwahara",
        showMaster: false,
        settings: [
          {
            ...percent("kuwaharaRadius", "inspector.effects.control.kuwaharaRadius"),
            format: (value) => `${Math.round(2 + value * 14)}px`,
          },
          percent("kuwaharaSharpness", "inspector.effects.control.kuwaharaSharpness"),
          {
            ...percent("kuwaharaSaturation", "inspector.effects.control.kuwaharaSaturation"),
            format: (value) => `${Math.round(value * 200)}%`,
          },
        ],
      },
    ],
  },
];

export const EFFECT_SPECS = EFFECT_GROUPS.flatMap((group) => group.effects);
const DEFAULT_GRADING = normalizeHfColorGrading("neutral");
if (!DEFAULT_GRADING) throw new Error("Missing neutral color grading preset");
export const DEFAULT_EFFECTS = DEFAULT_GRADING.effects;
