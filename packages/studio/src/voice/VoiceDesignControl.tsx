import { useId, useState } from "react";
import { Check, Sparkle } from "@phosphor-icons/react";
import type {
  DesignVoiceResult,
  VoicePresetVoice,
  VoiceProviderId,
} from "@hyperframes/agent-protocol";
import { Button, Input, Select, cn } from "../components/ui";
import { useTranslation } from "../i18n";
import { useVoiceClient } from "./voiceContext";
import type { VoiceDesignControl as VoiceDesignControlSpec } from "./voiceDraft";
import { VoicePlayButton } from "./VoicePlayButton";

const ANY = "__any__";
const GENDERS = ["female", "male", "neutral"] as const;

/**
 * Voice design: describe the voice in a sentence or two (permanent traits go here, not in the style) and the provider
 * makes it and answers with an instant sample. The designed voice becomes the draft's voice; its description stays on
 * the preset so the voice can be made again when the provider has expired it.
 */
export function VoiceDesignControl({
  control,
  providerId,
  model,
  language,
  selectedId,
  onDesigned,
}: {
  control: VoiceDesignControlSpec;
  providerId: VoiceProviderId;
  model: string;
  language: string | null;
  selectedId: string | null;
  onDesigned: (voice: VoicePresetVoice) => void;
}) {
  const { t } = useTranslation();
  const client = useVoiceClient();
  const fieldId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [gender, setGender] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<DesignVoiceResult | null>(null);

  const design = async () => {
    const text = description.trim();
    if (text === "") return setProblem(t("voice.design.empty"));
    setBusy(true);
    setProblem(null);
    try {
      const result = await client.designVoice(providerId, {
        name: name.trim() || text.slice(0, 40),
        description: text,
        model,
        ...(language && { language }),
        ...(gender !== "" && { gender }),
      });
      setMade(result);
      onDesigned({
        id: result.voice.id,
        name: result.voice.name,
        kind: "designed",
        description: text,
        ...(result.voice.languages[0] && { language: result.voice.languages[0] }),
      });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : t("voice.design.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-1.5" data-voice-control="voice_design">
      <label htmlFor={fieldId} className="text-xs font-semibold text-fg-2">
        {t("voice.control.voice_design")}
      </label>
      <textarea
        id={fieldId}
        value={description}
        rows={3}
        maxLength={control.maxChars}
        placeholder={t("voice.design.placeholder")}
        onChange={(event) => {
          setDescription(event.target.value);
          if (problem) setProblem(null);
        }}
        className={cn(
          "min-h-16 w-full resize-y rounded-sm border border-border bg-surface-1 px-2 py-[5px] text-sm leading-4 text-fg outline-hidden",
          "placeholder:text-fg-disabled hover:border-border-strong",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        )}
      />
      <p className="m-0 text-xs leading-[15px] text-fg-3">{t("voice.design.hint")}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          value={name}
          aria-label={t("voice.design.name")}
          placeholder={t("voice.design.name")}
          maxLength={80}
          onCommit={setName}
          className="w-44"
        />
        <Select
          label={t("voice.design.gender")}
          value={gender === "" ? ANY : gender}
          options={[
            { value: ANY, label: t("voice.design.genderAny") },
            ...GENDERS.map((option) => ({ value: option, label: t(`voice.gender.${option}`) })),
          ]}
          onCommit={(next) => setGender(next === ANY ? "" : next)}
          className="w-32"
        />
        <Button
          size="sm"
          variant="secondary"
          icon={<Sparkle size={12} aria-hidden />}
          loading={busy}
          onClick={() => void design()}
        >
          {t("voice.design.make")}
        </Button>
      </div>
      {problem !== null && (
        <p role="alert" className="m-0 text-xs text-error">
          {problem}
        </p>
      )}
      {made !== null && (
        <div
          className="flex items-center gap-2 rounded-sm bg-surface-1 px-2 py-1.5 text-xs"
          data-testid="voice-designed"
        >
          {selectedId === made.voice.id && (
            <Check aria-hidden size={12} weight="bold" className="shrink-0 text-success" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium text-fg">{made.voice.name}</span>
          {made.sample !== null && (
            <VoicePlayButton
              soundKey={`design:${made.voice.id}`}
              label={t("voice.design.listen", { name: made.voice.name })}
              variant="text"
              size="xs"
              source={() => (made.sample === null ? null : { url: made.sample.url })}
            >
              {t("voice.design.listenShort")}
            </VoicePlayButton>
          )}
        </div>
      )}
    </div>
  );
}
