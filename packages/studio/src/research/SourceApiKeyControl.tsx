import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CheckCircle, Key } from "@phosphor-icons/react";
import type { SourceApiKey, TrustedSource } from "@hyperframes/agent-protocol";
import { Button, cn, fieldBase, fieldText } from "../components/ui";
import { useTranslation } from "../i18n";
import { ExternalLink } from "./researchUi";
import type { AssetSearchPolicyState } from "./useAssetSearchPolicy";

/**
 * The key line of a built-in source that needs the user's own API key (Pexels, Pixabay, ...): a note, a link to get
 * a key and the field to paste it while there is none; "Key saved" with Replace and Remove once there is. The key
 * goes to the server and never comes back: the policy only says whether one is `configured`.
 */
export function SourceApiKeyControl({
  source,
  apiKey,
  state,
}: {
  source: TrustedSource;
  apiKey: SourceApiKey;
  state: AssetSearchPolicyState;
}) {
  const { t } = useTranslation();
  const [replacing, setReplacing] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // Where focus goes once the control has changed shape: the control it replaced is gone by then.
  const [focusRequest, setFocusRequest] = useState<{ target: "field" | "replace" } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const changeKey = `key:${source.id}`;
  const working = state.pending === changeKey;
  const editing = !apiKey.configured || replacing;

  useEffect(() => {
    if (focusRequest?.target === "field") field.current?.focus();
    else if (focusRequest?.target === "replace") replaceButton.current?.focus();
  }, [focusRequest]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    // Enter in the read-only field can still submit the form while the button is busy.
    if (state.pending !== null) return;
    const key = draft.trim();
    if (!key) return setProblem(t("settings.key.error.empty"));
    setProblem(null);
    const failure = await state.change(
      changeKey,
      (client) => client.setSourceApiKey(source.id, key),
      { inline: true },
    );
    if (failure !== null) return setProblem(failure);
    setDraft("");
    setReplacing(false);
    setFocusRequest({ target: "replace" });
  };

  const remove = async () => {
    setProblem(null);
    const failure = await state.change(
      changeKey,
      (client) => client.removeSourceApiKey(source.id),
      { inline: true },
    );
    if (failure !== null) return setProblem(failure);
    setFocusRequest({ target: "field" });
  };

  return (
    <div className="ml-[38px] flex flex-col gap-1.5" data-api-key={source.id}>
      {apiKey.configured ? (
        <div className="flex flex-wrap items-center gap-x-2 text-xs leading-[15px]">
          <span className="inline-flex items-center gap-1 font-medium text-success">
            <CheckCircle size={12} weight="fill" aria-hidden />
            {t("research.policy.key.saved")}
          </span>
          {!replacing && (
            <>
              <Button
                ref={replaceButton}
                size="xs"
                variant="ghost"
                aria-label={t("research.policy.key.replaceAria", { name: source.name })}
                disabled={state.pending !== null}
                onClick={() => {
                  setReplacing(true);
                  setFocusRequest({ target: "field" });
                }}
              >
                {t("research.policy.key.replace")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label={t("research.policy.key.removeAria", { name: source.name })}
                loading={working}
                disabled={state.pending !== null}
                onClick={() => void remove()}
              >
                {t("common.remove")}
              </Button>
            </>
          )}
        </div>
      ) : (
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs leading-[15px] text-fg-3">
          <Key size={12} className="shrink-0" aria-hidden />
          <span className="[text-wrap:pretty]">{t("research.policy.key.needs")}</span>
          <ExternalLink href={apiKey.signupUrl}>{t("research.policy.key.get")}</ExternalLink>
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
              // Read-only, not disabled, while the key is on its way: a disabled field drops focus.
              readOnly={working}
              placeholder={t("research.policy.key.placeholder")}
              aria-label={t("research.policy.key.aria", { name: source.name })}
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
            loading={working}
            disabled={state.pending !== null}
          >
            {t("common.save")}
          </Button>
          {replacing && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={working}
              onClick={() => {
                setReplacing(false);
                setDraft("");
                setProblem(null);
                setFocusRequest({ target: "replace" });
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
    </div>
  );
}
