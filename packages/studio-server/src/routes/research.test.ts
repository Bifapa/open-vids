// @vitest-environment node
import { Hono } from "hono";
import { isAssetSearchPolicy, isAssetSearchResult } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  createResearchFixture,
  fixtureText,
  json,
  media,
  type ResearchFixture,
} from "../research/testSupport.js";
import { registerResearchRoutes } from "./research.js";

let fixture: ResearchFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function app(options: Parameters<typeof createResearchFixture>[0] = {}) {
  const f = createResearchFixture(options);
  fixture = f;
  const api = new Hono();
  registerResearchRoutes(api, f.story.made.adapter, f.story.service, {
    store: f.store,
    fetcher: f.fetcher,
    webSearch: f.web,
    toolkit: f.toolkit,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await api.request(path, {
      method,
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    const parsed: unknown = await response.json();
    return { status: response.status, body: parsed };
  };
  return { f, call };
}

describe("the research routes", () => {
  it("serve and change the global policy: mode, user sources, removal and restoring built-ins", async () => {
    const { call } = app();
    expect(await call("GET", "/research/policy")).toMatchObject({
      status: 200,
      body: { mode: "trusted" },
    });
    expect((await call("PUT", "/research/policy", { mode: "any" })).body).toMatchObject({
      mode: "any",
    });

    const added = await call("POST", "/research/sources", {
      name: "Pexels",
      domains: ["https://www.pexels.com"],
    });
    expect(added.status).toBe(200);
    if (!isAssetSearchPolicy(added.body)) throw new Error("not a policy");
    const policy = added.body;
    const id = policy.sources.find((source) => !source.builtIn)?.id ?? "";
    expect(
      (await call("PATCH", `/research/sources/${id}`, { enabled: false, name: "Pexels stock" }))
        .body,
    ).toMatchObject({
      sources: expect.arrayContaining([expect.objectContaining({ id, enabled: false })]),
    });

    const removed = await call("DELETE", "/research/sources/openverse");
    expect(removed.body).toMatchObject({ removedBuiltIns: ["openverse"] });
    const restored = await call("POST", "/research/sources/restore");
    expect(restored.body).toMatchObject({ removedBuiltIns: [] });
  });

  it("answer a refused request with its research error and the matching status", async () => {
    const { call } = app();
    expect(await call("PUT", "/research/policy", { mode: "everything" })).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_request" } },
    });
    expect(
      await call("POST", "/research/sources", { name: "x", domains: ["10.0.0.1"] }),
    ).toMatchObject({
      status: 400,
    });
    expect(
      await call("POST", "/research/sources", { name: "x", domains: ["commons.wikimedia.org"] }),
    ).toMatchObject({
      status: 409,
      body: { error: { code: "conflict" } },
    });
    expect(await call("PATCH", "/research/sources/src-nope", { enabled: true })).toMatchObject({
      status: 400,
      body: { error: { code: "unknown_source" } },
    });
    expect(
      await call("POST", "/projects/demo/research/inspect", { url: "https://example.com/" }),
    ).toMatchObject({ status: 403, body: { error: { code: "blocked_by_policy" } } });
    expect(
      await call("POST", "/projects/demo/research/import", { candidate: "cand-none" }),
    ).toMatchObject({ status: 404, body: { error: { code: "unknown_candidate" } } });
    expect(await call("POST", "/projects/demo/research/import", {})).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_request" } },
    });
    expect(
      await call("POST", "/projects/demo/research/import", {
        candidate: "a",
        url: "https://example.com",
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await call("POST", "/projects/demo/research/search", { query: "x", mediaKind: "hologram" }),
    ).toMatchObject({ status: 400 });
    expect(
      await call("POST", "/projects/demo/research/resolve", {
        missing: "m",
        asset: "assets/b.mp4",
      }),
    ).toMatchObject({ status: 404, body: { error: { code: "no_story" } } });
    expect(
      await call("GET", "/projects/demo/research/export-check?composition=nope.html"),
    ).toMatchObject({
      status: 404,
    });
    expect((await call("GET", "/projects/ghost/research/sources")).status).toBe(404);
  });

  it("search, import and list the project's sources over HTTP", async () => {
    const { f, call } = app();
    f.net.when(
      (url) => url.hostname === "commons.wikimedia.org",
      json(JSON.parse(fixtureText("commons-picture.json"))),
    );
    const found = await call("POST", "/projects/demo/research/search", {
      query: "volcano",
      mediaKind: "picture",
      sources: ["wikimedia-commons"],
      limit: 2,
    });
    expect(found.status).toBe(200);
    if (!isAssetSearchResult(found.body)) throw new Error("not a search result");
    const result = found.body;
    expect(result.candidates).toHaveLength(2);
    const [first] = result.candidates;
    f.net.when(first?.mediaUrl ?? "", media("JPEG volcano", "image/jpeg"));
    const imported = await call("POST", "/projects/demo/research/import", {
      candidate: first?.id,
      agent: "research",
      turnId: "turn-1",
    });
    expect(imported).toMatchObject({ status: 200, body: { fetch: "network", duplicate: null } });
    const sources = await call("GET", "/projects/demo/research/sources");
    expect(sources.body).toMatchObject({
      summary: { total: 1 },
      records: [{ present: true, retrievedBy: { agent: "research" } }],
    });
  });

  it("cancel a request by id: an unknown id is remembered, so the request that follows answers cancelled", async () => {
    const { f, call } = app();
    expect(await call("POST", "/projects/demo/research/requests/req-9/cancel")).toMatchObject({
      status: 200,
      body: { requestId: "req-9", state: "cancelled" },
    });
    f.net.when("https://upload.wikimedia.org/a.mp4", media("H264 a", "video/mp4"));
    expect(
      await call("POST", "/projects/demo/research/import", {
        url: "https://upload.wikimedia.org/a.mp4",
        requestId: "req-9",
      }),
    ).toMatchObject({ status: 409, body: { error: { code: "cancelled" } } });
    expect(f.researchFiles()).toEqual([]);
    expect(await call("POST", "/projects/ghost/research/requests/req-9/cancel")).toMatchObject({
      status: 404,
    });
  });
});
