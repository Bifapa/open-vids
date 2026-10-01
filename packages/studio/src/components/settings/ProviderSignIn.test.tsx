// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ListProvidersResponse,
  OAuthLoginState,
  ProviderInfo,
} from "@hyperframes/agent-protocol";
import { AgentApiError } from "../../agent/agentClient";
import type { AgentStore } from "../../agent/agentStore";
import { oauthLogin, providerInfo } from "../../agent/agentTestHarness";
import { cleanupMounted } from "../ui/mountHost.testHelpers";
import { openSettings } from "./settingsStore";
import {
  buttonNamed,
  click,
  labelled,
  mountSettings,
  radio,
  resetDialog,
  resetPreferences,
  settle,
  type MountedSettings,
} from "./settingsDialog.testHelpers";
import { SIGN_IN_POLL_MS } from "./useOAuthSignIns";

const BROWSER_ONLY = {
  flows: [{ flow: "browser" as const, callbackPort: 54545, fixedPort: false }],
};
const CODEX = {
  flows: [
    { flow: "browser" as const, callbackPort: 1455, fixedPort: true },
    { flow: "device" as const, callbackPort: null, fixedPort: false },
  ],
};

const claude = (overrides: Partial<ProviderInfo> = {}) =>
  providerInfo({
    id: "anthropic",
    authenticated: false,
    status: "not_configured",
    credentialSource: null,
    oauth: BROWSER_ONLY,
    ...overrides,
  });
const codex = (overrides: Partial<ProviderInfo> = {}) =>
  providerInfo({
    id: "openai",
    name: "ChatGPT",
    authenticated: false,
    status: "not_configured",
    credentialSource: null,
    oauth: CODEX,
    ...overrides,
  });

let store: AgentStore | undefined;
let providers: ProviderInfo[] = [];
let open: ReturnType<typeof vi.spyOn>;
/** Timers the section itself keeps (the "Synced … ago" clock), so a test can tell a leaked sign-in timer. */
let baseline = 0;

beforeEach(() => {
  resetPreferences();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  open = vi.spyOn(window, "open").mockReturnValue(null);
});

afterEach(() => {
  store?.getState().dispose();
  store = undefined;
  resetDialog();
  cleanupMounted();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const list = (): ListProvidersResponse => ({ providers: [...providers], syncedAt: Date.now() });

async function mountSignIn(initial: ProviderInfo[]): Promise<MountedSettings> {
  providers = initial;
  const mounted = mountSettings(undefined, (created) => (store = created));
  mounted.client.listProviders.mockImplementation(async () => list());
  await act(async () => openSettings("providers"));
  await settle();
  baseline = vi.getTimerCount();
  return mounted;
}

const row = (id: string) => document.body.querySelector<HTMLElement>(`[data-provider="${id}"]`);
const text = (element: Element | null | undefined) => element?.textContent ?? "";
const inRow = (id: string) => row(id) ?? undefined;

/** Lets the poll timer fire `count` times, each followed by the answers it started. */
async function tick(count = 1) {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      vi.advanceTimersByTime(SIGN_IN_POLL_MS);
    });
    await settle();
  }
}

