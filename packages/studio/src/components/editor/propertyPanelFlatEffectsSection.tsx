import { useEffect, useState } from "react";
import {
  HF_COLOR_GRADING_EFFECT_APPLY_DEFAULTS,
  HF_COLOR_GRADING_EFFECT_PRESETS,
  HF_COLOR_GRADING_PALETTES,
  normalizeHfColorGrading,
  type HfColorGradingActiveEffectKey,
  type HfColorGradingEffectKey,
  type NormalizedHfColorGrading,
} from "@hyperframes/core/color-grading";
import { Plus, RotateCcw, X } from "../../icons/SystemIcons";
import { CaretDown } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import { INSP_MINI_BUTTON, inspPreviewCard } from "./inspectorStyles";
import { FlatSlider } from "./propertyPanelFlatPrimitives";
import type {
  ColorGradingPresetPreviews,
  ColorGradingPreviewOptions,
} from "./useColorGradingController";
import {
  DEFAULT_EFFECTS,
  EFFECT_GROUPS,
  EFFECT_SPECS,
  type EffectControl,
  type EffectSpec,
} from "./propertyPanelFlatEffectSpecs";
import { FlatEffectControl } from "./propertyPanelFlatEffectControl";
import { presetPreviewHandlers } from "./propertyPanelPresetPreview";

export function activeColorGradingEffectCount(grading: NormalizedHfColorGrading): number {
  return EFFECT_SPECS.filter((effect) => grading.effects[effect.key] > 0.0001).length;
}

export function FlatEffectsAccessory({
  grading,
  onCommitColorGrading,
}: {
  grading: NormalizedHfColorGrading;
  onCommitColorGrading: (next: NormalizedHfColorGrading) => void;
}) {
  if (!activeColorGradingEffectCount(grading)) return null;
  return (
    <button
      type="button"
      data-flat-effects-reset="true"
      title="Reset effects"
      onClick={(event) => {
        event.stopPropagation();
        onCommitColorGrading({ ...grading, effects: { ...DEFAULT_EFFECTS }, palette: null });
      }}
      className={INSP_MINI_BUTTON}
    >
      <RotateCcw size={12} />
    </button>
  );
}

