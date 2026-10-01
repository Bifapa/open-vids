import { useCallback, useEffect, useRef, useState } from "react";
import type { OAuthFlow, OAuthLoginState } from "@hyperframes/agent-protocol";
import type { OAuthResult } from "../../agent/agentSettingsSlice";
import { t } from "../../i18n";
import { openExternalUrl } from "../../utils/openExternalUrl";

/** How often a running sign-in is asked where it is. */
export const SIGN_IN_POLL_MS = 1000;

/** One provider's sign-in as the Settings window shows it. */
export interface SignInView {
  /** The runtime's last word on the sign-in; null before the first start and after it was forgotten. */
  login: OAuthLoginState | null;
  /** A call in flight: the start, an answer being sent, or a cancel. */
  busy: "starting" | "submitting" | "cancelling" | null;
  /** Why the last call failed, in words for the user (the sign-in's own `error` is on `login`). */
  failure: string | null;
}

/** Whether a sign-in is still going: waiting for the user, or for the provider. */
export const isRunningStatus = (login: OAuthLoginState): boolean =>
  login.status === "pending" || login.status === "needs_input";

export const isRunningLogin = (login: OAuthLoginState | null): login is OAuthLoginState =>
  login !== null && isRunningStatus(login);

export interface SignInActions {
  start: (provider: string, flow: OAuthFlow | null) => Promise<OAuthResult>;
  poll: (loginId: string) => Promise<OAuthResult>;
  submit: (loginId: string, text: string) => Promise<OAuthResult>;
  cancel: (loginId: string) => Promise<OAuthResult>;
  /** Called once when a sign-in succeeded, to reload the providers and the model catalog. */
  onSucceeded: (provider: string) => void;
}

const IDLE: SignInView = { login: null, busy: null, failure: null };

/**
 * The in-app sign-ins of the open Settings section, by provider. A running sign-in is polled about once a second
 * with one interval that exists only while something runs; it stops on a final status and when the section goes
 * away. The authorization address is opened once per sign-in (https only) and can be opened again by hand.
 */
export function useOAuthSignIns(actions: SignInActions) {
  const [views, setViews] = useState<Readonly<Record<string, SignInView>>>({});
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const alive = useRef(true);
  const opened = useRef(new Set<string>());
  const polling = useRef(new Set<string>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const patch = useCallback((provider: string, change: Partial<SignInView>) => {
    if (!alive.current) return;
    setViews((current) => ({
      ...current,
      [provider]: { ...(current[provider] ?? IDLE), ...change },
    }));
  }, []);

  /** Takes a sign-in state in: opens its address the first time, and finishes a successful one. */
  const adopt = useCallback(
    (provider: string, login: OAuthLoginState) => {
      if (!alive.current) return;
      if (login.status === "succeeded") {
        setViews((current) => ({ ...current, [provider]: IDLE }));
        actionsRef.current.onSucceeded(provider);
        return;
      }
      if (isRunningLogin(login) && login.authUrl && !opened.current.has(login.id)) {
        opened.current.add(login.id);
        openExternalUrl(login.authUrl);
      }
      patch(provider, { login, busy: null, failure: null });
    },
    [patch],
  );

  const fail = useCallback(
    (provider: string, result: Extract<OAuthResult, { ok: false }>) => {
      patch(provider, {
        busy: null,
        // A sign-in the runtime forgot is not running any more: stop asking about it.
        ...(result.gone && { login: null }),
        failure: result.gone ? t("settings.studio.si.gone") : result.message,
      });
    },
    [patch],
  );

  const start = useCallback(
    async (provider: string, flow: OAuthFlow | null) => {
      if (viewsRef.current[provider]?.busy) return;
      patch(provider, { busy: "starting", failure: null, login: null });
      const result = await actionsRef.current.start(provider, flow);
      if (result.ok) adopt(provider, result.login);
      else fail(provider, result);
    },
    [patch, adopt, fail],
  );

  /** Resolves to the failure message, or null when the answer was taken. */
  const submit = useCallback(
    async (provider: string, text: string): Promise<string | null> => {
      const login = viewsRef.current[provider]?.login;
      if (!login || viewsRef.current[provider]?.busy) return null;
      patch(provider, { busy: "submitting", failure: null });
      const result = await actionsRef.current.submit(login.id, text);
      if (result.ok) {
        adopt(provider, result.login);
        return null;
      }
      fail(provider, result);
      return result.message;
    },
    [patch, adopt, fail],
  );

  const cancel = useCallback(
    async (provider: string) => {
      const login = viewsRef.current[provider]?.login;
      if (!login || viewsRef.current[provider]?.busy === "cancelling") return;
      patch(provider, { busy: "cancelling", failure: null });
      const result = await actionsRef.current.cancel(login.id);
      if (result.ok) adopt(provider, result.login);
      else fail(provider, result);
    },
    [patch, adopt, fail],
  );

  // One interval while any sign-in runs. `running` is a string so the effect restarts only when the set changes.
  const running = Object.entries(views)
    .filter(([, view]) => isRunningLogin(view.login))
    .map(([provider]) => provider)
    .join(",");
  useEffect(() => {
    if (!running) return;
    const tick = () => {
      for (const [provider, view] of Object.entries(viewsRef.current)) {
        const login = view.login;
        if (!isRunningLogin(login) || view.busy || polling.current.has(login.id)) continue;
        polling.current.add(login.id);
        void actionsRef.current.poll(login.id).then((result) => {
          polling.current.delete(login.id);
          if (!alive.current) return;
          if (result.ok) adopt(provider, result.login);
          else if (result.gone) fail(provider, result);
          // Any other failure is a hiccup: the next tick asks again.
        });
      }
    };
    const timer = window.setInterval(tick, SIGN_IN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, adopt, fail]);

  const viewOf = (provider: string): SignInView => views[provider] ?? IDLE;
  return { viewOf, start, submit, cancel };
}