function type(input: HTMLInputElement | null | undefined, value: string) {
  if (!input) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const succeeded = (overrides: Partial<OAuthLoginState> = {}) =>
  oauthLogin({ status: "succeeded", authUrl: null, progress: null, ...overrides });

it("signs in through the browser: opens the address once, waits, polls, and can open it again or cancel", async () => {
  const { client } = await mountSignIn([claude()]);
  client.startOAuthLogin.mockResolvedValue(oauthLogin());
  client.getOAuthLogin.mockResolvedValue(oauthLogin());
  client.cancelOAuthLogin.mockResolvedValue(oauthLogin({ status: "cancelled", authUrl: null }));

  // One flow: "Sign in…" starts it at once, beside "Use an API key".
  expect(buttonNamed("Use an API key", inRow("anthropic"))).toBeDefined();
  await click(buttonNamed("Sign in…", inRow("anthropic")));
  expect(client.startOAuthLogin).toHaveBeenCalledWith("anthropic", {});
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith(
    "https://claude.example/oauth/authorize?state=abc",
    "_blank",
    "noopener,noreferrer",
  );
  expect(row("anthropic")?.querySelector('[role="status"]')?.textContent).toBe(
    "Waiting for browser…",
  );
  expect(text(row("anthropic"))).toContain("Waiting for browser authentication…");
  expect(text(row("anthropic"))).toContain("claude.example");

  // About once a second, and the address is not opened again by polling.
  expect(client.getOAuthLogin).not.toHaveBeenCalled();
  await tick(3);
  expect(client.getOAuthLogin).toHaveBeenCalledTimes(3);
  expect(client.getOAuthLogin).toHaveBeenCalledWith("login-0001");
  expect(open).toHaveBeenCalledTimes(1);

  await click(buttonNamed("Open again", inRow("anthropic")));
  expect(open).toHaveBeenCalledTimes(2);

  await click(buttonNamed("Cancel", inRow("anthropic")));
  expect(client.cancelOAuthLogin).toHaveBeenCalledWith("login-0001");
  expect(text(row("anthropic"))).toContain("The sign-in was cancelled.");
  expect(buttonNamed("Try again", inRow("anthropic"))).toBeDefined();
  // A final status stops the polling: the interval is gone.
  const polls = client.getOAuthLogin.mock.calls.length;
  await tick(3);
  expect(client.getOAuthLogin).toHaveBeenCalledTimes(polls);
  expect(vi.getTimerCount()).toBeLessThanOrEqual(baseline);
});

it("shows the provider as connected after a successful sign-in, and offers Sign out only for that credential", async () => {
  const { client } = await mountSignIn([claude(), providerInfo({ id: "google" })]);
  client.startOAuthLogin.mockResolvedValue(oauthLogin());
  client.getOAuthLogin.mockResolvedValueOnce(oauthLogin()).mockResolvedValue(succeeded());
  await click(buttonNamed("Sign in…", inRow("anthropic")));

  providers = [claude({ authenticated: true, status: "connected", credentialSource: "oauth" })];
  const listed = client.listProviders.mock.calls.length;
  await tick(2);
  // As after saving a key: the providers and the model catalog are read again.
  expect(client.listProviders.mock.calls.length).toBeGreaterThan(listed);
  expect(client.listModels).toHaveBeenCalled();
  expect(text(row("anthropic"))).toContain("Connected");
  expect(text(row("anthropic"))).toContain("Signed in here");
  expect(vi.getTimerCount()).toBeLessThanOrEqual(baseline);

  expect(text(row("anthropic"))).toContain("doesn't revoke access at Anthropic");
  client.logoutProvider.mockImplementation(async () => {
    providers = [claude()];
    return list();
  });
  await click(buttonNamed("Sign out", inRow("anthropic")));
  expect(client.logoutProvider).toHaveBeenCalledWith("anthropic");
  expect(text(row("anthropic"))).toContain("Not configured");
});

it("does not offer Sign out for a connection from OMP or a stored key", async () => {
  await mountSignIn([
    claude({ authenticated: true, status: "connected", credentialSource: "omp" }),
    codex({ authenticated: true, status: "connected", credentialSource: "api-key" }),
  ]);
  await click(labelled("Show Anthropic details"));
  await click(labelled("Show ChatGPT details"));
  expect(buttonNamed("Sign out")).toBeUndefined();
  expect(text(row("anthropic"))).toContain("can only be changed there");
});

it("lets the user pick between flows, defaulting to the first, and shows a device code to copy", async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const { client } = await mountSignIn([codex()]);
  const device = oauthLogin({
    provider: "openai",
    flow: "device",
    authUrl: "https://auth.example/device",
    deviceCode: "ABCD-1234",
    instructions: "Enter code: ABCD-1234",
    progress: null,
  });
  client.startOAuthLogin.mockResolvedValue(device);
  client.getOAuthLogin.mockResolvedValue(device);

  // Two flows: the button opens the row to choose; nothing starts yet.
  await click(buttonNamed("Sign in…", inRow("openai")));
  expect(client.startOAuthLogin).not.toHaveBeenCalled();
  expect(radio("ChatGPT sign-in method", "In your browser")?.getAttribute("aria-checked")).toBe(
    "true",
  );
  // The default flow's fixed port is named, so a clash is no surprise.
  expect(text(row("openai"))).toContain("needs port 1455 to be free");

  await click(radio("ChatGPT sign-in method", "With a code"));
  await click(buttonNamed("Sign in…", inRow("openai")));
  expect(client.startOAuthLogin).toHaveBeenCalledWith("openai", { flow: "device" });
  expect(open).toHaveBeenCalledWith("https://auth.example/device", "_blank", "noopener,noreferrer");

  expect(labelled("Sign-in code", row("openai") ?? document.body)?.textContent).toBe("ABCD-1234");
  // The instructions repeat the code, so the code stands alone; the link is shown for copying.
  expect(text(row("openai"))).not.toContain("Enter code: ABCD-1234");
  expect(text(row("openai"))).toContain("auth.example");
  await click(buttonNamed("Copy code", inRow("openai")));
  expect(writeText).toHaveBeenCalledWith("ABCD-1234");
  expect(buttonNamed("Copied", inRow("openai"))).toBeDefined();
  await act(async () => {
    vi.advanceTimersByTime(2500);
  });
  expect(buttonNamed("Copy code", inRow("openai"))).toBeDefined();
});

