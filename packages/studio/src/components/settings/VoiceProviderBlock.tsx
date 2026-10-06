import { useEffect, useId, useState } from "react";
import type {
  UpdateVoiceProviderRequest,
  VoiceModelInfo,
  VoiceProviderInfo,
} from "@hyperframes/agent-protocol";
import { VOICE_LIMITS } from "@hyperframes/agent-protocol";
import { Badge, Input, Select, cn } from "../ui";
import { useTranslation } from "../../i18n";
import { ExternalLink } from "../../research/researchUi";
import { useVoiceClient, useVoiceStore, useVoiceStoreApi } from "../../voice/voiceContext";
import { modelOptionLabel } from "../../voice/voiceLabels";
import { VoiceKeyControl } from "../../voice/VoiceKeyControl";
import { VoiceProviderNotes } from "../../voice/VoiceProviderNotes";

/** Where a user gets their own key for each service. */
const KEY_URLS: Record<string, string> = {
  gemini: "https://aistudio.google.com/apikey",
  openai: "https://platform.openai.com/api-keys",
  openrouter: "https://openrouter.ai/keys",
  elevenlabs: "https://elevenlabs.io/app/settings/api-keys",
};

type TextField = "model" | "voice";

function patchOf(field: TextField, value: string): UpdateVoiceProviderRequest {
  return field === "model" ? { model: value } : { voice: value };
}

