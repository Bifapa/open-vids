import { useId, useState, type ReactNode } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { AgentModelInfo, ProviderInfo } from "@hyperframes/agent-protocol";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { IconButton } from "../ui/IconButton";
import { fieldBase, fieldSizes, fieldText } from "../ui/Input";
import { Badge, Spinner, StatusDot, type StatusDotTone, type StatusTone } from "../ui/Status";
import {
  SignInProgress,
  SignInStart,
  signInBusyLabel,
  signInFlows,
  type ProviderSignInControls,
} from "./ProviderSignIn";
import { SettingsLink } from "./settingsLayout";
import { modelKey } from "./providerStatus";
import { isRunningLogin } from "./useOAuthSignIns";

/** What the row says about a provider, from the status the runtime reported. */
interface RowLook {
  dot: StatusDotTone;
  tone: StatusTone;
  badge: string;
  sub: string;
}

/** Models listed before "Show all N models": the ones agents use always show, then the rest up to this many. */
const MODELS_SHOWN = 8;

function describe(provider: ProviderInfo): RowLook {
  const models = `${provider.modelCount} ${provider.modelCount === 1 ? "model" : "models"}`;
  switch (provider.status) {
    case "connected": {
      const via = provider.keyless
        ? "Local, no key needed"
        : provider.credentialSource === "api-key"
          ? "API key saved in OpenVids"
          : provider.credentialSource === "oauth"
            ? "Signed in here"
            : "From your OMP setup";
      return { dot: "ok", tone: "success", badge: "Connected", sub: `${via} · ${models}` };
    }
    case "signin_required":
      return {
        dot: "warn",
        tone: "warning",
        badge: "Sign-in required",
        sub: provider.error ?? "The sign-in expired",
      };
    case "error":
      return {
        dot: "error",
        tone: "error",
        badge: "Error",
        sub: provider.error ?? "The last check failed",
      };
    case "not_configured":
      return {
        dot: "off",
        tone: "neutral",
        badge: "Not configured",
        sub: provider.oauth ? "Sign in or add an API key" : "Add an API key to use its models",
      };
  }
}

