import { describe, expect, it } from "vitest";
import { RuntimeError } from "./errors.js";
import {
  OAuthLogins,
  extractDeviceCode,
  sanitizeLoginMessage,
  type LoginController,
  type LoginRunner,
  type OAuthLoginsOptions,
} from "./oauthLogins.js";

const START = { provider: "anthropic", loginId: "anthropic", flow: "browser" } as const;

function logins(run: LoginRunner, options: Partial<OAuthLoginsOptions> = {}) {
  let counter = 0;
  return new OAuthLogins({
    run,
    ids: () => `login-${(counter += 1).toString().padStart(8, "0")}`,
    firstStateWaitMs: 30,
    stopGraceMs: 25,
    ...options,
  });
}

/** A runner that stands in for the SDK's callback flow: it "listens" until its signal aborts, then lets go. */
function listening(onAuth?: (controller: LoginController) => void) {
  const server = { open: false, closed: 0 };
  const run: LoginRunner = async (_id, controller) => {
    server.open = true;
    try {
      onAuth?.(controller);
      await new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    } finally {
      server.open = false;
      server.closed += 1;
    }
  };
  return { run, server };
}

const never = () => new Promise<void>(() => {});

describe("sign-in states", () => {
  it("answers a start with the URL the user must open, and keeps the state pollable through success", async () => {
    const succeeded: string[] = [];
    const finish = Promise.withResolvers<void>();
    const store = logins(
      async (_id, controller) => {
        controller.onProgress("Waiting for browser authentication...");
        controller.onAuth({
          url: "https://claude.example/authorize?x=1",
          instructions: "Finish in the browser",
        });
        await finish.promise;
      },
      { onSucceeded: async (provider) => void succeeded.push(provider) },
    );
    const started = await store.start(START);
    expect(started).toMatchObject({
      provider: "anthropic",
      status: "pending",
      flow: "browser",
      authUrl: "https://claude.example/authorize?x=1",
      instructions: "Finish in the browser",
      progress: "Waiting for browser authentication...",
      prompt: null,
      error: null,
    });
    expect(started.id).toBe("login-00000001");
    expect(started.expiresAt).toBeGreaterThan(started.startedAt);
    expect(store.get(started.id).status).toBe("pending");

    finish.resolve();
    await expect.poll(() => store.get(started.id).status).toBe("succeeded");
    expect(succeeded).toEqual(["anthropic"]);
    expect(store.get(started.id).authUrl).toBe("https://claude.example/authorize?x=1");
    await store.dispose();
  });

  it("returns a device code next to its verification URL", async () => {
    const store = logins(async (_id, controller) => {
      controller.onAuth({
        url: "https://github.example/login/device",
        instructions: "Enter code: ABCD-1234",
      });
      await never();
    });
    const state = await store.start({
      provider: "github-copilot",
      loginId: "github-copilot",
      flow: "device",
    });
    expect(state).toMatchObject({
      authUrl: "https://github.example/login/device",
      instructions: "Enter code: ABCD-1234",
      deviceCode: "ABCD-1234",
    });
    await store.cancel(state.id);
    await store.dispose();
  });

  it("does not wait forever for a sign-in that has nothing to show yet", async () => {
    const store = logins(never, { firstStateWaitMs: 20 });
    const state = await store.start(START);
    expect(state).toMatchObject({ status: "pending", authUrl: null, prompt: null });
    await store.dispose();
  });

  it("fails with one safe line: no token, no code, no query", async () => {
    const secret = "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const store = logins(async () => {
      throw new Error(
        `Token exchange failed (400)\n  invalid_grant for ${secret} at https://x.example/cb?code=abc123&state=zzz`,
      );
    });
    const state = await store.start(START);
    expect(state.status).toBe("failed");
    expect(state.error).not.toContain(secret);
    expect(state.error).not.toContain("abc123");
    expect(state.error).not.toContain("\n");
    expect(state.error).toContain("Token exchange failed");
    expect(JSON.stringify(state)).not.toContain(secret);
    await store.dispose();
  });

  it("shows a port conflict as the failure it is", async () => {
    const store = logins(async () => {
      throw new Error(
        "OAuth callback port 1455 is in use. Free port 1455 (e.g. stop the process bound to it) and retry",
      );
    });
    const state = await store.start({
      provider: "openai-codex",
      loginId: "openai-codex",
      flow: "browser",
    });
    expect(state).toMatchObject({ status: "failed" });
    expect(state.error).toContain("port 1455 is in use");
    await store.dispose();
  });

  it("runs one sign-in per provider and reuses it, but starts a new one once it has ended", async () => {
    let runs = 0;
    const listener = listening();
    const store = logins((id, controller) => {
      runs += 1;
      return listener.run(id, controller);
    });
    const first = await store.start(START);
    const again = await store.start(START);
    expect(again.id).toBe(first.id);
    expect(runs).toBe(1);
    // Another provider is independent.
    const other = await store.start({
      provider: "openrouter",
      loginId: "openrouter",
      flow: "browser",
    });
    expect(other.id).not.toBe(first.id);
    expect(runs).toBe(2);

    await store.cancel(first.id);
    const fresh = await store.start(START);
    expect(fresh.id).not.toBe(first.id);
    expect(runs).toBe(3);
    await store.dispose();
  });

  it("refuses to run more sign-ins than its limit", async () => {
    const store = logins(never, { maxActive: 2 });
    await store.start({ provider: "a", loginId: "a", flow: "device" });
    await store.start({ provider: "b", loginId: "b", flow: "device" });
    await expect(
      store.start({ provider: "c", loginId: "c", flow: "device" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      status: 409,
    });
    await store.dispose();
  });

  it("asks a required question before the URL exists, and takes the answer without ever showing it", async () => {
    const answers: string[] = [];
    const store = logins(async (_id, controller) => {
      answers.push(
        await controller.onPrompt({
          message: "GitHub Enterprise URL/domain (blank for github.com)",
        }),
      );
      controller.onAuth({
        url: "https://github.example/login/device",
        instructions: "Enter code: WXYZ-9876",
      });
      await never();
    });
    const asked = await store.start({
      provider: "github-copilot",
      loginId: "github-copilot",
      flow: "device",
    });
    expect(asked).toMatchObject({
      status: "needs_input",
      authUrl: null,
      prompt: {
        message: "GitHub Enterprise URL/domain (blank for github.com)",
        optional: false,
        secret: false,
      },
    });
    const answered = store.submit(asked.id, "corp.example.com");
    expect(answered).toMatchObject({ status: "pending", prompt: null });
    await expect
      .poll(() => store.get(asked.id).authUrl)
      .toBe("https://github.example/login/device");
    expect(answers).toEqual(["corp.example.com"]);
    expect(JSON.stringify(store.get(asked.id))).not.toContain("corp.example.com");
    // Nothing is waiting any more.
    expect(() => store.submit(asked.id, "again")).toThrowError(RuntimeError);
    await store.dispose();
  });

  it("offers a pasted code as an optional fallback while the browser can still finish the sign-in", async () => {
    const received: string[] = [];
    const store = logins(async (_id, controller) => {
      controller.onAuth({ url: "https://claude.example/authorize" });
      received.push(
        await controller.onPrompt({
          message: "Paste the authorization code (or full redirect URL):",
          secret: true,
        }),
      );
    });
    const state = await store.start(START);
    expect(state.status).toBe("pending");
    expect(state.prompt).toMatchObject({ optional: true, secret: true });
    store.submit(state.id, "pasted-code-value");
    await expect.poll(() => store.get(state.id).status).toBe("succeeded");
    expect(received).toEqual(["pasted-code-value"]);
    expect(JSON.stringify(store.get(state.id))).not.toContain("pasted-code-value");
    await store.dispose();
  });

  it("rejects an answer when nothing is waiting for one, and an unknown sign-in", async () => {
    const listener = listening();
    const store = logins(listener.run);
    const state = await store.start(START);
    expect(() => store.submit(state.id, "x")).toThrowError(
      expect.objectContaining({ status: 409, code: "invalid_request" }),
    );
    expect(() => store.get("nope")).toThrowError(
      expect.objectContaining({ status: 404, code: "login_not_found" }),
    );
    await expect(store.cancel("nope")).rejects.toMatchObject({ code: "login_not_found" });
    await store.dispose();
  });
});

