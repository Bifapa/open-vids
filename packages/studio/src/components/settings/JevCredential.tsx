import { useState, type ReactNode } from "react";
import { Flask } from "@phosphor-icons/react";
import type {
  JevCredentialMode,
  JevSettings,
  ProviderInfo,
  TestJevResponse,
  UpdateAgentSettingsRequest,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { Trans, formatNumber, useTranslation, type TranslationKey } from "../../i18n";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { fieldBase, fieldSizes, fieldText } from "../ui/Input";
import { Spinner } from "../ui/Status";
import { SettingsGroup, SettingsRow, SettingsStatus } from "./settingsLayout";

type JevPatch = NonNullable<UpdateAgentSettingsRequest["jev"]>;

/** One option of a radio list (prototype `.st-radio`): a dot, a bold label, a line under it. */
function RadioRow({
  checked,
  label,
  hint,
  onSelect,
}: {
  checked: boolean;
  label: ReactNode;
  hint: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[16px_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 px-3 py-2 text-left",
        "rounded-md outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
        "group",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "row-span-2 mt-px size-3.5 rounded-full border",
          checked
            ? "border-4 border-fg bg-bg-1"
            : "border-border-strong bg-surface-1 group-hover:border-fg-3",
        )}
      />
      <span className="text-base leading-4 text-fg">{label}</span>
      <span className="text-xs leading-[14px] text-fg-3">{hint}</span>
    </button>
  );
}

const CREDENTIAL_MODES: JevCredentialMode[] = ["provider-login", "api-key"];

const CREDENTIAL_LABELS: Record<
  JevCredentialMode,
  { label: TranslationKey; hint: TranslationKey }
> = {
  "provider-login": {
    label: "settings.jev.credential.provider",
    hint: "settings.jev.credential.providerHint",
  },
  "api-key": {
    label: "settings.jev.credential.key",
    hint: "settings.studio.jev.credKeyHint",
  },
};

/** Runs Jev's test with the settings on screen; the answer stays until the next run. */
function useJevTest() {
  const testJev = useAgentStore((state) => state.testJev);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestJevResponse | null>(null);
  const run = async () => {
    setRunning(true);
    setResult(null);
    setResult(await testJev());
    setRunning(false);
  };
  return { running, result, run };
}

type JevTest = ReturnType<typeof useJevTest>;

/** Testing… / Replied in 1.2s / Failed, as the prototype's status beside Test. */
function TestStatus({ test }: { test: JevTest }) {
  const { t } = useTranslation();
  return (
    <span aria-live="polite" className="contents">
      {test.running && (
        <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-fg-3">
          <Spinner />
          {t("settings.jev.test.running")}
        </span>
      )}
      {test.result?.ok && (
        <SettingsStatus tone="success">
          {t("settings.studio.jev.replied", {
            seconds: formatNumber(test.result.elapsedMs / 1000, {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            }),
          })}
        </SettingsStatus>
      )}
      {test.result && !test.result.ok && (
        <SettingsStatus tone="error">{t("settings.jev.test.failed")}</SettingsStatus>
      )}
    </span>
  );
}

function TestButton({ test }: { test: JevTest }) {
  const { t } = useTranslation();
  return (
    <Button
      icon={<Flask aria-hidden className="size-icon-sm" />}
      disabled={test.running}
      onClick={() => void test.run()}
    >
      {t("settings.jev.test.button")}
    </Button>
  );
}

/** What Jev answered, or why it could not. */
function TestResult({ test }: { test: JevTest }) {
  const { result } = test;
  if (!result) return null;
  if (!result.ok) {
    return (
      <p role="alert" className="m-0 px-3 pb-2 text-xs text-error">
        {result.message}
      </p>
    );
  }
  return (
    <div className="mx-3 mb-2 rounded-sm border border-border-subtle bg-bg-0 px-2 py-1.5">
      <p className="m-0 font-mono text-num text-fg-3">{result.model.modelId}</p>
      <p className="m-0 whitespace-pre-wrap break-words text-sm text-fg-2">{result.reply}</p>
    </div>
  );
}

