import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CheckCircle, Key } from "@phosphor-icons/react";
import type { VoiceAudioRef, VoiceProviderInfo } from "@hyperframes/agent-protocol";
import { Button, cn, fieldBase, fieldText } from "../components/ui";
import { useTranslation } from "../i18n";
import { VoicePlayButton } from "./VoicePlayButton";
import { playVoiceSound } from "./voiceAudio";
import { useVoiceStore, useVoiceStoreApi } from "./voiceContext";

/** The outcome of the last "Check key": the sample it returned plays when the check finishes. */
type CheckOutcome = { ok: true; sample: VoiceAudioRef | null } | { ok: false; message: string };

/**
 * A provider's key line: a field to paste the key while there is none; "Key saved" with Check, Replace and Remove once
 * there is. The key goes to the server and never comes back: the provider only says whether one is saved. "Check key"
 * makes the provider say a short phrase with it and plays what came back, so a working key is heard, not assumed.
 * `onChecked` tells the chat's connect step that the key works.
 */
export function VoiceKeyControl({
  provider,
  onChecked,
  autoCheck = false,
}: {
  provider: VoiceProviderInfo;
  onChecked?: (sample: VoiceAudioRef | null) => void;
  /** Check the key as soon as it is saved (the connect step). */
  autoCheck?: boolean;
}) {
  const { t } = useTranslation();
  const store = useVoiceStoreApi();
  const pending = useVoiceStore((state) => state.pending);
  const [replacing, setReplacing] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  const [focusRequest, setFocusRequest] = useState<"field" | "replace" | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const keyWork = pending === `key:${provider.id}`;
  const checking = pending === `check:${provider.id}`;
  const editing = !provider.hasKey || replacing;

  useEffect(() => {
    if (focusRequest === "field") field.current?.focus();
    else if (focusRequest === "replace") replaceButton.current?.focus();
  }, [focusRequest]);

  const check = async () => {
    setOutcome(null);
    const checked = await store.getState().checkProvider(provider.id);
    if (!checked.ok) return setOutcome(checked);
    const sample = checked.result.sample;
    setOutcome({ ok: true, sample });
    onChecked?.(sample);
    if (sample) void playVoiceSound(`voice-key:${provider.id}`, sample.url);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (pending !== null) return;
    const key = draft.trim();
    if (!key) return setProblem(t("voice.key.empty"));
    setProblem(null);
    const failure = await store.getState().setApiKey(provider.id, key);
    if (failure !== null) return setProblem(failure);
    setDraft("");
    setReplacing(false);
    setOutcome(null);
    setFocusRequest("replace");
    if (autoCheck) await check();
  };

  const remove = async () => {
    setProblem(null);
    setOutcome(null);
    const failure = await store.getState().removeApiKey(provider.id);
    if (failure !== null) return setProblem(failure);
    setFocusRequest("field");
  };

  return (
    <div className="flex flex-col gap-1.5" data-voice-key={provider.id}>
      {provider.hasKey ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-[15px]">
          <span className="inline-flex items-center gap-1 font-medium text-success">
            <CheckCircle size={12} weight="fill" aria-hidden />
            {t("voice.key.saved")}
          </span>
          {!replacing && (
            <>
              <Button
                size="xs"
                variant="secondary"
                loading={checking}
                disabled={pending !== null}
                aria-label={t("voice.key.checkAria", { name: provider.name })}
                onClick={() => void check()}
              >
                {t("voice.key.check")}
              </Button>
              <Button
                ref={replaceButton}
                size="xs"
                variant="ghost"
                aria-label={t("voice.key.replaceAria", { name: provider.name })}
                disabled={pending !== null}
                onClick={() => {
                  setReplacing(true);
                  setFocusRequest("field");
                }}
              >
                {t("voice.key.replace")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label={t("voice.key.removeAria", { name: provider.name })}
                loading={keyWork}
                disabled={pending !== null}
                onClick={() => void remove()}
              >
                {t("common.remove")}
              </Button>
            </>
          )}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-xs leading-[15px] text-fg-3">
          <Key size={12} className="shrink-0" aria-hidden />
          <span>{provider.keyRequired ? t("voice.key.needs") : t("voice.key.optional")}</span>
        </p>
      )}
      {editing && (
        <form className="flex items-center gap-1.5" onSubmit={(event) => void save(event)}>
          <div className={cn(fieldBase, "flex-1")} aria-invalid={problem ? true : undefined}>
            <input
              ref={field}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              readOnly={keyWork}
              placeholder={t("voice.key.placeholder")}
              aria-label={t("voice.key.aria", { name: provider.name })}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? errorId : undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                if (problem) setProblem(null);
              }}
              className={cn(fieldText, "font-mono")}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            loading={keyWork}
            disabled={pending !== null}
          >
            {t("common.save")}
          </Button>
          {replacing && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={keyWork}
              onClick={() => {
                setReplacing(false);
                setDraft("");
                setProblem(null);
                setFocusRequest("replace");
              }}
            >
              {t("common.cancel")}
            </Button>
          )}
        </form>
      )}
      {problem && (
        <p id={errorId} role="alert" className="text-xs text-error">
          {problem}
        </p>
      )}
      {outcome?.ok === true && (
        <p
          role="status"
          data-testid="voice-key-checked"
          className="flex flex-wrap items-center gap-1.5 text-xs text-success"
        >
          <CheckCircle size={12} weight="fill" aria-hidden />
          {t("voice.key.works")}
          {outcome.sample !== null && (
            <VoicePlayButton
              soundKey={`voice-key:${provider.id}`}
              label={t("voice.key.listen", { name: provider.name })}
              size="xs"
              source={() => (outcome.sample === null ? null : { url: outcome.sample.url })}
            />
          )}
        </p>
      )}
      {outcome?.ok === false && (
        <p role="alert" data-testid="voice-key-failed" className="text-xs text-error">
          {outcome.message}
        </p>
      )}
    </div>
  );
}
