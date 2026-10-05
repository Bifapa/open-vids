import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@hyperframes/agent-protocol";
import { RuntimeError } from "./errors.js";
import { PermissionBroker, type PermissionBrokerOptions } from "./permissions.js";
import { ResearchToolError } from "./research/host.js";
import { FakeResearchHost } from "./testing/research.js";

function broker(overrides: Partial<PermissionBrokerOptions> = {}) {
  const host = new FakeResearchHost();
  const published: PermissionRequest[] = [];
  let id = 0;
  const options: PermissionBrokerOptions = {
    turnId: "turn-1",
    host,
    publish: async (permission) => {
      published.push(permission);
    },
    now: () => 1_700_000_000_000 + published.length,
    ids: () => `perm-${++id}`,
    ...overrides,
  };
  const instance = new PermissionBroker(options);
  const ask = (kind: "read_linked_pages" | "website_full_access", site: string | null = null) =>
    instance.ask({
      kind,
      action: kind === "read_linked_pages" ? "read" : "download",
      site,
      agent: "director",
    });
  return { host, published, instance, ask };
}

describe("the permission broker", () => {
  it("publishes a pending request and resolves it when the user answers once", async () => {
    const { host, published, instance, ask } = broker();
    const waiting = ask("read_linked_pages", "linear.app");
    // The publish is awaited inside ask(); let the microtask run.
    await Promise.resolve();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      id: "perm-1",
      kind: "read_linked_pages",
      action: "read",
      site: "linear.app",
      agent: "director",
      state: "pending",
    });

    const answered = await instance.answer("perm-1", "once");
    expect(answered.state).toBe("allowed_once");
    expect(answered.answeredAt).toBeGreaterThan(0);
    expect(host.grants).toEqual([{ turnId: "turn-1", access: "read" }]);
    expect(host.policyUpdates).toEqual([]);
    await expect(waiting).resolves.toMatchObject({ id: "perm-1", state: "allowed_once" });
    // The answer updates the same part, not a new one.
    expect(published.map((permission) => permission.state)).toEqual(["pending", "allowed_once"]);
  });

  it("shares one pending request between concurrent asks of the same kind", async () => {
    const { published, instance, ask } = broker();
    const first = ask("read_linked_pages");
    const second = ask("read_linked_pages");
    await Promise.resolve();
    expect(published).toHaveLength(1);
    expect(published[0]?.id).toBe("perm-1");

    await instance.answer("perm-1", "deny");
    await expect(first).resolves.toMatchObject({ state: "denied" });
    await expect(second).resolves.toMatchObject({ state: "denied" });
    expect(published.map((permission) => permission.id)).toEqual(["perm-1", "perm-1"]);
  });

  it("does not ask again after an answer: an allowed kind proceeds, a denied kind stays refused", async () => {
    const { host, published, instance, ask } = broker();
    const waiting = ask("website_full_access", "linear.app");
    await Promise.resolve();
    await instance.answer("perm-1", "once");
    await waiting;

    const again = await ask("website_full_access", "linear.app");
    expect(again).toMatchObject({ id: "perm-1", state: "allowed_once" });
    expect(host.grants).toHaveLength(1);
    expect(published).toHaveLength(2);

    const denied = broker();
    const refused = denied.ask("read_linked_pages");
    await Promise.resolve();
    await denied.instance.answer("perm-1", "deny");
    await refused;
    expect(await denied.ask("read_linked_pages")).toMatchObject({ state: "denied" });
    expect(denied.published).toHaveLength(2);
  });

  it("lets an answered full-access request cover a later reading ask (full includes reading)", async () => {
    const { published, instance, ask } = broker();
    const full = ask("website_full_access", "linear.app");
    await Promise.resolve();
    await instance.answer("perm-1", "once");
    await full;

    const reading = await ask("read_linked_pages", "linear.app");
    expect(reading).toMatchObject({
      id: "perm-1",
      kind: "website_full_access",
      state: "allowed_once",
    });
    expect(published).toHaveLength(2);
  });

  it("switches the setting on for always: reading alone, or both switches for full access", async () => {
    const reading = broker();
    const waiting = reading.ask("read_linked_pages", "linear.app");
    await Promise.resolve();
    const enabled = await reading.instance.answer("perm-1", "always");
    expect(enabled.state).toBe("enabled");
    expect(reading.host.policyUpdates).toEqual([{ websites: { readLinkedPages: true } }]);
    expect(reading.host.grants).toEqual([]);
    await expect(waiting).resolves.toMatchObject({ state: "enabled" });

    const full = broker();
    const waitingFull = full.ask("website_full_access", "linear.app");
    await Promise.resolve();
    await full.instance.answer("perm-1", "always");
    expect(full.host.policyUpdates).toEqual([
      { websites: { readLinkedPages: true, fullAccess: true } },
    ]);
    await expect(waitingFull).resolves.toMatchObject({ state: "enabled" });
  });

  it("refuses a second answer, an unknown request, and an answer after expiry with turn_not_active", async () => {
    const { instance, ask } = broker();
    const waiting = ask("read_linked_pages");
    await Promise.resolve();
    await instance.answer("perm-1", "deny");
    await waiting;
    for (const answer of [instance.answer("perm-1", "once"), instance.answer("unknown", "once")]) {
      await expect(answer).rejects.toMatchObject({ code: "turn_not_active", status: 409 });
      await expect(answer).rejects.toBeInstanceOf(RuntimeError);
    }

    const expired = broker();
    const pending = expired.ask("read_linked_pages");
    await Promise.resolve();
    await expired.instance.expireAll();
    await expect(pending).resolves.toMatchObject({ state: "expired" });
    await expect(expired.instance.answer("perm-1", "once")).rejects.toMatchObject({
      code: "turn_not_active",
    });
  });

  it("keeps the request pending when Studio cannot apply the answer, so the user can retry", async () => {
    const { host, published, instance, ask } = broker();
    const waiting = ask("read_linked_pages");
    await Promise.resolve();
    host.nextPermissionError = new ResearchToolError("studio_unavailable", "down");
    await expect(instance.answer("perm-1", "always")).rejects.toMatchObject({
      code: "runtime_unavailable",
      status: 503,
    });
    // Still pending: a retry with a working Studio answers it.
    await expect(instance.answer("perm-1", "once")).resolves.toMatchObject({
      state: "allowed_once",
    });
    await expect(waiting).resolves.toMatchObject({ state: "allowed_once" });
    expect(published.map((permission) => permission.state)).toEqual(["pending", "allowed_once"]);
  });

  it("expires pending requests when the turn aborts, and never hangs a late ask", async () => {
    const controller = new AbortController();
    const { published, instance, ask } = broker({ signal: controller.signal });
    const waiting = ask("website_full_access", "linear.app");
    await Promise.resolve();
    controller.abort();
    await expect(waiting).resolves.toMatchObject({ state: "expired" });
    expect(published.map((permission) => permission.state)).toEqual(["pending", "expired"]);
    // After the turn ended nothing new can be shown: the ask answers as expired at once.
    const late = await ask("read_linked_pages");
    expect(late.state).toBe("expired");
    expect(published).toHaveLength(2);
    expect(instance.allowsWebsiteDownload()).toBe(false);
  });

  it("counts an allowed download or recording card as the turn's website download approval", async () => {
    const once = broker();
    const waiting = once.ask("website_full_access");
    await Promise.resolve();
    expect(once.instance.allowsWebsiteDownload()).toBe(false);
    await once.instance.answer("perm-1", "once");
    await waiting;
    expect(once.instance.allowsWebsiteDownload()).toBe(true);

    const recording = broker();
    const recorded = recording.instance.ask({
      kind: "website_full_access",
      action: "record",
      site: null,
      agent: "director",
    });
    await Promise.resolve();
    await recording.instance.answer("perm-1", "always");
    await recorded;
    expect(recording.instance.allowsWebsiteDownload()).toBe(true);

    const denied = broker();
    const refused = denied.ask("website_full_access");
    await Promise.resolve();
    await denied.instance.answer("perm-1", "deny");
    await refused;
    expect(denied.instance.allowsWebsiteDownload()).toBe(false);
  });

  it("does not count an answer to an open-page or read-code card as a download approval", async () => {
    for (const action of ["read", "read_code"] as const) {
      for (const decision of ["once", "always"] as const) {
        const { instance } = broker();
        const waiting = instance.ask({
          kind: action === "read" ? "read_linked_pages" : "website_full_access",
          action,
          site: "linear.app",
          agent: "director",
        });
        await Promise.resolve();
        await instance.answer("perm-1", decision);
        await waiting;
        expect(instance.allowsWebsiteDownload(), `${action} ${decision}`).toBe(false);
      }
    }
  });

  it("revokes the turn's grant only when one was posted", async () => {
    const granted = broker();
    const waiting = granted.ask("website_full_access");
    await Promise.resolve();
    await granted.instance.answer("perm-1", "once");
    await waiting;
    await granted.instance.revokeGrant();
    expect(granted.host.revokedGrants).toEqual(["turn-1"]);

    const denied = broker();
    const refused = denied.ask("read_linked_pages");
    await Promise.resolve();
    await denied.instance.answer("perm-1", "deny");
    await refused;
    await denied.instance.revokeGrant();
    expect(denied.host.revokedGrants).toEqual([]);
  });

  it("fails the ask when the request cannot be shown, without leaving a waiter behind", async () => {
    const published: PermissionRequest[] = [];
    let calls = 0;
    const { instance } = broker({
      publish: async (permission) => {
        calls += 1;
        if (calls === 1) throw new Error("chat store is read-only");
        published.push(permission);
      },
    });
    await expect(
      instance.ask({ kind: "read_linked_pages", action: "read", site: null, agent: "director" }),
    ).rejects.toMatchObject({ code: "runtime_unavailable", status: 503 });
    // The failed request is gone: a later ask creates a fresh one and waits on it normally.
    const retry = instance.ask({
      kind: "read_linked_pages",
      action: "read",
      site: null,
      agent: "director",
    });
    await Promise.resolve();
    expect(published).toHaveLength(1);
    expect(published[0]?.state).toBe("pending");
    await instance.answer(published[0]?.id ?? "", "deny");
    await expect(retry).resolves.toMatchObject({ state: "denied" });
  });

  it("resumes the waiting call even when the answer cannot be shown in the chat", async () => {
    const published: PermissionRequest[] = [];
    const { instance } = broker({
      publish: async (permission) => {
        published.push(permission);
        if (permission.state !== "pending") throw new Error("chat store is read-only");
      },
    });
    const waiting = instance.ask({
      kind: "read_linked_pages",
      action: "read",
      site: null,
      agent: "director",
    });
    await Promise.resolve();
    await expect(instance.answer(published[0]?.id ?? "", "deny")).rejects.toThrow(
      "chat store is read-only",
    );
    await expect(waiting).resolves.toMatchObject({ state: "denied" });
  });
});