/** Jev's own key: the field to enter it, or, once saved, a row to test or remove it. */
function JevKey({ configured, test }: { configured: boolean; test: JevTest }) {
  const { t } = useTranslation();
  const setJevApiKey = useAgentStore((state) => state.setJevApiKey);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const write = async (apiKey: string | null) => {
    setBusy(apiKey === null ? "remove" : "save");
    setError(null);
    const result = await setJevApiKey(apiKey);
    setBusy(null);
    if (!result.ok) setError(result.message);
    else if (apiKey !== null) setKey("");
  };

  const save = () => {
    const trimmed = key.trim();
    if (!trimmed) setError(t("settings.key.error.empty"));
    else if (/\s/.test(trimmed)) setError(t("settings.studio.key.spaces"));
    else void write(trimmed);
  };

  if (configured) {
    return (
      <div>
        <SettingsRow
          label={t("settings.providers.key.placeholder")}
          hint={
            <Trans
              i18nKey="settings.studio.jev.keySaved"
              values={{ mask: "••••••••••••" }}
              components={{ mask: <span className="font-mono" /> }}
            />
          }
        >
          <TestStatus test={test} />
          <TestButton test={test} />
          <Button
            type="button"
            variant="ghost"
            loading={busy === "remove"}
            disabled={busy !== null}
            onClick={() => void write(null)}
          >
            {t("common.remove")}
          </Button>
        </SettingsRow>
        {error && (
          <p role="alert" className="m-0 px-3 pb-2 text-xs text-error">
            {error}
          </p>
        )}
        <TestResult test={test} />
      </div>
    );
  }

  return (
    <div className="grid gap-1 px-3 py-2">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div
          className={cn(fieldBase, fieldSizes.md, "flex-1")}
          aria-invalid={error ? true : undefined}
        >
          <input
            type="password"
            aria-label={t("settings.jev.key.aria")}
            autoComplete="off"
            spellCheck={false}
            value={key}
            placeholder={t("settings.studio.jev.keyPlaceholder")}
            onChange={(event) => {
              setKey(event.target.value);
              if (error) setError(null);
            }}
            className={cn(fieldText, "font-mono")}
          />
        </div>
        <Button type="submit" loading={busy === "save"} disabled={busy !== null}>
          {t("common.save")}
        </Button>
      </form>
      {error && (
        <p role="alert" className="m-0 text-xs text-error">
          {error}
        </p>
      )}
      <p className="m-0 text-xs leading-[15px] text-fg-3">{t("settings.studio.jev.keyNote")}</p>
    </div>
  );
}

/**
 * Whose credential Jev uses (prototype "Credential"): the provider connection the agents use, or its own API key.
 * A local provider needs neither. The Test button sends a short prompt with everything chosen above.
 */
export function JevCredentialGroup({
  jev,
  provider,
  onCommit,
}: {
  jev: JevSettings;
  provider: ProviderInfo | undefined;
  onCommit: (patch: JevPatch) => void;
}) {
  const { t } = useTranslation();
  const test = useJevTest();
  const name = provider?.name ?? jev.provider ?? t("settings.jev.providerFallback");
  const keyless = provider?.keyless === true;
  const ownKey = !keyless && jev.credentials === "api-key" && jev.apiKeyConfigured;

  return (
    <SettingsGroup label={t("settings.jev.group.credential")}>
      {keyless ? (
        <SettingsRow
          label={t("settings.providers.key.placeholder")}
          hint={t("settings.studio.jev.localNone")}
        >
          <SettingsStatus tone="success">{t("settings.jev.key.notNeeded")}</SettingsStatus>
        </SettingsRow>
      ) : (
        <>
          <div
            role="radiogroup"
            aria-label={t("settings.studio.jev.credsAria")}
            className="grid gap-0.5 divide-y divide-border-subtle"
          >
            {CREDENTIAL_MODES.map((mode) => (
              <RadioRow
                key={mode}
                checked={jev.credentials === mode}
                label={t(CREDENTIAL_LABELS[mode].label, { provider: name })}
                hint={t(CREDENTIAL_LABELS[mode].hint)}
                onSelect={() => {
                  if (jev.credentials !== mode) onCommit({ credentials: mode });
                }}
              />
            ))}
          </div>
          {jev.credentials === "api-key" && (
            <JevKey configured={jev.apiKeyConfigured} test={test} />
          )}
        </>
      )}
      {!ownKey && (
        <div>
          <SettingsRow label={t("settings.jev.test")} hint={t("settings.jev.test.hint")}>
            <TestStatus test={test} />
            <TestButton test={test} />
          </SettingsRow>
          <TestResult test={test} />
        </div>
      )}
    </SettingsGroup>
  );
}
