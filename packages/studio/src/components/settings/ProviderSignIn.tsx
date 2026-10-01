import { useEffect, useId, useRef, useState } from "react";
import { Copy } from "@phosphor-icons/react";
import type { OAuthFlow, OAuthLoginState, ProviderInfo } from "@hyperframes/agent-protocol";
import { ExternalLink } from "../../research/researchUi";
import { openExternalUrl, parseHttpsUrl } from "../../utils/openExternalUrl";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { fieldBase, fieldSizes, fieldText } from "../ui/Input";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Spinner } from "../ui/Status";
import { isRunningLogin, isRunningStatus, type SignInView } from "./useOAuthSignIns";

/** What the provider row needs to run a sign-in; null for a provider with none. */
export interface ProviderSignInControls {
  view: SignInView;
  start: (flow: OAuthFlow | null) => void;
  /** Resolves to the failure message, or null when the answer was taken. */
  submit: (text: string) => Promise<string | null>;
  cancel: () => void;
}

const FLOW_LABELS: Record<OAuthFlow, string> = {
  browser: "In your browser",
  device: "With a code",
  paste: "Paste a code",
};

/** The flows the provider offers, first (the default) first; empty when it has no in-app sign-in. */
export function signInFlows(provider: ProviderInfo): OAuthFlow[] {
  return provider.oauth?.flows.map((info) => info.flow) ?? [];
}

/** The row's one-word state while a sign-in is under way, or null when none is. */
export function signInBusyLabel(view: SignInView): string | null {
  if (view.busy === "starting") return "Starting sign-in…";
  if (view.busy === "cancelling") return "Cancelling…";
  const login = view.login;
  if (!isRunningLogin(login)) return null;
  if (login.status === "needs_input") return "Waiting for your answer…";
  return login.flow === "browser" ? "Waiting for browser…" : "Waiting for sign-in…";
}

export const SIGN_IN_STORAGE_NOTE =
  "A sign-in made here is used instead of the one from your OMP setup until you sign out. It is kept in a private database on this Mac and never written to OMP.";

/**
 * The way in: pick the method when the provider offers more than one (the first is the default) and start the
 * sign-in. Resuming works the same way: the runtime hands back the sign-in that is already running.
 */
export function SignInStart({
  provider,
  controls,
}: {
  provider: ProviderInfo;
  controls: ProviderSignInControls;
}) {
  const flows = signInFlows(provider);
  const [flow, setFlow] = useState<OAuthFlow | null>(flows[0] ?? null);
  const chosen = provider.oauth?.flows.find((info) => info.flow === flow);
  if (flows.length === 0) return null;
  const starting = controls.view.busy !== null;
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {flows.length > 1 && (
          <SegmentedControl
            label={`${provider.name} sign-in method`}
            value={flow ?? flows[0]}
            options={flows.map((value) => ({ value, label: FLOW_LABELS[value] }))}
            onChange={setFlow}
          />
        )}
        <Button disabled={starting} onClick={() => controls.start(flow)}>
          Sign in…
        </Button>
      </div>
      {chosen?.fixedPort && chosen.callbackPort !== null && (
        <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">
          This sign-in needs port {chosen.callbackPort} to be free. If another app is using it,
          choose another method.
        </p>
      )}
      <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">{SIGN_IN_STORAGE_NOTE}</p>
      {controls.view.failure && controls.view.login === null && (
        <p role="alert" className="m-0 text-xs text-error">
          {controls.view.failure}
        </p>
      )}
    </div>
  );
}

/** The short code of a device sign-in, large, with a button that copies it. */
function DeviceCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="flex items-center gap-2">
      <span
        aria-label="Sign-in code"
        className="rounded-md border border-border bg-bg-0 px-3 py-1.5 font-mono text-md font-semibold tracking-[0.12em] text-fg select-all"
      >
        {code}
      </span>
      <Button icon={<Copy aria-hidden className="size-icon-sm" />} onClick={copy}>
        {copied ? "Copied" : "Copy code"}
      </Button>
    </div>
  );
}

