import { useEffect, useState } from "react";
import { CaretDown, Check, Flask } from "@phosphor-icons/react";
import {
  isThinkingEffort,
  type AgentModelInfo,
  type JevCredentialMode,
  type JevSettings as JevSettingsValue,
  type ProviderInfo,
  type TestJevResponse,
  type UpdateAgentSettingsRequest,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { effortChoices } from "../../agent/agentSelectors";
import type { Loadable } from "../../agent/agentSettingsSlice";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { Popover } from "../ui/Popover";
import { Toggle } from "../ui/Toggle";
import { AGENT_BLURBS, EFFORT_LABELS } from "./agentLabels";
import { DialogField } from "./ChatDialog";
import { ChoiceChips } from "./ChoiceChips";
import { ModelList } from "./ModelList";

export type JevPatch = NonNullable<UpdateAgentSettingsRequest["jev"]>;

const triggerClass = cn(
  "flex h-ctl-sm w-full min-w-0 items-center gap-1 rounded-sm border border-border-input bg-input px-2 text-step-11 text-text-1",
  "outline-hidden transition-colors duration-hover enabled:hover:border-border-strong",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

const textField =
  "h-ctl-sm min-w-0 flex-1 rounded-sm border border-border-input bg-input px-2 text-step-11 text-text-1 outline-hidden placeholder:text-text-5 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent";

function ProviderPicker({
  providers,
  value,
  onSelect,
  onRetry,
}: {
  providers: Loadable<ProviderInfo[]> | null;
  value: string | null;
  onSelect: (provider: string) => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const list = providers?.status === "ready" ? providers.value : null;
  const current = list?.find((provider) => provider.id === value);
  const label = value ?? "Choose a provider";
  const unset = value === null;

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="start"
      aria-label="Jev providers"
      className="w-64 p-1"
      trigger={
        <button type="button" aria-label={`Jev provider: ${label}`} className={triggerClass}>
          <span className={cn("min-w-0 flex-1 truncate text-left", unset && "text-text-3")}>
            {label}
          </span>
          {current && (
            <span
              className={cn(
                "shrink-0 text-step-10",
                current.authenticated ? "text-accent" : "text-text-4",
              )}
            >
              {current.authenticated ? "signed in" : "not signed in"}
            </span>
          )}
          <CaretDown size={10} weight="bold" aria-hidden className="shrink-0 text-text-4" />
        </button>
      }
    >
      {providers?.status === "failed" ? (
        <div className="flex flex-col items-start gap-1.5 p-2">
          <p className="text-step-11 text-text-2">{providers.message}</p>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : !list ? (
        <p className="p-2 text-step-11 text-text-3">Loading providers…</p>
      ) : list.length === 0 ? (
        <p className="p-2 text-step-11 text-text-3">The agent knows no providers.</p>
      ) : (
        <ul aria-label="Providers" className="flex max-h-64 flex-col overflow-y-auto">
          {list.map((provider) => (
            <li key={provider.id}>
              <button
                type="button"
                aria-pressed={provider.id === value}
                onClick={() => {
                  setOpen(false);
                  if (provider.id !== value) onSelect(provider.id);
                }}
                className="flex h-ctl-sm w-full items-center gap-2 rounded-sm px-2 text-left text-step-11 text-text-1 outline-hidden hover:bg-hover focus-visible:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate">{provider.id}</span>
                {provider.authenticated && (
                  <span className="text-step-10 text-accent">signed in</span>
                )}
                {provider.id === value && (
                  <Check size={12} weight="bold" aria-hidden className="shrink-0 text-accent" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}

function JevModelPicker({
  models,
  jev,
  onSelect,
}: {
  models: Loadable<AgentModelInfo[]> | undefined;
  jev: JevSettingsValue;
  onSelect: (model: AgentModelInfo) => void;
}) {
  const [open, setOpen] = useState(false);
  const list = models?.status === "ready" ? models.value : null;
  const current = list?.find((model) => model.modelId === jev.modelId) ?? null;
  let label = current?.name ?? jev.modelId ?? "Choose a model";
  if (!jev.provider) label = "Choose a provider first";
  else if (models?.status === "failed") label = "Models unavailable";
  else if (!list) label = "Loading models…";

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="start"
      aria-label="Jev models"
      trigger={
        <button
          type="button"
          aria-label={`Jev model: ${label}`}
          disabled={!list || list.length === 0}
          className={triggerClass}
        >
          <span className={cn("min-w-0 flex-1 truncate text-left", !current && "text-text-3")}>
            {label}
          </span>
          <CaretDown size={10} weight="bold" aria-hidden className="shrink-0 text-text-4" />
        </button>
      }
    >
      {list && (
        <ModelList
          models={list}
          explicit={
            jev.provider && jev.modelId ? { provider: jev.provider, modelId: jev.modelId } : null
          }
          defaultName={null}
          includeDefault={false}
          onSelect={(selection) => {
            const model = list.find((item) => item.modelId === selection?.modelId);
            setOpen(false);
            if (model) onSelect(model);
          }}
        />
      )}
    </Popover>
  );
}

function ApiKeyField({ configured }: { configured: boolean }) {
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
    <DialogField
      label="API key"
      hint="Kept by the agent on this computer and never shown again, not even to Studio."
    >
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <input
          type="password"
          aria-label="Jev API key"
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder={configured ? "Paste a new key to replace it" : "Paste an API key"}
          onChange={(event) => setKey(event.target.value)}
          className={textField}
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          loading={busy === "save"}
          disabled={!key.trim() || busy !== null}
        >
          Save
        </Button>
        {configured && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            loading={busy === "remove"}
            disabled={busy !== null}
            onClick={() => void write(null)}
          >
            Remove
          </Button>
        )}
      </form>
      {configured && (
        <p className="flex items-center gap-1 text-step-11 text-accent">
          <Check size={12} weight="bold" aria-hidden />
          Key saved
        </p>
      )}
      {error && (
        <p role="alert" className="text-step-11 text-danger">
          {error}
        </p>
      )}
    </DialogField>
  );
}

function JevTest() {
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
    <div className="flex flex-col items-start gap-1.5">
      <Button
        size="sm"
        variant="secondary"
        icon={<Flask size={12} aria-hidden />}
        loading={running}
        onClick={() => void run()}
      >
        Test Jev
      </Button>
      <div aria-live="polite" className="w-full">
        {result?.ok && (
          <div className="flex flex-col gap-0.5 rounded-md border border-hairline bg-bg-2 px-2 py-1.5">
            <p className="text-step-10 text-text-3">
              {result.model.modelId} replied in {(result.elapsedMs / 1000).toFixed(1)}s
            </p>
            <p className="whitespace-pre-wrap break-words text-step-11 text-text-1">
              {result.reply}
            </p>
          </div>
        )}
        {result && !result.ok && (
          <p role="alert" className="text-step-11 text-danger">
            {result.message}
          </p>
        )}
      </div>
    </div>
  );
}

const CREDENTIAL_CHOICES: { value: JevCredentialMode; label: string }[] = [
  { value: "provider-login", label: "Use provider sign-in" },
  { value: "api-key", label: "API key" },
];

/** Jev, the shared fast worker: on/off, which model it runs, and whose credentials it uses. */
export function JevSettings({
  jev,
  onCommit,
}: {
  jev: JevSettingsValue;
  onCommit: (patch: JevPatch) => void;
}) {
  const providers = useAgentStore((state) => state.providers);
  const models = useAgentStore((state) =>
    jev.provider ? state.providerModels[jev.provider] : undefined,
  );
  const loadProviders = useAgentStore((state) => state.loadProviders);
  const loadProviderModels = useAgentStore((state) => state.loadProviderModels);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);
  useEffect(() => {
    if (jev.provider) void loadProviderModels(jev.provider);
  }, [jev.provider, loadProviderModels]);

  const provider =
    providers?.status === "ready"
      ? providers.value.find((known) => known.id === jev.provider)
      : undefined;
  const modelInfo =
    models?.status === "ready"
      ? (models.value.find((model) => model.modelId === jev.modelId) ?? null)
      : null;
  const efforts = effortChoices(modelInfo);

  let credentialHint = "Uses the key you save below, for Jev only.";
  if (jev.credentials === "provider-login") {
    credentialHint =
      provider?.authenticated === false
        ? `The agent isn't signed in to ${provider.id}. Sign in there, or use an API key.`
        : "Uses the sign-in the agent already has for this provider.";
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-step-11 text-text-3">{AGENT_BLURBS.jev}</p>
        <Toggle
          label="Use Jev"
          checked={jev.enabled}
          onCommit={(enabled) => onCommit({ enabled })}
        />
      </div>
      <DialogField label="Provider">
        <ProviderPicker
          providers={providers}
          value={jev.provider}
          onRetry={() => void loadProviders()}
          onSelect={(id) => onCommit({ provider: id, modelId: null, thinking: null })}
        />
      </DialogField>
      <DialogField label="Model">
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
      </DialogField>
      {efforts.length > 0 && (
        <DialogField label="Thinking">
          <ChoiceChips
            label="Jev thinking"
            value={jev.thinking ?? "default"}
            choices={[
              { value: "default", label: "Default" },
              ...efforts.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] })),
            ]}
            onChange={(next) => onCommit({ thinking: isThinkingEffort(next) ? next : null })}
          />
        </DialogField>
      )}
      <DialogField label="Credentials" hint={credentialHint}>
        <ChoiceChips
          label="Jev credentials"
          value={jev.credentials}
          choices={CREDENTIAL_CHOICES}
          onChange={(credentials) => onCommit({ credentials })}
        />
      </DialogField>
      {jev.credentials === "api-key" && <ApiKeyField configured={jev.apiKeyConfigured} />}
      <JevTest />
    </div>
  );
}
