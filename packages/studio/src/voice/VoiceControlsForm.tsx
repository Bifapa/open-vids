import { useId, type ReactNode } from "react";
import type {
  VoiceControl,
  VoicePresetVoice,
  VoiceProviderControls,
} from "@hyperframes/agent-protocol";
import { Input, SegmentedControl, Select, Slider, Toggle, cn } from "../components/ui";
import { formatNumber, useTranslation } from "../i18n";
import { VoiceCatalogPicker } from "./VoiceCatalogPicker";
import { VoiceDesignControl } from "./VoiceDesignControl";
import {
  type SliderControl,
  type StyleControl,
  type ToggleControl,
  type VoiceDraft,
  type VoiceTextControl,
} from "./voiceDraft";
import { controlLabel } from "./voiceLabels";

/** The controls that choose the voice; the rest shape its delivery. */
function choosesVoice(control: VoiceControl): boolean {
  return (
    control.kind === "catalog" || control.kind === "voice_text" || control.kind === "voice_design"
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2" aria-label={title}>
      <h3 className="m-0 text-xs font-semibold uppercase tracking-[0.04em] text-fg-3">{title}</h3>
      {children}
    </section>
  );
}

function SliderRow({
  control,
  value,
  onChange,
}: {
  control: SliderControl;
  value: number;
  onChange: (next: number) => void;
}) {
  const { t } = useTranslation();
  const label = controlLabel(control.id);
  const shown = (number: number) => formatNumber(number, { maximumFractionDigits: 2 });
  const values = control.values;
  return (
    <div className="grid gap-1" data-voice-control={`slider:${control.id}`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-fg-2">{label}</span>
        <span className="tabular-nums text-fg-3">{shown(value)}</span>
      </div>
      {values === undefined ? (
        <Slider
          label={label}
          value={value}
          min={control.min}
          max={control.max}
          step={control.step}
          onCommit={onChange}
        />
      ) : values.length <= 5 ? (
        <SegmentedControl
          label={label}
          size="sm"
          value={String(value)}
          options={values.map((option) => ({ value: String(option), label: shown(option) }))}
          onChange={(next) => onChange(Number(next))}
        />
      ) : (
        <Select
          label={t("voice.slider.value", { name: label })}
          value={String(value)}
          options={values.map((option) => ({ value: String(option), label: shown(option) }))}
          onCommit={(next) => onChange(Number(next))}
        />
      )}
    </div>
  );
}

function ToggleRow({
  control,
  value,
  onChange,
}: {
  control: ToggleControl;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const label = controlLabel(control.id);
  return (
    <div
      className="flex items-center justify-between gap-3"
      data-voice-control={`toggle:${control.id}`}
    >
      <span className="text-sm text-fg">{label}</span>
      <Toggle label={label} checked={value} onCommit={onChange} />
    </div>
  );
}

function StyleField({
  control,
  value,
  onChange,
}: {
  control: StyleControl;
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const label = controlLabel(control.target);
  return (
    <div className="grid gap-1" data-voice-control={`style:${control.target}`}>
      <label
        htmlFor={id}
        className="flex items-baseline justify-between text-xs font-medium text-fg-2"
      >
        <span>{label}</span>
        <span className="tabular-nums font-normal text-fg-3">
          {value.length}/{control.maxChars}
        </span>
      </label>
      <textarea
        id={id}
        value={value}
        rows={2}
        maxLength={control.maxChars}
        placeholder={t(
          control.target === "style" ? "voice.style.placeholder" : "voice.instructions.placeholder",
        )}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "min-h-10 w-full resize-y rounded-sm border border-border bg-surface-1 px-2 py-[5px] text-sm leading-4 text-fg outline-hidden",
          "placeholder:text-fg-disabled hover:border-border-strong",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        )}
      />
    </div>
  );
}

function VoiceTextField({
  control,
  value,
  onChange,
}: {
  control: VoiceTextControl;
  value: string;
  onChange: (voice: VoicePresetVoice) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1" data-voice-control="voice_text">
      <span className="text-xs font-medium text-fg-2">{controlLabel("voice_text")}</span>
      <Input
        value={value}
        placeholder={t("voice.voiceText.placeholder")}
        aria-label={controlLabel("voice_text")}
        maxLength={control.maxChars}
        spellCheck={false}
        onCommit={(next) => {
          const name = next.trim();
          if (name !== "") onChange({ id: name, name, kind: "custom" });
        }}
      />
    </div>
  );
}

/**
 * The voice setup window's controls, drawn from what the provider's model says it can do (`VoiceProviderControls`):
 * a catalog, a voice name to type, voice design, sliders, switches and the style/instructions text. A capability the
 * provider does not have is not drawn at all: there are no disabled stand-ins. Labels come from `voice.control.<id>`
 * and `voice.filter.<id>` with a readable fallback, so a provider's new control needs a string, not a component.
 */
export function VoiceControlsForm({
  controls,
  draft,
  language,
  onVoice,
  onStyle,
  onSetting,
}: {
  controls: VoiceProviderControls;
  draft: VoiceDraft;
  language: string | null;
  onVoice: (voice: VoicePresetVoice) => void;
  onStyle: (style: string) => void;
  onSetting: (id: string, value: number | boolean) => void;
}) {
  const { t } = useTranslation();
  const providerId = controls.provider.id;
  const voiceControls = controls.controls.filter(choosesVoice);
  const deliveryControls = controls.controls.filter((control) => !choosesVoice(control));

  return (
    <div className="grid gap-4" data-testid="voice-controls">
      {voiceControls.length > 0 && (
        <Section title={t("voice.section.voice")}>
          {voiceControls.map((control) => {
            switch (control.kind) {
              case "catalog":
                return (
                  <VoiceCatalogPicker
                    key="catalog"
                    control={control}
                    providerId={providerId}
                    model={controls.model}
                    language={language}
                    selectedId={draft.voice?.id ?? null}
                    onSelect={onVoice}
                  />
                );
              case "voice_text":
                return (
                  <VoiceTextField
                    key="voice_text"
                    control={control}
                    value={draft.voice?.id ?? ""}
                    onChange={onVoice}
                  />
                );
              case "voice_design":
                return (
                  <VoiceDesignControl
                    key="voice_design"
                    control={control}
                    providerId={providerId}
                    model={controls.model}
                    language={language}
                    selectedId={draft.voice?.id ?? null}
                    onDesigned={onVoice}
                  />
                );
              default:
                return null;
            }
          })}
        </Section>
      )}
      {deliveryControls.length > 0 && (
        <Section title={t("voice.section.delivery")}>
          {deliveryControls.map((control) => {
            switch (control.kind) {
              case "style":
                return (
                  <StyleField
                    key={`style:${control.target}`}
                    control={control}
                    value={draft.style}
                    onChange={onStyle}
                  />
                );
              case "slider": {
                const value = draft.settings[control.id];
                return (
                  <SliderRow
                    key={`slider:${control.id}`}
                    control={control}
                    value={typeof value === "number" ? value : control.default}
                    onChange={(next) => onSetting(control.id, next)}
                  />
                );
              }
              case "toggle": {
                const value = draft.settings[control.id];
                return (
                  <ToggleRow
                    key={`toggle:${control.id}`}
                    control={control}
                    value={typeof value === "boolean" ? value : control.default}
                    onChange={(next) => onSetting(control.id, next)}
                  />
                );
              }
              default:
                return null;
            }
          })}
        </Section>
      )}
    </div>
  );
}