export function FlatEffectsSection({
  grading,
  previews,
  presetPreviews,
  onCommitColorGrading,
  onPreviewColorGrading,
  onRequestEffectPreviews,
  onRequestPresetPreviews,
}: {
  grading: NormalizedHfColorGrading;
  previews: ColorGradingPresetPreviews;
  presetPreviews: ColorGradingPresetPreviews;
  onCommitColorGrading: (next: NormalizedHfColorGrading) => void;
  onPreviewColorGrading: (
    next: NormalizedHfColorGrading | null,
    options?: ColorGradingPreviewOptions,
  ) => void;
  onRequestEffectPreviews: (effects: readonly HfColorGradingActiveEffectKey[]) => void;
  onRequestPresetPreviews: () => void;
}) {
  const activeEffects = EFFECT_SPECS.filter((effect) => grading.effects[effect.key] > 0.0001);
  const [catalogOpen, setCatalogOpen] = useState(activeEffects.length === 0);
  const [catalogGroup, setCatalogGroup] = useState(EFFECT_GROUPS[0].label);
  const [selectedKey, setSelectedKey] = useState<HfColorGradingActiveEffectKey | null>(
    activeEffects[0]?.key ?? null,
  );
  const selectedEffect =
    activeEffects.find((effect) => effect.key === selectedKey) ?? activeEffects[0] ?? null;

  useEffect(() => {
    if (!catalogOpen) return;
    const group = EFFECT_GROUPS.find((candidate) => candidate.label === catalogGroup);
    if (!group) return;
    const effectKeys = group.effects.map((effect) => effect.key);
    if (previews.status !== "loading" && effectKeys.some((effect) => !previews.images[effect])) {
      onRequestEffectPreviews(effectKeys);
    }
    if (
      group.presets?.some((preset) => !presetPreviews.images[preset]) &&
      presetPreviews.status !== "loading"
    ) {
      onRequestPresetPreviews();
    }
  }, [
    catalogGroup,
    catalogOpen,
    onRequestEffectPreviews,
    onRequestPresetPreviews,
    presetPreviews.images,
    presetPreviews.status,
    previews.images,
    previews.status,
  ]);
  useEffect(() => () => onPreviewColorGrading(null), [onPreviewColorGrading]);

  const commitEffects = (effects: NormalizedHfColorGrading["effects"]) => {
    onCommitColorGrading({
      ...grading,
      effects,
    });
  };
  const commitEffect = (key: HfColorGradingEffectKey, value: number) => {
    commitEffects({ ...grading.effects, [key]: value });
  };
  const resolveEffect = (effect: EffectSpec): NormalizedHfColorGrading => ({
    ...grading,
    effects: {
      ...grading.effects,
      ...HF_COLOR_GRADING_EFFECT_APPLY_DEFAULTS[effect.key],
    },
  });
  const applyEffect = (effect: EffectSpec) => {
    onCommitColorGrading(resolveEffect(effect));
    setSelectedKey(effect.key);
    setCatalogOpen(false);
  };
  const resolvePreset = (presetId: string) =>
    normalizeHfColorGrading({ preset: presetId, lut: grading.lut }) ?? grading;
  const removeEffect = (effect: EffectSpec) => {
    commitEffect(effect.key, 0);
    setSelectedKey(null);
  };

  const renderPalette = (kind: "mono" | "art") => {
    const fallback = kind === "art" ? ["#1a1a1a", "#f5f5dc"] : ["#000000", "#ffffff"];
    const palette = grading.palette;
    return (
      <div data-flat-effects-palette="true" className="grid gap-1.5 pt-0.5">
        <div className="grid grid-cols-4 gap-1">
          {HF_COLOR_GRADING_PALETTES.map((preset) => {
            const selected =
              palette?.length === preset.colors.length &&
              palette.every((color, index) => color === preset.colors[index]);
            return (
              <button
                key={preset.id}
                type="button"
                title={`${preset.group}: ${preset.label}`}
                data-flat-effects-palette-preset={preset.id}
                aria-pressed={selected}
                onClick={() => {
                  onCommitColorGrading({ ...grading, palette: [...preset.colors] });
                }}
                className={`grid min-w-0 gap-0.5 rounded-xs border bg-surface-1 p-0.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                  selected
                    ? "border-accent text-fg shadow-[inset_0_0_0_1px_var(--color-accent)]"
                    : "border-border-subtle text-fg-2 hover:border-border-strong hover:text-fg"
                }`}
              >
                <span className="flex h-3 overflow-hidden rounded-[2px]">
                  {preset.colors.map((color) => (
                    <span key={color} className="flex-1" style={{ backgroundColor: color }} />
                  ))}
                </span>
                <span className="block truncate px-0.5 text-2xs leading-3">{preset.label}</span>
              </button>
            );
          })}
        </div>
        {!palette ? (
          <Button
            size="sm"
            data-flat-effects-add-palette="true"
            className="justify-self-start"
            icon={<Plus size={12} />}
            onClick={() => {
              onCommitColorGrading({ ...grading, palette: fallback });
            }}
          >
            Custom palette
          </Button>
        ) : (
          <>
            <div className="flex min-h-6 items-center justify-between">
              <span className="text-sm text-fg-3">Custom palette</span>
              <button
                type="button"
                title="Use default palette"
                aria-label="Use default palette"
                onClick={() => onCommitColorGrading({ ...grading, palette: null })}
                className={INSP_MINI_BUTTON}
              >
                <RotateCcw size={12} />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {palette.map((color, index) => (
                <span key={`${index}-${color}`} className="group/swatch relative">
                  <input
                    type="color"
                    aria-label={`Palette color ${index + 1}`}
                    value={color}
                    onChange={(event) => {
                      const nextPalette = [...palette];
                      nextPalette[index] = event.target.value;
                      onCommitColorGrading({ ...grading, palette: nextPalette });
                    }}
                    className="size-[22px] cursor-pointer rounded-xs border border-border bg-transparent p-0 transition-transform hover:scale-105 hover:border-fg-2"
                  />
                  {palette.length > 2 && (
                    <button
                      type="button"
                      aria-label={`Remove palette color ${index + 1}`}
                      onClick={() =>
                        onCommitColorGrading({
                          ...grading,
                          palette: palette.filter((_, colorIndex) => colorIndex !== index),
                        })
                      }
                      className="absolute -right-1 -top-1 hidden size-3.5 items-center justify-center rounded-full border border-border bg-bg-1 text-fg-2 shadow-raise group-hover/swatch:flex"
                    >
                      <X size={8} />
                    </button>
                  )}
                </span>
              ))}
              {palette.length < 6 && (
                <button
                  type="button"
                  aria-label="Add palette color"
                  onClick={() =>
                    onCommitColorGrading({
                      ...grading,
                      palette: [...palette, palette.at(-1) ?? "#ffffff"],
                    })
                  }
                  className="flex size-[22px] items-center justify-center rounded-xs border border-dashed border-border text-fg-3 hover:border-border-strong hover:text-fg"
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="grid gap-1.5" data-flat-effects-section="true">
      {activeEffects.length > 0 && (
        <div data-flat-effects-active-list="true" className="grid gap-1">
          {activeEffects.map((effect) => {
            const selected = selectedEffect?.key === effect.key;
            return (
              <button
                key={effect.key}
                type="button"
                data-flat-effect-active={effect.key}
                aria-pressed={selected}
                onClick={() => setSelectedKey(effect.key)}
                className={`flex min-h-[30px] w-full items-center gap-1.5 rounded-sm border bg-bg-1 px-2 text-left text-sm text-fg transition-colors focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent ${
                  selected ? "border-border-strong" : "border-border hover:bg-surface-1"
                }`}
              >
                <CaretDown
                  size={12}
                  aria-hidden="true"
                  className={`shrink-0 text-fg-3 transition-transform ${selected ? "" : "-rotate-90"}`}
                />
                <span className="min-w-0 flex-1 truncate">{effect.label}</span>
                <span className="font-mono text-num text-fg-3">
                  {effect.masterFormat?.(grading.effects[effect.key]) ??
                    `${Math.round(grading.effects[effect.key] * 100)}%`}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {selectedEffect && (
        <div
          data-flat-effect-editor={selectedEffect.key}
          className="grid gap-1.5 rounded-sm border border-border bg-bg-1 p-2"
        >
          <div className="flex min-h-6 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-fg">
              {selectedEffect.label}
            </span>
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                title={`Reset ${selectedEffect.label}`}
                aria-label={`Reset ${selectedEffect.label}`}
                onClick={() => applyEffect(selectedEffect)}
                className={INSP_MINI_BUTTON}
              >
                <RotateCcw size={12} />
              </button>
              <button
                type="button"
                title={`Remove ${selectedEffect.label}`}
                aria-label={`Remove ${selectedEffect.label}`}
                onClick={() => removeEffect(selectedEffect)}
                className={`${INSP_MINI_BUTTON} hover:text-error`}
              >
                <X size={12} />
              </button>
            </span>
          </div>
          {selectedEffect.showMaster !== false && (
            <FlatSlider
              label={selectedEffect.masterLabel ?? "Mix"}
              value={grading.effects[selectedEffect.key] * 100}
              min={0}
              max={selectedEffect.max ?? 100}
              tier="explicitCustom"
              displayValue={
                selectedEffect.masterFormat?.(grading.effects[selectedEffect.key]) ??
                `${Math.round(grading.effects[selectedEffect.key] * 100)}%`
              }
              onCommit={(next) => commitEffect(selectedEffect.key, next / 100)}
              onReset={() =>
                commitEffect(
                  selectedEffect.key,
                  HF_COLOR_GRADING_EFFECT_APPLY_DEFAULTS[selectedEffect.key][selectedEffect.key] ??
                    1,
                )
              }
            />
          )}
          {selectedEffect.settings?.map((control: EffectControl) => (
            <FlatEffectControl
              key={control.key}
              control={control}
              effect={selectedEffect}
              effects={grading.effects}
              onCommit={commitEffect}
            />
          ))}
          {selectedEffect.palette && renderPalette(selectedEffect.palette)}
        </div>
      )}

      <Button
        size="sm"
        data-flat-effects-add-toggle="true"
        className="justify-self-start aria-expanded:border-border-strong aria-expanded:bg-surface-3"
        aria-expanded={catalogOpen}
        icon={<Plus size={12} />}
        onClick={() => setCatalogOpen((open) => !open)}
      >
        Add effect
      </Button>

      {catalogOpen && (
        <div data-flat-effects-catalog="true" className="grid gap-1.5">
          <div role="tablist" aria-label="Effect families" className="flex flex-wrap gap-0.5">
            {EFFECT_GROUPS.map((group) => {
              const activeInGroup = group.effects.filter(
                (effect) => grading.effects[effect.key] > 0.0001,
              ).length;
              return (
                <button
                  key={group.label}
                  type="button"
                  role="tab"
                  aria-selected={catalogGroup === group.label}
                  data-flat-effect-group={group.label}
                  onClick={() => setCatalogGroup(group.label)}
                  className={`inline-flex h-[22px] min-w-0 items-center rounded-sm px-2 text-xs transition-colors focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent ${
                    catalogGroup === group.label
                      ? "bg-surface-2 text-fg hover:bg-surface-3"
                      : "text-fg-3 hover:bg-surface-1 hover:text-fg"
                  }`}
                >
                  <span className="truncate">{group.label}</span>
                  {activeInGroup > 0 && (
                    <span className="ml-1 rounded-pill bg-surface-3 px-[5px] text-2xs leading-[14px] text-fg">
                      {activeInGroup}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {EFFECT_GROUPS.filter((group) => group.label === catalogGroup).map((group) => (
            <section key={group.label} className="grid gap-1" role="tabpanel">
              <div className="grid grid-cols-3 gap-1.5">
                {group.presets?.map((presetId) => {
                  const preset = HF_COLOR_GRADING_EFFECT_PRESETS.find(
                    (candidate) => candidate.id === presetId,
                  );
                  if (!preset) return null;
                  const selected = grading.preset === preset.id;
                  const preview = presetPreviews.images[preset.id];
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      data-flat-effect-preset={preset.id}
                      aria-pressed={selected}
                      {...presetPreviewHandlers({
                        id: preset.id,
                        label: preset.label,
                        resolve: () => resolvePreset(preset.id),
                        onPreview: onPreviewColorGrading,
                        onCommit: onCommitColorGrading,
                      })}
                      className={inspPreviewCard(selected)}
                    >
                      <span
                        className="flex w-full items-center justify-center overflow-hidden bg-bg-1"
                        style={{
                          aspectRatio: `${presetPreviews.width} / ${presetPreviews.height}`,
                        }}
                      >
                        {preview ? (
                          <img
                            data-flat-effect-preset-preview={preset.id}
                            src={preview}
                            alt=""
                            draggable={false}
                            className="block h-full w-full object-cover"
                          />
                        ) : (
                          <span
                            data-flat-effect-preset-placeholder={presetPreviews.status}
                            className="h-full w-full bg-surface-1"
                          />
                        )}
                      </span>
                      <span className="block truncate px-[5px] pt-[3px] pb-1 text-2xs leading-[13px]">
                        {preset.label}
                      </span>
                    </button>
                  );
                })}
                {group.effects.map((effect) => {
                  const active = grading.effects[effect.key] > 0.0001;
                  const preview = previews.images[effect.key];
                  return (
                    <button
                      key={effect.key}
                      type="button"
                      data-flat-effect-option={effect.key}
                      aria-pressed={active}
                      title={`Preview ${effect.label}`}
                      onPointerEnter={() =>
                        onPreviewColorGrading(resolveEffect(effect), {
                          animatedPreview: { kind: "effects", id: effect.key },
                        })
                      }
                      onPointerLeave={() => onPreviewColorGrading(null)}
                      onFocus={() => onPreviewColorGrading(resolveEffect(effect))}
                      onBlur={() => onPreviewColorGrading(null)}
                      onClick={() => {
                        if (active) {
                          setSelectedKey(effect.key);
                          setCatalogOpen(false);
                        } else {
                          applyEffect(effect);
                        }
                      }}
                      className={inspPreviewCard(active)}
                    >
                      <span
                        data-flat-effect-preview-frame={effect.key}
                        className="flex w-full items-center justify-center overflow-hidden bg-bg-1"
                        style={{ aspectRatio: `${previews.width} / ${previews.height}` }}
                      >
                        {preview ? (
                          <img
                            data-flat-effect-preview={effect.key}
                            src={preview}
                            alt=""
                            draggable={false}
                            className="block h-full w-full object-cover"
                          />
                        ) : (
                          <span
                            data-flat-effect-preview-placeholder={previews.status}
                            className="h-full w-full bg-surface-1"
                          />
                        )}
                      </span>
                      <span className="block truncate px-[5px] pt-[3px] pb-1 text-2xs leading-[13px]">
                        {effect.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