describe("ending a sign-in", () => {
  it("cancels at once, aborts the runner and waits until it let go of its listener", async () => {
    const listener = listening((controller) =>
      controller.onAuth({ url: "https://claude.example/authorize" }),
    );
    const store = logins(listener.run);
    const state = await store.start(START);
    expect(listener.server.open).toBe(true);
    const cancelled = await store.cancel(state.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toBeNull();
    expect(listener.server).toEqual({ open: false, closed: 1 });
    // Cancelling a finished sign-in is harmless and changes nothing.
    expect((await store.cancel(state.id)).status).toBe("cancelled");
    expect(listener.server.closed).toBe(1);
    await store.dispose();
  });

  it("rejects a prompt that is waiting when the sign-in is cancelled", async () => {
    let prompted: Promise<string> | null = null;
    const store = logins(async (_id, controller) => {
      prompted = controller.onPrompt({ message: "Code?" });
      await prompted;
    });
    const state = await store.start(START);
    expect(state.status).toBe("needs_input");
    await store.cancel(state.id);
    await expect(prompted).rejects.toThrow("ended");
    expect(store.get(state.id)).toMatchObject({ status: "cancelled", prompt: null });
    await store.dispose();
  });

  it("gives up an unfinished sign-in after its time limit and frees the listener", async () => {
    const listener = listening((controller) =>
      controller.onAuth({ url: "https://claude.example/authorize" }),
    );
    const store = logins(listener.run, { timeoutMs: 40 });
    const state = await store.start(START);
    await expect.poll(() => store.get(state.id).status).toBe("expired");
    await expect.poll(() => listener.server.closed).toBe(1);
    expect(listener.server.open).toBe(false);
    expect(store.get(state.id).error).toBeNull();
    await store.dispose();
  });

  it("forgets a finished sign-in after the retention time", async () => {
    const store = logins(async () => {}, { retainMs: 30 });
    const state = await store.start(START);
    expect(state.status).toBe("succeeded");
    await expect
      .poll(() => {
        try {
          store.get(state.id);
          return "known";
        } catch {
          return "gone";
        }
      })
      .toBe("gone");
    await store.dispose();
  });

  it("cancels every sign-in on shutdown, closes their listeners and refuses new ones", async () => {
    const a = listening((controller) => controller.onAuth({ url: "https://a.example/authorize" }));
    const b = listening((controller) => controller.onAuth({ url: "https://b.example/authorize" }));
    const store = logins((id, controller) =>
      id === "a" ? a.run(id, controller) : b.run(id, controller),
    );
    await store.start({ provider: "a", loginId: "a", flow: "browser" });
    await store.start({ provider: "b", loginId: "b", flow: "browser" });
    expect([a.server.open, b.server.open]).toEqual([true, true]);
    await store.dispose();
    expect([a.server, b.server]).toEqual([
      { open: false, closed: 1 },
      { open: false, closed: 1 },
    ]);
    await expect(store.start(START)).rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it("does not report success for a sign-in that was cancelled while its runner was finishing", async () => {
    const release = Promise.withResolvers<void>();
    const store = logins(async (_id, controller) => {
      controller.onAuth({ url: "https://claude.example/authorize" });
      await release.promise;
    });
    const state = await store.start(START);
    const cancelling = store.cancel(state.id);
    release.resolve();
    expect((await cancelling).status).toBe("cancelled");
    await store.dispose();
  });
});

describe("what reaches a state", () => {
  it("sanitizes messages to one bounded line without token-like strings", () => {
    const token = "A".repeat(40);
    const clean = sanitizeLoginMessage(`bad\n  grant ${token} ${"x ".repeat(300)}`);
    expect(clean).not.toContain(token);
    expect(clean).not.toContain("\n");
    expect(clean.length).toBeLessThanOrEqual(300);
    expect(sanitizeLoginMessage("callback ?code=abc&state=def failed")).toBe("callback failed");
    expect(sanitizeLoginMessage("Waiting for browser authentication...")).toBe(
      "Waiting for browser authentication...",
    );
  });

  it("finds the device code in the provider's wording and leaves it null when unsure", () => {
    expect(extractDeviceCode("Enter code: ABCD-1234")).toBe("ABCD-1234");
    expect(extractDeviceCode("Open the page and enter code: WDJB-MJHT to continue")).toBe(
      "WDJB-MJHT",
    );
    expect(extractDeviceCode("Your code is HKQM-4821")).toBe("HKQM-4821");
    expect(extractDeviceCode("Complete login in your browser.")).toBeNull();
    expect(extractDeviceCode(null)).toBeNull();
  });
});
