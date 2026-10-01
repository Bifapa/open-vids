import { useEffect, useState, type ReactNode } from "react";
import { Check, Flask, WarningCircle } from "@phosphor-icons/react";
import {
  isThinkingEffort,
  type JevCredentialMode,
  type TestJevResponse,
  type UpdateAgentSettingsRequest,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { effortChoices } from "../../agent/agentSelectors";
import { AGENT_BLURBS, EFFORT_LABELS } from "../chat/agentLabels";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { fieldBase, fieldSizes, fieldText } from "../ui/Input";
import { Select } from "../ui/Select";
import { Toggle } from "../ui/Toggle";
import { JevModelPicker, JevProviderPicker } from "./JevPickers";
import {
  SaveStatus,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsUnavailable,
} from "./settingsLayout";
import { useAgentSettingsEditor } from "./useAgentSettingsEditor";

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

function ApiKeyRow({ configured }: { configured: boolean }) {
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
    if (/\s/.test(trimmed)) setError("An API key can't contain spaces.");
    else if (trimmed) void write(trimmed);
  };

  return (
    <div className="grid gap-1 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="grid min-w-0 gap-px">
          <span className="text-base leading-4 text-fg">API key</span>
          <span className="text-xs leading-[14px] text-fg-3">
            Kept by the agent on this computer and never shown again, not even to Studio.
          </span>
        </div>
        {configured && (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-success">
            <Check aria-hidden className="size-icon-sm" />
            Key saved
          </span>
        )}
      </div>
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
            aria-label="Jev API key"
            autoComplete="off"
            spellCheck={false}
            value={key}
            placeholder={configured ? "Paste a new key to replace it" : "Paste an API key"}
            onChange={(event) => setKey(event.target.value)}
            className={cn(fieldText, "font-mono")}
          />
        </div>
        <Button type="submit" loading={busy === "save"} disabled={!key.trim() || busy !== null}>
          Save
        </Button>
        {configured && (
          <Button
            type="button"
            variant="ghost"
            loading={busy === "remove"}
            disabled={busy !== null}
            onClick={() => void write(null)}
          >
            Remove
          </Button>
        )}
      </form>
      {error && (
        <p role="alert" className="m-0 text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}

function JevTestRow() {
  const testJev = useAgentStore((state) => state.testJev);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestJevResponse | null>(null);

  const run = async () => {
    setRunning(true);
    setResult(null);
    setResult(await testJev());
    setRunning(false);
  };

  return (
    <div className="grid gap-1.5 px-3 py-1.5">
      <div className="flex min-h-row items-center justify-between gap-3">
        <div className="grid min-w-0 gap-px">
          <span className="text-base leading-4 text-fg">Test Jev</span>
          <span className="text-xs leading-[14px] text-fg-3">
            Sends a short prompt with the settings above.
          </span>
        </div>
        <div className="flex items-center gap-1.5" aria-live="polite">
          {result?.ok && (
            <span className="flex items-center gap-1 text-xs font-medium text-success">
              <Check aria-hidden className="size-icon-sm" />
              Replied in {(result.elapsedMs / 1000).toFixed(1)}s
            </span>
          )}
          {result && !result.ok && (
            <span className="flex items-center gap-1 text-xs font-medium text-error">
              <WarningCircle aria-hidden className="size-icon-sm" />
              Failed
            </span>
          )}
          <Button
            icon={<Flask aria-hidden className="size-icon-sm" />}
            loading={running}
            onClick={() => void run()}
          >
            Test
          </Button>
        </div>
      </div>
      {result?.ok && (
        <div className="mb-1 rounded-sm border border-border-subtle bg-bg-0 px-2 py-1.5">
          <p className="m-0 font-mono text-num text-fg-3">{result.model.modelId}</p>
          <p className="m-0 whitespace-pre-wrap break-words text-sm text-fg-2">{result.reply}</p>
        </div>
      )}
      {result && !result.ok && (
        <p role="alert" className="m-0 mb-1 text-xs text-error">
          {result.message}
        </p>
      )}
    </div>
  );
}

const CREDENTIAL_MODES: JevCredentialMode[] = ["provider-login", "api-key"];

const CREDENTIAL_LABELS: Record<
  JevCredentialMode,
  { label: (provider: string) => string; hint: string }
> = {
  "provider-login": {
    label: (provider) => `Use the ${provider} sign-in`,
    hint: "Same sign-in and limits as your agents",
  },
  "api-key": {
    label: () => "Separate API key for Jev",
    hint: "Keeps Jev's usage and rate limits apart",
  },
};

/** Jev, the shared fast worker: on/off, which model it runs, and whose credentials it uses. */
export function JevSection() {
  const editor = useAgentSettingsEditor();
  const jev = editor.settings?.jev;
  const providers = useAgentStore((state) => state.providers);
  const models = useAgentStore((state) =>
    jev?.provider ? state.providerModels[jev.provider] : undefined,
  );
  const loadProviders = useAgentStore((state) => state.loadProviders);
  const loadProviderModels = useAgentStore((state) => state.loadProviderModels);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);
  useEffect(() => {
    if (jev?.provider) void loadProviderModels(jev.provider);
  }, [jev?.provider, loadProviderModels]);

  if (!jev) {
    return (
      <SettingsPage title="Jev" lede={AGENT_BLURBS.jev}>
        <SettingsUnavailable
          message={
            editor.settingsFailed ? "Agent settings are unavailable right now." : "Loading Jev…"
          }
          action={
            editor.settingsFailed ? (
              <Button size="sm" onClick={() => void editor.loadSettings()}>
                Try again
              </Button>
            ) : undefined
          }
        />
      </SettingsPage>
    );
  }

  const onCommit = (patch: JevPatch) => editor.commit({ jev: patch });
  const provider =
    providers?.status === "ready"
      ? providers.value.find((known) => known.id === jev.provider)
      : undefined;
  const modelInfo =
    models?.status === "ready"
      ? (models.value.find((model) => model.modelId === jev.modelId) ?? null)
      : null;
  const efforts = effortChoices(modelInfo);
  const signedOut = jev.credentials === "provider-login" && provider?.authenticated === false;

  return (
    <SettingsPage
      title="Jev"
      lede={AGENT_BLURBS.jev}
      meta={<SaveStatus status={editor.status} failed={editor.failed} />}
    >
      <SettingsGroup label="Worker">
        <SettingsRow label="Use Jev" hint="Off: agents do Jev's small tasks themselves.">
          <Toggle
            label="Use Jev"
            checked={jev.enabled}
            onCommit={(enabled) => onCommit({ enabled })}
          />
        </SettingsRow>
        <SettingsRow
          label="Provider"
          hint={
            signedOut ? (
              <span className="inline-flex items-center gap-1 font-medium text-warning">
                <WarningCircle aria-hidden className="size-icon-sm" />
                The agent isn't signed in to {provider?.id}. Sign in there, or use an API key.
              </span>
            ) : undefined
          }
        >
          <JevProviderPicker
            providers={providers}
            value={jev.provider}
            onRetry={() => void loadProviders()}
            onSelect={(id) => onCommit({ provider: id, modelId: null, thinking: null })}
          />
        </SettingsRow>
        <SettingsRow label="Model">
          <JevModelPicker
            models={models}
            jev={jev}
            onSelect={(model) => {
              const effort = jev.thinking;
              const drop = effort && effort !== "off" && !model.efforts.includes(effort);
              onCommit({
                provider: model.provider,
                modelId: model.modelId,
                ...(drop ? { thinking: null } : {}),
              });
            }}
          />
        </SettingsRow>
        {efforts.length > 0 && (
          <SettingsRow label="Thinking">
            <Select
              size="md"
              label="Jev thinking"
              className="w-56"
              value={jev.thinking ?? "default"}
              options={[
                { value: "default", label: "Default" },
                ...efforts.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] })),
              ]}
              onCommit={(next) => onCommit({ thinking: isThinkingEffort(next) ? next : null })}
            />
          </SettingsRow>
        )}
      </SettingsGroup>
      <SettingsGroup label="Credential">
        <div
          role="radiogroup"
          aria-label="Jev credentials"
          className="grid gap-0.5 divide-y divide-border-subtle"
        >
          {CREDENTIAL_MODES.map((mode) => (
            <RadioRow
              key={mode}
              checked={jev.credentials === mode}
              label={CREDENTIAL_LABELS[mode].label(jev.provider ?? "provider")}
              hint={CREDENTIAL_LABELS[mode].hint}
              onSelect={() => {
                if (jev.credentials !== mode) onCommit({ credentials: mode });
              }}
            />
          ))}
        </div>
        {jev.credentials === "api-key" && <ApiKeyRow configured={jev.apiKeyConfigured} />}
      </SettingsGroup>
      <SettingsGroup label="Check">
        <JevTestRow />
      </SettingsGroup>
    </SettingsPage>
  );
}