/** A prompt the sign-in asks (a code, a redirect URL, a domain). What was typed is sent and forgotten at once. */
function PromptForm({
  login,
  busy,
  onSubmit,
}: {
  login: OAuthLoginState;
  busy: boolean;
  onSubmit: (text: string) => Promise<string | null>;
}) {
  const prompt = login.prompt;
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  if (!prompt) return null;

  const send = async () => {
    const answer = text.trim();
    // A required prompt may take a blank answer as its default; the paste fallback needs something to send.
    if (!answer && prompt.optional) return setError("Paste the code or address first.");
    // Nothing of the answer stays in this component, whatever the outcome.
    setText("");
    setError(null);
    setError(await onSubmit(answer));
  };

  return (
    <form
      className="grid gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label htmlFor={id} className="text-xs leading-[15px] text-fg-2 text-pretty">
        {prompt.message}
      </label>
      <div className="flex items-center gap-1.5">
        <div
          className={cn(fieldBase, fieldSizes.md, "flex-1")}
          aria-invalid={error ? true : undefined}
        >
          <input
            id={id}
            type={prompt.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={prompt.placeholder ?? undefined}
            disabled={busy}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (error) setError(null);
            }}
            className={cn(fieldText, "font-mono")}
          />
        </div>
        <Button type="submit" disabled={busy}>
          Submit
        </Button>
      </div>
      {error && (
        <p role="alert" className="m-0 text-xs text-error">
          {error}
        </p>
      )}
    </form>
  );
}

/** The one line that says why a sign-in ended without success. */
function endedMessage(login: OAuthLoginState): string {
  switch (login.status) {
    case "cancelled":
      return "The sign-in was cancelled.";
    case "expired":
      return "The sign-in wasn't finished in time.";
    default:
      return login.error ?? "The sign-in didn't complete.";
  }
}

/**
 * A sign-in under way, inside the provider's row: what to do now (open the page, enter the code, answer a prompt),
 * Open again and Cancel; or, once it ended without success, the one-line reason and Try again. Everything the
 * runtime says is shown as plain text, and only an https address is ever a link.
 */
export function SignInProgress({
  provider,
  controls,
}: {
  provider: ProviderInfo;
  controls: ProviderSignInControls;
}) {
  const { view } = controls;
  const login = view.login;
  if (!login) return null;

  if (!isRunningStatus(login)) {
    const reason = endedMessage(login);
    return (
      <div className="grid gap-1.5">
        <p role="alert" className="m-0 text-xs leading-[15px] text-error text-pretty">
          {reason}
        </p>
        <div>
          <Button disabled={view.busy !== null} onClick={() => controls.start(login.flow)}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const url = parseHttpsUrl(login.authUrl);
  const busy = view.busy !== null;
  const waiting = signInBusyLabel(view);
  return (
    <div className="grid gap-2" data-signin={login.status}>
      {login.deviceCode ? (
        <>
          <p className="m-0 text-xs leading-[15px] text-fg-2 text-pretty">
            Open the page below and enter this code to sign in to {provider.name}.
          </p>
          <DeviceCode code={login.deviceCode} />
        </>
      ) : (
        login.instructions && (
          <p className="m-0 text-xs leading-[15px] text-fg-2 text-pretty">{login.instructions}</p>
        )
      )}
      {login.authUrl && !url && (
        <p className="m-0 text-xs leading-[15px] text-warning text-pretty">
          The sign-in address isn't a secure (https) link, so it wasn't opened.
        </p>
      )}
      {url && (
        <div className="flex min-w-0 items-center gap-2">
          <Button disabled={busy} onClick={() => openExternalUrl(login.authUrl)}>
            Open again
          </Button>
          <ExternalLink href={url.href} className="text-xs">
            {url.host}
          </ExternalLink>
        </div>
      )}
      {login.progress && (
        <p className="m-0 text-xs leading-[15px] text-fg-3 text-pretty">{login.progress}</p>
      )}
      {!login.deviceCode && !login.instructions && !url && login.status === "pending" && (
        <p className="m-0 inline-flex items-center gap-1.5 text-xs text-fg-3">
          <Spinner />
          {waiting ?? "Waiting…"}
        </p>
      )}
      {login.prompt && (
        <PromptForm
          key={`${login.id}:${login.prompt.message}`}
          login={login}
          busy={view.busy === "submitting"}
          onSubmit={controls.submit}
        />
      )}
      {view.failure && (
        <p role="alert" className="m-0 text-xs text-error">
          {view.failure}
        </p>
      )}
      <div>
        <Button variant="ghost" disabled={view.busy === "cancelling"} onClick={controls.cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