function KeyForm({
  provider,
  label,
  note,
  onSave,
}: {
  provider: ProviderInfo;
  /** Placeholder and field name: "API key" or "Replace API key". */
  label: string;
  note: ReactNode;
  /** Resolves to the failure message, or null when the key was saved. */
  onSave: (apiKey: string) => Promise<string | null>;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const errorId = useId();

  const submit = async () => {
    const trimmed = key.trim();
    if (!trimmed) return setError("Paste an API key first.");
    if (/\s/.test(trimmed)) return setError("An API key can't contain spaces.");
    setError(null);
    setSaving(true);
    const failure = await onSave(trimmed);
    setSaving(false);
    // The key leaves this component once it is saved; a refused one stays for another try.
    if (failure === null) setKey("");
    else setError(failure);
  };

  return (
    <div className="grid gap-1.5">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div
          className={cn(fieldBase, fieldSizes.md, "flex-1")}
          aria-invalid={error ? true : undefined}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={label}
            aria-label={`${provider.name} ${label}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            disabled={saving}
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              if (error) setError(null);
            }}
            className={cn(fieldText, "font-mono")}
          />
        </div>
        <Button type="submit" disabled={saving}>
          Connect
        </Button>
      </form>
      {error && (
        <p id={errorId} role="alert" className="m-0 text-xs text-error">
          {error}
        </p>
      )}
      <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">{note}</p>
    </div>
  );
}

/** A model of a connected provider and who runs it: the prototype's `.st-models` row. */
function ProviderModels({
  provider,
  models,
  users,
}: {
  provider: ProviderInfo;
  models: readonly AgentModelInfo[] | null;
  users: ReadonlyMap<string, string[]>;
}) {
  const [all, setAll] = useState(false);
  if (!models) {
    return <p className="m-0 text-xs text-fg-3">Models unavailable right now.</p>;
  }
  if (models.length === 0) {
    return <p className="m-0 text-xs text-fg-3">No usable models listed yet. Refresh to check.</p>;
  }
  const byName = (a: AgentModelInfo, b: AgentModelInfo) => a.name.localeCompare(b.name);
  const used = models.filter((model) => users.has(modelKey(model))).sort(byName);
  const unused = models.filter((model) => !users.has(modelKey(model))).sort(byName);
  const shown = all
    ? [...used, ...unused]
    : [...used, ...unused.slice(0, Math.max(0, MODELS_SHOWN - used.length))];
  return (
    <div className="grid gap-1">
      <dl
        aria-label={`${provider.name} models`}
        className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-t border-dashed border-border-subtle py-1 text-sm"
      >
        {shown.map((model) => {
          const who = users.get(modelKey(model));
          return (
            <div key={modelKey(model)} className="contents">
              <dt className="truncate py-1 font-mono text-num text-fg" title={model.name}>
                {model.name}
              </dt>
              <dd className="m-0 py-1 text-right text-xs text-fg-3">
                {who ? who.join(", ") : "Not used"}
              </dd>
            </div>
          );
        })}
      </dl>
      {shown.length < models.length && (
        <div className="text-xs">
          <SettingsLink onClick={() => setAll(true)}>Show all {models.length} models</SettingsLink>
        </div>
      )}
    </div>
  );
}

export interface ProviderRowProps {
  provider: ProviderInfo;
  open: boolean;
  onToggle: () => void;
  /** What the row is busy with ("Connecting…"), shown in place of its badge and action. */
  busy: string | null;
  /** The provider's usable models; null when the catalog could not be read. */
  models: readonly AgentModelInfo[] | null;
  /** Who runs each model by default, by `provider/modelId`. */
  users: ReadonlyMap<string, string[]>;
  onSaveKey: (apiKey: string) => Promise<string | null>;
  onRemoveKey: () => void;
  onRetry: () => void;
  onRefresh: () => void;
  /** The provider's in-app sign-in; null when the runtime offers none for it. */
  signIn: ProviderSignInControls | null;
  onSignOut: () => void;
}

const KEY_STORAGE_NOTE =
  "Stored in a private file on this Mac that only you can read. Not in the macOS Keychain, and not shared with OMP.";

/** One provider of the list (prototype `.st-prov`): state, what it needs, and its details when opened. */
export function ProviderRow({
  provider,
  open,
  onToggle,
  busy,
  models,
  users,
  onSaveKey,
  onRemoveKey,
  onRetry,
  onRefresh,
  signIn,
  onSignOut,
}: ProviderRowProps) {
  const look = describe(provider);
  const bodyId = useId();
  const ownKey = provider.credentialSource === "api-key";
  const setUp = provider.status === "not_configured";

  const flows = signInFlows(provider);
  const canSignIn = signIn !== null && flows.length > 0 && !provider.keyless;
  const signedHere = provider.credentialSource === "oauth";
  const running =
    signIn !== null && (isRunningLogin(signIn.view.login) || signIn.view.busy !== null);
  const ended = signIn?.view.login && !isRunningLogin(signIn.view.login) ? signIn.view.login : null;
  const rowBusy = (signIn && signInBusyLabel(signIn.view)) ?? busy;

  // "Sign in…" starts the default flow, or opens the row to choose when there are several.
  const signInButton = canSignIn ? (
    <Button onClick={() => (flows.length > 1 ? onToggle() : signIn.start(null))}>Sign in…</Button>
  ) : null;
  const keyButton = <Button onClick={onToggle}>Use an API key</Button>;

  let action: ReactNode = null;
  if (provider.status === "error") action = <Button onClick={onRetry}>Retry</Button>;
  else if (provider.status === "signin_required" && !open && !provider.keyless) {
    action = (
      <>
        {signInButton}
        {keyButton}
      </>
    );
  } else if (setUp && !open && !provider.keyless) {
    action = canSignIn ? (
      <>
        {signInButton}
        {keyButton}
      </>
    ) : (
      <Button onClick={onToggle}>Set up</Button>
    );
  }

  let body: ReactNode = null;
  if (open) {
    const removeLink = ownKey ? (
      <div>
        <SettingsLink onClick={onRemoveKey}>Remove API key</SettingsLink>
      </div>
    ) : null;
    const replaceNote = ownKey
      ? KEY_STORAGE_NOTE
      : `A key saved here is used instead of the one from your OMP setup. ${KEY_STORAGE_NOTE}`;
    // A sign-in under way takes the body; one that ended shows its reason above the usual options.
    const signInStart =
      canSignIn && !ended ? <SignInStart provider={provider} controls={signIn} /> : null;
    const progress =
      signIn && signIn.view.login && (running || provider.status !== "connected") ? (
        <SignInProgress provider={provider} controls={signIn} />
      ) : null;
    let status: ReactNode = null;
    switch (provider.status) {
      case "connected":
        status = (
          <>
            <ProviderModels provider={provider} models={models} users={users} />
            {removeLink}
            {signedHere && (
              <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">
                You signed in to {provider.name} here.{" "}
                <SettingsLink onClick={onSignOut}>Sign out</SettingsLink> removes it from OpenVids;
                it doesn't revoke access at {provider.name}.
              </p>
            )}
            {!provider.keyless && !ownKey && !signedHere && (
              <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">
                This credential comes from your OMP setup, so it can only be changed there.
              </p>
            )}
            {!provider.keyless && !provider.verified && (
              <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">
                Not checked with {provider.name} yet.{" "}
                <SettingsLink onClick={onRefresh}>Refresh</SettingsLink> to check.
              </p>
            )}
          </>
        );
        break;
      case "error":
        status = (
          <>
            <pre className="m-0 whitespace-pre-wrap rounded-sm border border-border-subtle bg-bg-0 px-2 py-1.5 font-mono text-xs leading-[15px] text-fg-2">
              {provider.error ?? "The last check failed."}
            </pre>
            {signInStart}
            {!provider.keyless && (
              <KeyForm
                provider={provider}
                label={ownKey ? "Replace API key" : "API key"}
                note={replaceNote}
                onSave={onSaveKey}
              />
            )}
            {removeLink}
          </>
        );
        break;
      case "signin_required":
        status = (
          <>
            <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">
              {canSignIn ? (
                <>
                  The {provider.name} sign-in expired. Sign in again here, or use an API key
                  instead.
                </>
              ) : (
                <>
                  {provider.name} is signed in through OMP, which OpenVids can only read. Sign in
                  again there, then <SettingsLink onClick={onRefresh}>Refresh</SettingsLink> — or
                  use an API key instead.
                </>
              )}
            </p>
            {signInStart}
            {!provider.keyless && (
              <KeyForm provider={provider} label="API key" note={replaceNote} onSave={onSaveKey} />
            )}
          </>
        );
        break;
      case "not_configured":
        status = provider.keyless ? (
          <p className="m-0 text-xs text-fg-3">{provider.name} needs no key.</p>
        ) : (
          <>
            {signInStart}
            <KeyForm
              provider={provider}
              label="API key"
              note={KEY_STORAGE_NOTE}
              onSave={onSaveKey}
            />
          </>
        );
        break;
    }
    body = (
      <>
        {progress}
        {running ? null : status}
      </>
    );
  }

  const expandable = !(setUp && !open);
  return (
    <div data-provider={provider.id} data-status={provider.status}>
      <div className="grid min-h-row-lg grid-cols-[6px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-row-pad">
        <StatusDot tone={look.dot} />
        <div className="grid min-w-0 gap-px">
          <span className="text-base leading-4 font-medium text-fg">{provider.name}</span>
          <span className="truncate text-xs leading-[14px] text-fg-3" title={look.sub}>
            {look.sub}
          </span>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          {rowBusy ? (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-fg-3"
            >
              <Spinner />
              {rowBusy}
            </span>
          ) : (
            <>
              <Badge tone={look.tone}>{look.badge}</Badge>
              {action}
            </>
          )}
          {expandable && (
            <IconButton
              aria-label={`${open ? "Hide" : "Show"} ${provider.name} details`}
              aria-expanded={open}
              aria-controls={open ? bodyId : undefined}
              icon={
                <CaretRight
                  aria-hidden
                  className={cn(
                    "size-icon-md transition-transform duration-hover",
                    open && "rotate-90",
                  )}
                />
              }
              onClick={onToggle}
            />
          )}
        </div>
      </div>
      {body && (
        <div id={bodyId} className="grid gap-2 pt-0.5 pr-3 pb-3 pl-[30px]">
          {body}
        </div>
      )}
    </div>
  );
}