it("falls back to the provider's instructions when no device code could be told apart", async () => {
  const { client } = await mountSignIn([codex()]);
  client.startOAuthLogin.mockResolvedValue(
    oauthLogin({
      provider: "openai",
      flow: "device",
      authUrl: "https://auth.example/device",
      instructions: "Visit the page and type the code WXYZ-9876",
      progress: null,
    }),
  );
  await click(buttonNamed("Sign in…", inRow("openai")));
  await click(radio("ChatGPT sign-in method", "With a code"));
  await click(buttonNamed("Sign in…", inRow("openai")));
  expect(text(row("openai"))).toContain("Visit the page and type the code WXYZ-9876");
  expect(labelled("Sign-in code")).toBeNull();
});

it("asks a required prompt, masks a secret, and forgets the answer once it is sent", async () => {
  const { client } = await mountSignIn([claude()]);
  const asking = oauthLogin({
    status: "needs_input",
    authUrl: null,
    progress: null,
    prompt: {
      message: "Enter your GitHub Enterprise domain",
      placeholder: "github.example.com",
      secret: true,
      optional: false,
    },
  });
  client.startOAuthLogin.mockResolvedValue(asking);
  client.getOAuthLogin.mockResolvedValue(asking);
  client.submitOAuthLoginInput.mockResolvedValue(oauthLogin());

  await click(buttonNamed("Sign in…", inRow("anthropic")));
  expect(row("anthropic")?.querySelector('[role="status"]')?.textContent).toBe(
    "Waiting for your answer…",
  );
  const input = row("anthropic")?.querySelector<HTMLInputElement>("input");
  expect(input?.type).toBe("password");
  expect(input?.autocomplete).toBe("off");
  expect(input?.placeholder).toBe("github.example.com");
  expect(text(row("anthropic"))).toContain("Enter your GitHub Enterprise domain");

  type(input, "ghe-secret.example.com");
  await click(buttonNamed("Submit", inRow("anthropic")));
  expect(client.submitOAuthLoginInput).toHaveBeenCalledWith("login-0001", {
    text: "ghe-secret.example.com",
  });
  // Sent and forgotten: not in a field, not in the page.
  expect(document.body.innerHTML).not.toContain("ghe-secret");
  expect([...document.body.querySelectorAll("input")].every((field) => field.value === "")).toBe(
    true,
  );
});

it("takes a pasted code as a fallback while the browser callback may still finish, with a visible field", async () => {
  const { client } = await mountSignIn([claude()]);
  const waiting = oauthLogin({
    prompt: {
      message: "Or paste the code or redirect URL from the browser",
      placeholder: null,
      secret: false,
      optional: true,
    },
  });
  client.startOAuthLogin.mockResolvedValue(waiting);
  client.getOAuthLogin.mockResolvedValue(waiting);
  client.submitOAuthLoginInput.mockResolvedValue(succeeded());
  await click(buttonNamed("Sign in…", inRow("anthropic")));

  expect(buttonNamed("Open again", inRow("anthropic"))).toBeDefined();
  const input = row("anthropic")?.querySelector<HTMLInputElement>("input");
  expect(input?.type).toBe("text");
  type(input, "http://localhost:54545/callback?code=zzz");
  providers = [claude({ authenticated: true, status: "connected", credentialSource: "oauth" })];
  await click(buttonNamed("Submit", inRow("anthropic")));
  expect(client.submitOAuthLoginInput).toHaveBeenCalledWith("login-0001", {
    text: "http://localhost:54545/callback?code=zzz",
  });
  expect(text(row("anthropic"))).toContain("Signed in here");
});

