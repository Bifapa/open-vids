import { describe, expect, it, vi } from "vitest";
import { AgentApiError, createAgentClient } from "./agentClient";
import { permissionPart, permissionRequest } from "./agentTestHarness";
import {
  isAnswerPermissionResponse,
  isPermissionPart,
  isPermissionRequest,
} from "./permissionGuards";

describe("isPermissionRequest", () => {
  it("accepts every state, with or without a site and answer time", () => {
    for (const state of ["pending", "allowed_once", "enabled", "denied", "expired"] as const) {
      expect(isPermissionRequest(permissionRequest({ state }))).toBe(true);
    }
    expect(isPermissionRequest(permissionRequest({ site: null, answeredAt: 5 }))).toBe(true);
  });

  it("rejects a request whose kind, action, state or agent this Studio does not know", () => {
    for (const broken of [
      { kind: "mystery" },
      { action: "upload" },
      { state: "maybe" },
      { agent: "nobody" },
      { site: undefined },
      { requestedAt: "yesterday" },
    ]) {
      expect(isPermissionRequest({ ...permissionRequest(), ...broken })).toBe(false);
    }
    expect(isPermissionRequest(null)).toBe(false);
  });

  it("accepts a download request with or without the material it is about", () => {
    const download = { kind: "asset_download", action: "download", site: null } as const;
    expect(isPermissionRequest(permissionRequest(download))).toBe(true);
    for (const asset of [
      { title: "Epic loop", source: "Openverse", license: "CC0" },
      { title: "Epic loop", source: null, license: null },
    ]) {
      expect(isPermissionRequest(permissionRequest({ ...download, asset }))).toBe(true);
    }
  });

  it("rejects a request whose material is not whole, instead of letting the card read it", () => {
    const download = permissionRequest({ kind: "asset_download", action: "download" });
    for (const asset of [
      null,
      "Epic loop",
      {},
      { title: 7, source: null, license: null },
      { title: "Epic loop", license: null },
      { title: "Epic loop", source: 3, license: null },
      { title: "Epic loop", source: null, license: false },
    ]) {
      expect(isPermissionRequest({ ...download, asset })).toBe(false);
    }
  });
});

describe("isPermissionPart", () => {
  it("accepts a permission part and nothing else", () => {
    expect(isPermissionPart(permissionPart())).toBe(true);
    expect(isPermissionPart({ type: "text", id: "t", text: "hi" })).toBe(false);
    expect(
      isPermissionPart({
        type: "permission",
        id: "p",
        permission: Object.assign(permissionRequest(), { kind: "mystery" }),
      }),
    ).toBe(false);
  });
});

describe("answerPermission", () => {
  function clientWith(respond: () => Response) {
    const fetchImpl = vi.fn<typeof fetch>(async () => respond());
    return { fetchImpl, client: createAgentClient("my project", { fetchImpl }) };
  }

  it("posts the decision through the Studio server's agent proxy and reads the new state", async () => {
    const answered = permissionRequest({ state: "enabled", answeredAt: 9 });
    const { client, fetchImpl } = clientWith(
      () => new Response(JSON.stringify({ permission: answered })),
    );
    await expect(client.answerPermission("c 1", "t1", "p/1", "always")).resolves.toEqual({
      permission: answered,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/projects/my%20project/agent/chats/c%201/turns/t1/permissions/p%2F1");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ decision: "always" }));
  });

  it("reports an answer without a request as a bad response, and a refusal as its code", async () => {
    const bad = clientWith(() => new Response(JSON.stringify({ permission: { id: "p" } })));
    await expect(bad.client.answerPermission("c1", "t1", "p", "once")).rejects.toMatchObject({
      code: "bad_response",
    });
    const gone = clientWith(
      () =>
        new Response(JSON.stringify({ error: { code: "turn_not_active", message: "done" } }), {
          status: 409,
        }),
    );
    const failure = await gone.client
      .answerPermission("c1", "t1", "p", "once")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentApiError);
    expect(failure).toMatchObject({ code: "turn_not_active", status: 409 });
  });

  it("only takes a response that carries a well-formed request", () => {
    expect(isAnswerPermissionResponse({ permission: permissionRequest() })).toBe(true);
    expect(isAnswerPermissionResponse({})).toBe(false);
  });
});