/** One saved text field of a provider (the custom server's address, model and voice); a refusal shows under it. */
function ProviderTextField({
  provider,
  field,
  label,
  hint,
  placeholder,
}: {
  provider: VoiceProviderInfo;
  field: TextField;
  label: string;
  hint?: string;
  placeholder?: string;
}) {
  const store = useVoiceStoreApi();
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  const value = provider[field];
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium text-fg-2">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        size="md"
        placeholder={placeholder}
        spellCheck={false}
        invalid={problem !== null}
        maxLength={field === "model" ? VOICE_LIMITS.modelChars : VOICE_LIMITS.voiceIdChars}
        onCommit={(next) => {
          setProblem(null);
          void store
            .getState()
            .updateProvider(provider.id, patchOf(field, next.trim()))
            .then((failure) => setProblem(failure));
        }}
      />
      {problem !== null ? (
        <p role="alert" className="m-0 text-xs text-error">
          {problem}
        </p>
      ) : hint ? (
        <p className="m-0 text-xs leading-[15px] text-fg-3">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * The custom server's address, read-only: it is set in OpenVids Settings on the Projects page. Composition code shares
 * Studio's origin and could point the key at another address, so Studio never writes it.
 */
function CustomAddress({ provider }: { provider: VoiceProviderInfo }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="grid gap-1" data-testid="voice-custom-address">
      <span id={id} className="text-xs font-medium text-fg-2">
        {t("voice.settings.custom.address")}
      </span>
      <div
        aria-labelledby={id}
        className="min-h-ctl truncate rounded-md border border-border-subtle bg-bg-0 px-2.5 py-[5px] font-mono text-sm leading-4 text-fg-2 select-text"
      >
        {provider.baseUrl === "" ? t("voice.settings.custom.addressEmpty") : provider.baseUrl}
      </div>
      <p className="m-0 text-xs leading-[15px] text-fg-3">
        {t("voice.settings.custom.addressNote")}
      </p>
    </div>
  );
}

/** "Rules for the agent": the user's own rules, saved when the field loses focus; they win over the model's guidance. */
function AgentRules({ provider }: { provider: VoiceProviderInfo }) {
  const { t } = useTranslation();
  const store = useVoiceStoreApi();
  const id = useId();
  const [rules, setRules] = useState(provider.agentRules);
  const [status, setStatus] = useState<"idle" | "saved" | string>("idle");
  useEffect(() => setRules(provider.agentRules), [provider.agentRules]);

  const commit = async () => {
    if (rules === provider.agentRules) return;
    const failure = await store.getState().updateProvider(provider.id, { agentRules: rules });
    setStatus(failure ?? "saved");
  };

  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium text-fg-2">
        {t("voice.settings.rules")}
      </label>
      <textarea
        id={id}
        value={rules}
        rows={3}
        maxLength={VOICE_LIMITS.agentRulesChars}
        placeholder={t("voice.settings.rules.placeholder")}
        onChange={(event) => {
          setRules(event.target.value);
          setStatus("idle");
        }}
        onBlur={() => void commit()}
        className={cn(
          "min-h-16 w-full resize-y rounded-md border border-border bg-bg-0 px-2.5 py-1.5 text-sm leading-4 text-fg outline-hidden",
          "placeholder:text-fg-3 hover:border-border-strong",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        )}
      />
      <p className="m-0 text-xs leading-[15px] text-fg-3" aria-live="polite">
        {status === "saved" ? (
          t("voice.settings.rules.saved")
        ) : status !== "idle" ? (
          <span role="alert" className="text-error">
            {status}
          </span>
        ) : (
          t("voice.settings.rules.hint")
        )}
      </p>
    </div>
  );
}

/** The provider's models, for the picker; null until they are read (or when the provider cannot list them yet). */
function useProviderModels(provider: VoiceProviderInfo): VoiceModelInfo[] | null {
  const client = useVoiceClient();
  const [models, setModels] = useState<VoiceModelInfo[] | null>(null);
  const ready = provider.configured;
  useEffect(() => {
    if (!ready) return setModels(null);
    const controller = new AbortController();
    client
      .controls(provider.id, undefined, controller.signal)
      .then((controls) => {
        if (!controller.signal.aborted) setModels(controls.models);
      })
      .catch(() => {
        if (!controller.signal.aborted) setModels(null);
      });
    return () => controller.abort();
  }, [client, provider.id, ready, provider.hasKey]);
  return models;
}

function ModelPicker({ provider }: { provider: VoiceProviderInfo }) {
  const { t } = useTranslation();
  const store = useVoiceStoreApi();
  const pending = useVoiceStore((state) => state.pending);
  const models = useProviderModels(provider);
  const [problem, setProblem] = useState<string | null>(null);
  if (models === null || models.length === 0) return null;
  const options = models.map((model) => ({ value: model.id, label: modelOptionLabel(model) }));
  // A model the user's file names that the provider no longer lists stays visible instead of vanishing.
  if (!options.some((option) => option.value === provider.model))
    options.unshift({ value: provider.model, label: provider.model });
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-fg-2">{t("voice.settings.model")}</span>
      <Select
        label={t("voice.settings.modelAria", { name: provider.name })}
        size="md"
        value={provider.model}
        options={options}
        disabled={pending === `provider:${provider.id}`}
        onCommit={(model) => {
          setProblem(null);
          void store
            .getState()
            .updateProvider(provider.id, { model })
            .then((failure) => setProblem(failure));
        }}
      />
      {problem !== null && (
        <p role="alert" className="m-0 text-xs text-error">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * One provider of Settings › Voice: its state, the key (save, check, replace, remove), the model, the notes the
 * service needs shown (free-tier terms), and "Rules for the agent". The custom server also takes its address, model
 * id and voice name, and its key is optional.
 */
export function VoiceProviderBlock({ provider }: { provider: VoiceProviderInfo }) {
  const { t } = useTranslation();
  const custom = provider.id === "custom";
  const keyUrl = KEY_URLS[provider.id];
  return (
    <div
      data-voice-provider={provider.id}
      className="grid gap-2.5 border-border-subtle px-3 py-3 not-first:border-t"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-base font-medium leading-4 text-fg">
          {provider.name}
        </span>
        <Badge tone={provider.configured ? "success" : "neutral"} size="sm">
          {provider.configured ? t("voice.settings.ready") : t("voice.settings.notSet")}
        </Badge>
        {keyUrl && (
          <span className="ml-auto text-xs">
            <ExternalLink href={keyUrl}>{t("voice.settings.getKey")}</ExternalLink>
          </span>
        )}
      </div>
      {custom && (
        <>
          <p className="m-0 text-xs leading-[15px] text-fg-3">{t("voice.settings.custom.lede")}</p>
          <CustomAddress provider={provider} />
        </>
      )}
      <VoiceKeyControl provider={provider} />
      {custom && (
        <>
          <ProviderTextField
            provider={provider}
            field="model"
            label={t("voice.settings.custom.model")}
            placeholder="kokoro"
          />
          <ProviderTextField
            provider={provider}
            field="voice"
            label={t("voice.settings.custom.voice")}
            placeholder="af_heart"
            hint={t("voice.settings.custom.voiceHint")}
          />
        </>
      )}
      <VoiceProviderNotes provider={provider} />
      {!custom && <ModelPicker provider={provider} />}
      <AgentRules provider={provider} />
    </div>
  );
}