it("shows a failed sign-in's one-line reason and starts again from Try again", async () => {
  const { client } = await mountSignIn([codex()]);
  client.startOAuthLogin.mockResolvedValueOnce(
    oauthLogin({
      provider: "openai",
      status: "failed",
      authUrl: null,
      progress: null,
      error: "Port 1455 is already in use. Is the Codex CLI running?",
    }),
  );
  await click(buttonNamed("Sign in…", inRow("openai")));
  await click(buttonNamed("Sign in…", inRow("openai")));
  expect(text(row("openai")?.querySelector('[role="alert"]'))).toBe(
    "Port 1455 is already in use. Is the Codex CLI running?",
  );
  expect(open).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBeLessThanOrEqual(baseline);
  // The other ways in stay available beside the reason.
  expect(row("openai")?.querySelector('input[type="password"]')).not.toBeNull();

  client.startOAuthLogin.mockResolvedValueOnce(oauthLogin({ provider: "openai" }));
  await click(buttonNamed("Try again", inRow("openai")));
  expect(client.startOAuthLogin).toHaveBeenLastCalledWith("openai", { flow: "browser" });
  expect(text(row("openai"))).toContain("Waiting for browser authentication…");
});

it("says so when a sign-in expired or the start call failed", async () => {
  const { client } = await mountSignIn([claude()]);
  client.startOAuthLogin.mockResolvedValueOnce(oauthLogin());
  client.getOAuthLogin.mockResolvedValue(oauthLogin({ status: "expired", authUrl: null }));
  await click(buttonNamed("Sign in…", inRow("anthropic")));
  await tick();
  expect(text(row("anthropic"))).toContain("The sign-in wasn't finished in time.");

  client.startOAuthLogin.mockRejectedValueOnce(
    new AgentApiError("runtime_unavailable", "down", 503),
  );
  await click(buttonNamed("Try again", inRow("anthropic")));
  expect(text(row("anthropic")?.querySelector('[role="alert"]'))).toBe(
    "The agent isn't running right now. Your project is untouched.",
  );
});

it("stops asking about a sign-in the runtime has forgotten", async () => {
  const { client } = await mountSignIn([claude()]);
  client.startOAuthLogin.mockResolvedValue(oauthLogin());
  client.getOAuthLogin.mockRejectedValue(new AgentApiError("internal", "login_not_found", 404));
  await click(buttonNamed("Sign in…", inRow("anthropic")));
  await tick();
  expect(text(row("anthropic"))).toContain("no longer running");
  const polls = client.getOAuthLogin.mock.calls.length;
  await tick(3);
  expect(client.getOAuthLogin).toHaveBeenCalledTimes(polls);
  expect(vi.getTimerCount()).toBeLessThanOrEqual(baseline);
});

it("opens only https addresses and shows nothing the runtime says as markup", async () => {
  const { client } = await mountSignIn([claude()]);
  client.startOAuthLogin.mockResolvedValue(
    oauthLogin({
      authUrl: "javascript:alert(1)",
      instructions: "<img src=x onerror=alert(1)> Sign in",
      progress: null,
    }),
  );
  await click(buttonNamed("Sign in…", inRow("anthropic")));
  expect(open).not.toHaveBeenCalled();
  expect(buttonNamed("Open again", inRow("anthropic"))).toBeUndefined();
  expect(row("anthropic")?.querySelector("a")).toBeNull();
  expect(text(row("anthropic"))).toContain("isn't a secure (https) link");
  // The instructions are text, not an element.
  expect(row("anthropic")?.querySelector("img")).toBeNull();
  expect(text(row("anthropic"))).toContain("<img src=x onerror=alert(1)> Sign in");
});

it("stops polling when the section goes away, and a later sign-in resumes the same one", async () => {
  const { client } = await mountSignIn([claude()]);
  client.startOAuthLogin.mockResolvedValue(oauthLogin());
  client.getOAuthLogin.mockResolvedValue(oauthLogin());
  await click(buttonNamed("Sign in…", inRow("anthropic")));
  await tick(2);
  expect(client.getOAuthLogin).toHaveBeenCalledTimes(2);

  // Switching section unmounts Models & Providers: no timer is left and no poll is made.
  await act(async () => {
    const { useSettingsDialog } = await import("./settingsStore");
    useSettingsDialog.getState().setSection("general");
  });
  await settle();
  expect(vi.getTimerCount()).toBe(0);
  const polls = client.getOAuthLogin.mock.calls.length;
  await tick(3);
  expect(client.getOAuthLogin).toHaveBeenCalledTimes(polls);

  // Coming back and starting again hands back the sign-in that is running (the runtime answers with the same id).
  await act(async () => {
    const { useSettingsDialog } = await import("./settingsStore");
    useSettingsDialog.getState().setSection("providers");
  });
  await settle();
  await click(buttonNamed("Sign in…", inRow("anthropic")));
  expect(client.startOAuthLogin).toHaveBeenCalledTimes(2);
  expect(text(row("anthropic"))).toContain("Waiting for browser authentication…");
});
