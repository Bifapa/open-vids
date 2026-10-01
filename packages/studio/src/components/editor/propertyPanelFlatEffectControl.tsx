import {
  HF_COLOR_GRADING_EFFECT_APPLY_DEFAULTS,
  type HfColorGradingEffectKey,
  type NormalizedHfColorGrading,
} from "@hyperframes/core/color-grading";
import { useTranslation } from "../../i18n";
import { FlatSelectRow } from "./propertyPanelFlatSelectRow";
import { FlatSlider } from "./propertyPanelFlatPrimitives";
import { FlatToggle } from "./propertyPanelFlatToggle";
import {
  DEFAULT_EFFECTS,
  type EffectControl,
  type EffectSpec,
} from "./propertyPanelFlatEffectSpecs";

type CommitEffect = (key: HfColorGradingEffectKey, value: number) => void;

function defaultValueFor(control: EffectControl, effect: EffectSpec): number {
  return (
    HF_COLOR_GRADING_EFFECT_APPLY_DEFAULTS[effect.key][control.key] ?? DEFAULT_EFFECTS[control.key]
  );
}

function EffectSliderControl({
  control,
  value,
  defaultValue,
  onCommit,
}: {
  control: Extract<EffectControl, { kind: "slider" }>;
  value: number;
  defaultValue: number;
  onCommit: CommitEffect;
}) {
  const { t } = useTranslation();
  const scale = control.scale ?? 100;
  const sliderValue = value * scale;
  const displayValue = control.format
    ? control.format(value)
    : `${Number.isInteger(sliderValue) ? sliderValue : sliderValue.toFixed(1)}${control.unit ?? "%"}`;
  return (
    <FlatSlider
      label={t(control.label)}
      value={sliderValue}
      min={control.min ?? 0}
      max={control.max ?? 100}
      step={control.step ?? 1}
      tier={Math.abs(value - defaultValue) > 0.0001 ? "explicitCustom" : "default"}
      displayValue={displayValue}
      onCommit={(next) => onCommit(control.key, next / scale)}
      onReset={() => onCommit(control.key, defaultValue)}
    />
  );
}

export function FlatEffectControl({
  control,
  effect,
  effects,
  onCommit,
}: {
  control: EffectControl;
  effect: EffectSpec;
  effects: NormalizedHfColorGrading["effects"];
  onCommit: CommitEffect;
}) {
  const { t } = useTranslation();
  const value = effects[control.key];
  const defaultValue = defaultValueFor(control, effect);
  if (control.kind === "toggle") {
    return (
      <FlatToggle
        label={t(control.label)}
        checked={value >= 0.5}
        onChange={(next) => onCommit(control.key, next ? 1 : 0)}
      />
    );
  }
  if (control.kind === "select") {
    return (
      <FlatSelectRow
        label={t(control.label)}
        value={String(Math.round(value))}
        options={control.options.map((option) => ({ value: option.value, label: t(option.label) }))}
        tier={value === defaultValue ? "default" : "explicitCustom"}
        onChange={(next) => onCommit(control.key, Number.parseInt(next, 10))}
        onReset={() => onCommit(control.key, defaultValue)}
      />
    );
  }
  return (
    <EffectSliderControl
      control={control}
      value={value}
      defaultValue={defaultValue}
      onCommit={onCommit}
    />
  );
}
