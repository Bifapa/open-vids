// @vitest-environment node
import { writeFileSync } from "node:fs";
import { Hono } from "hono";
import {
  isAssetSearchPolicy,
  isAssetSearchResult,
  isReadWebsiteResult,
  isRecordWebsiteResult,
  isWebsiteFileResult,
  isWebsiteGrant,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebsiteInspection } from "../types.js";
import { UrlGuard } from "../research/sources/urlPolicy.js";
import {
  createResearchFixture,
  fixtureText,
  json,
  media,
  resolver,
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
    websiteGuard: new UrlGuard(resolver(options.dns)),
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
      name: "Unsplash",
      domains: ["https://unsplash.com"],
    });
    expect(added.status).toBe(200);
    if (!isAssetSearchPolicy(added.body)) throw new Error("not a policy");
    const policy = added.body;
    const id = policy.sources.find((source) => !source.builtIn)?.id ?? "";
    expect(
      (await call("PATCH", `/research/sources/${id}`, { enabled: false, name: "Unsplash photos" }))
        .body,
    ).toMatchObject({
      sources: expect.arrayContaining([expect.objectContaining({ id, enabled: false })]),
    });

    const removed = await call("DELETE", "/research/sources/openverse");
    expect(removed.body).toMatchObject({ removedBuiltIns: ["openverse"] });
    const restored = await call("POST", "/research/sources/restore");
    expect(restored.body).toMatchObject({ removedBuiltIns: [] });

    const keyed = await call("PUT", "/research/sources/pixabay/api-key", { key: "k-123" });
    expect(keyed.status).toBe(200);
    expect(JSON.stringify(keyed.body)).not.toContain("k-123");
    expect(keyed.body).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          id: "pixabay",
          apiKey: expect.objectContaining({ configured: true }),
        }),
      ]),
    });
    expect(await call("PUT", "/research/sources/openverse/api-key", { key: "k" })).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_request" } },
    });
    expect((await call("DELETE", "/research/sources/pixabay/api-key")).body).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          id: "pixabay",
          apiKey: expect.objectContaining({ configured: false }),
        }),
      ]),
    });
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

describe("the website reader routes", () => {
  const inspection: WebsiteInspection = {
    site: {
      url: "https://example.com/",
      finalUrl: "https://example.com/",
      host: "example.com",
      title: "Example",
      description: "",
      themeColor: null,
      language: null,
      colors: [],
      fonts: [],
      textStyles: [],
      radii: [],
      shadows: [],
      buttons: [],
      tokens: [],
      motion: { durationsMs: [], easings: [], keyframes: [], properties: [] },
      logos: [],
      favicon: null,
      ogImage: null,
      headings: [],
      navLabels: [],
      notes: [],
      capturedAt: 1,
    },
    screenshots: [
      {
        name: "viewport.jpg",
        mimeType: "image/jpeg",
        data: new TextEncoder().encode("jpeg"),
        width: 1440,
        height: 900,
      },
    ],
    logo: null,
    fonts: [],
  };

  it("serve and change the Websites switches through the policy routes", async () => {
    const { call } = app();
    expect((await call("GET", "/research/policy")).body).toMatchObject({
      websites: { readLinkedPages: true, fullAccess: false },
    });
    expect(
      (await call("PUT", "/research/policy", { websites: { readLinkedPages: false } })).body,
    ).toMatchObject({ mode: "trusted", websites: { readLinkedPages: false, fullAccess: false } });
    expect(
      (await call("PUT", "/research/policy", { websites: { fullAccess: true } })).body,
    ).toMatchObject({ mode: "trusted", websites: { readLinkedPages: false, fullAccess: true } });
    expect((await call("PUT", "/research/policy", { mode: "any" })).body).toMatchObject({
      mode: "any",
      websites: { readLinkedPages: false, fullAccess: true },
    });
    for (const bad of [
      {},
      { websites: {} },
      { websites: { readLinkedPages: "yes" } },
      { websites: { fullAccess: "yes" } },
      { websites: { readLinkedPages: true, nope: 1 } },
    ]) {
      expect(await call("PUT", "/research/policy", bad)).toMatchObject({
        status: 400,
        body: { error: { code: "invalid_request" } },
      });
    }
  });

  it("read a page through the adapter's browser, refuse it with 403 when the switch is off", async () => {
    const { f, call } = app();
    f.story.made.adapter.inspectWebsite = async () => inspection;
    const read = await call("POST", "/projects/demo/research/website", {
      url: "https://example.com/",
    });
    expect(read.status).toBe(200);
    if (!isReadWebsiteResult(read.body)) throw new Error("not a website result");
    expect(read.body.screenshots[0]?.data).toBe(Buffer.from("jpeg").toString("base64"));

    await call("PUT", "/research/policy", { websites: { readLinkedPages: false } });
    expect(
      await call("POST", "/projects/demo/research/website", { url: "https://example.com/" }),
    ).toMatchObject({ status: 403, body: { error: { code: "blocked_by_policy" } } });
  });

  it("answer bad requests and private addresses without opening a page, and an unknown project with 404", async () => {
    const { f, call } = app();
    const opened = vi.fn(async () => inspection);
    f.story.made.adapter.inspectWebsite = opened;
    const post = (body: unknown) => call("POST", "/projects/demo/research/website", body);
    expect(await post({})).toMatchObject({ status: 400 });
    expect(await post({ url: "https://example.com/", save: "yes" })).toMatchObject({ status: 400 });
    expect(await post({ url: "https://example.com/", extra: 1 })).toMatchObject({ status: 400 });
    expect(await post({ url: "ftp://example.com/" })).toMatchObject({ status: 400 });
    expect(await post({ url: "http://169.254.169.254/" })).toMatchObject({
      status: 403,
      body: { error: { code: "blocked_by_policy" } },
    });
    expect(opened).not.toHaveBeenCalled();
    expect(
      (await call("POST", "/projects/ghost/research/website", { url: "https://example.com/" }))
        .status,
    ).toBe(404);
  });

  it("are unsupported without a browser capability", async () => {
    const { call } = app();
    expect(
      await call("POST", "/projects/demo/research/website", { url: "https://example.com/" }),
    ).toMatchObject({ status: 415, body: { error: { code: "unsupported" } } });
  });
});

describe("the full-access website routes", () => {
  it("refuse file and record with 403 while full access is off", async () => {
    const { call } = app();
    expect(
      await call("POST", "/projects/demo/research/website/file", {
        url: "https://example.com/a.txt",
        mode: "read",
      }),
    ).toMatchObject({ status: 403, body: { error: { code: "blocked_by_policy" } } });
    expect(
      await call("POST", "/projects/demo/research/website/record", {
        url: "https://example.com/",
        seconds: 2,
      }),
    ).toMatchObject({ status: 403, body: { error: { code: "blocked_by_policy" } } });
  });

  it("read text and save a file over HTTP, and answer bad bodies", async () => {
    const { f, call } = app();
    await call("PUT", "/research/policy", { websites: { fullAccess: true } });

    f.net.when("https://example.com/app.js", media("console.log(1)", "application/javascript"));
    const read = await call("POST", "/projects/demo/research/website/file", {
      url: "https://example.com/app.js",
      mode: "read",
    });
    expect(read.status).toBe(200);
    if (!isWebsiteFileResult(read.body)) throw new Error("not a website file result");
    expect(read.body).toMatchObject({ kind: "script", text: "console.log(1)", truncated: false });

    f.net.when("https://example.com/hero.png", media("PNGDATA", "image/png"));
    const saved = await call("POST", "/projects/demo/research/website/file", {
      url: "https://example.com/hero.png",
      mode: "save",
      pageUrl: "https://example.com/",
    });
    expect(saved.status).toBe(200);
    if (!isWebsiteFileResult(saved.body)) throw new Error("not a website file result");
    expect(saved.body.path).toBe("assets/web/example.com/files/hero.png");

    expect(
      await call("POST", "/projects/demo/research/website/file", {
        url: "https://example.com/a",
        mode: "download",
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await call("POST", "/projects/demo/research/website/file", {
        url: "https://example.com/a",
        mode: "read",
        extra: 1,
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await call("POST", "/projects/demo/research/website/file", {
        url: "http://127.0.0.1/",
        mode: "read",
      }),
    ).toMatchObject({ status: 403, body: { error: { code: "blocked_by_policy" } } });
    expect(
      (
        await call("POST", "/projects/ghost/research/website/file", {
          url: "https://example.com/a",
          mode: "read",
        })
      ).status,
    ).toBe(404);
  });

  it("record through the adapter, validate the body and answer 415 without a capability", async () => {
    const { f, call } = app();
    await call("PUT", "/research/policy", { websites: { fullAccess: true } });
    expect(
      await call("POST", "/projects/demo/research/website/record", {
        url: "https://example.com/",
        seconds: 2,
      }),
    ).toMatchObject({ status: 415, body: { error: { code: "unsupported" } } });

    const seen: Array<{ width: number; height: number }> = [];
    f.story.made.adapter.recordWebsite = async (opts) => {
      seen.push({ width: opts.width, height: opts.height });
      writeFileSync(opts.outFile, "MP4");
      return {
        finalUrl: opts.url,
        width: opts.width,
        height: opts.height,
        duration: opts.seconds,
        notes: [],
      };
    };
    const recorded = await call("POST", "/projects/demo/research/website/record", {
      url: "https://example.com/",
      seconds: 2,
      width: 1001,
      height: 900,
    });
    expect(recorded.status).toBe(200);
    if (!isRecordWebsiteResult(recorded.body)) throw new Error("not a record result");
    expect(recorded.body).toMatchObject({ width: 1000, height: 900, duration: 2, bytes: 3 });
    expect(recorded.body.path).toMatch(/^assets\/web\/example\.com\/recordings\//);
    expect(seen).toEqual([{ width: 1000, height: 900 }]);

    for (const bad of [
      { url: "https://example.com/" },
      { url: "https://example.com/", seconds: 0 },
      { url: "https://example.com/", seconds: 31 },
      { url: "https://example.com/", seconds: 2, width: 1001.5 },
      { url: "https://example.com/", seconds: 2, width: 4000 },
      { url: "https://example.com/", seconds: 2, scroll: "yes" },
      { url: "https://example.com/", seconds: 2, selector: "x".repeat(301) },
      { url: "https://example.com/", seconds: 2, extra: 1 },
    ]) {
      expect(await call("POST", "/projects/demo/research/website/record", bad)).toMatchObject({
        status: 400,
      });
    }
  });
});

describe("the one-time website grants", () => {
  const inspection: WebsiteInspection = {
    site: {
      url: "https://example.com/",
      finalUrl: "https://example.com/",
      host: "example.com",
      title: "Example",
      description: "",
      themeColor: null,
      language: null,
      colors: [],
      fonts: [],
      textStyles: [],
      radii: [],
      shadows: [],
      buttons: [],
      tokens: [],
      motion: { durationsMs: [], easings: [], keyframes: [], properties: [] },
      logos: [],
      favicon: null,
      ogImage: null,
      headings: [],
      navLabels: [],
      notes: [],
      capturedAt: 1,
    },
    screenshots: [],
    logo: null,
    fonts: [],
  };
  const off = { websites: { readLinkedPages: false, fullAccess: false } };
  const page = { url: "https://example.com/" };

  it("let a read-granted turn read, keep files and recordings blocked, and unblock on revoke", async () => {
    const { f, call } = app();
    f.story.made.adapter.inspectWebsite = async () => inspection;
    await call("PUT", "/research/policy", off);

    expect(
      await call("POST", "/projects/demo/research/website", { ...page, turnId: "turn-a" }),
    ).toMatchObject({
      status: 403,
      body: {
        error: {
          code: "blocked_by_policy",
          message: expect.stringContaining("Settings → Asset Search → Websites"),
        },
      },
    });
    expect(
      await call("POST", "/projects/demo/research/website/file", {
        url: "https://example.com/a.txt",
        mode: "read",
        turnId: "turn-a",
      }),
    ).toMatchObject({ status: 403, body: { error: { code: "blocked_by_policy" } } });

    const granted = await call("POST", "/projects/demo/research/website/grants", {
      turnId: "turn-a",
      access: "read",
      allSites: true,
    });
    expect(granted.status).toBe(200);
    if (!isWebsiteGrant(granted.body)) throw new Error("not a website grant");
    expect(granted.body).toMatchObject({ turnId: "turn-a", access: "read" });
    expect(granted.body.expiresAt).toBeGreaterThan(granted.body.grantedAt);

    // The granted turn reads; another turn and a request without one stay blocked.
    expect(
      (await call("POST", "/projects/demo/research/website", { ...page, turnId: "turn-a" })).status,
    ).toBe(200);
    expect(
      await call("POST", "/projects/demo/research/website", { ...page, turnId: "turn-b" }),
    ).toMatchObject({ status: 403, body: { error: { code: "blocked_by_policy" } } });
    expect(await call("POST", "/projects/demo/research/website", page)).toMatchObject({
      status: 403,
      body: { error: { code: "blocked_by_policy" } },
    });
    // A read grant does not open files or recordings.
    expect(
      await call("POST", "/projects/demo/research/website/file", {
        url: "https://example.com/a.txt",
        mode: "read",
        turnId: "turn-a",
      }),
    ).toMatchObject({ status: 403, body: { error: { code: "blocked_by_policy" } } });
    expect(
      await call("POST", "/projects/demo/research/website/record", {
        url: "https://example.com/",
        seconds: 2,
        turnId: "turn-a",
      }),
    ).toMatchObject({ status: 403, body: { error: { code: "blocked_by_policy" } } });

    // Revoking restores the block, and revoking again is idempotent.
    expect((await call("DELETE", "/projects/demo/research/website/grants/turn-a")).body).toEqual({
      ok: true,
    });
    expect(
      await call("POST", "/projects/demo/research/website", { ...page, turnId: "turn-a" }),
    ).toMatchObject({ status: 403, body: { error: { code: "blocked_by_policy" } } });
    expect((await call("DELETE", "/projects/demo/research/website/grants/turn-a")).body).toEqual({
      ok: true,
    });
  });

  it("let a fully granted turn read, download and record without changing the policy", async () => {
    const { f, call } = app();
    f.story.made.adapter.inspectWebsite = async () => inspection;
    f.story.made.adapter.recordWebsite = async (opts) => {
      writeFileSync(opts.outFile, "MP4");
      return {
        finalUrl: opts.url,
        width: opts.width,
        height: opts.height,
        duration: opts.seconds,
        notes: [],
      };
    };
    await call("PUT", "/research/policy", off);
    await call("POST", "/projects/demo/research/website/grants", {
      turnId: "turn-a",
      access: "full",
      allSites: true,
    });

    f.net.when("https://example.com/app.js", media("console.log(1)", "application/javascript"));
    const read = await call("POST", "/projects/demo/research/website/file", {
      url: "https://example.com/app.js",
      mode: "read",
      turnId: "turn-a",
    });
    expect(read.status).toBe(200);
    if (!isWebsiteFileResult(read.body)) throw new Error("not a website file result");
    expect(read.body).toMatchObject({ kind: "script", text: "console.log(1)", truncated: false });

    f.net.when("https://example.com/hero.png", media("PNGDATA", "image/png"));
    const saved = await call("POST", "/projects/demo/research/website/file", {
      url: "https://example.com/hero.png",
      mode: "save",
      pageUrl: "https://example.com/",
      turnId: "turn-a",
    });
    expect(saved.status).toBe(200);
    if (!isWebsiteFileResult(saved.body)) throw new Error("not a website file result");
    expect(saved.body.path).toBe("assets/web/example.com/files/hero.png");

    expect(
      (await call("POST", "/projects/demo/research/website", { ...page, turnId: "turn-a" })).status,
    ).toBe(200);
    expect(
      (
        await call("POST", "/projects/demo/research/website/record", {
          ...page,
          seconds: 2,
          turnId: "turn-a",
        })
      ).status,
    ).toBe(200);

    // The grant is per turn; it changed no setting.
    expect(
      await call("POST", "/projects/demo/research/website/file", {
        url: "https://example.com/app.js",
        mode: "read",
        turnId: "turn-b",
      }),
    ).toMatchObject({ status: 403 });
    expect((await call("GET", "/research/policy")).body).toMatchObject({
      websites: { readLinkedPages: false, fullAccess: false },
    });
  });

  it("validate the grant body and the turn id, and answer an unknown project with 404", async () => {
    const { call } = app();
    for (const bad of [
      {},
      { turnId: "turn-a" },
      { access: "read" },
      { turnId: "", access: "read" },
      { turnId: "   ", access: "read" },
      { turnId: 5, access: "read" },
      { turnId: "turn-a", access: "download" },
      { turnId: "turn-a", access: "read", extra: 1 },
      { turnId: "x".repeat(257), access: "read" },
      { turnId: "turn-a", access: "read", site: "not a domain" },
      { turnId: "turn-a", access: "read", site: 4 },
      // A card that could not name its site must not become a grant for every site.
      { turnId: "turn-a", access: "read", site: null },
      { turnId: "turn-a", access: "read" },
      { turnId: "turn-a", access: "read", allSites: false },
      { turnId: "turn-a", access: "read", allSites: true, site: "example.com" },
    ]) {
      expect(await call("POST", "/projects/demo/research/website/grants", bad)).toMatchObject({
        status: 400,
        body: { error: { code: "invalid_request" } },
      });
    }
    expect(await call("DELETE", "/projects/demo/research/website/grants/%20")).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_request" } },
    });
    expect(
      await call("POST", "/projects/ghost/research/website/grants", {
        turnId: "turn-a",
        access: "read",
      }),
    ).toMatchObject({ status: 404 });
  });

  it("answers the site a grant covers, lower-cased", async () => {
    const { call } = app();
    const granted = await call("POST", "/projects/demo/research/website/grants", {
      turnId: "turn-site",
      access: "read",
      site: "Example.com",
    });
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({
      turnId: "turn-site",
      access: "read",
      site: "example.com",
    });
  });

  it("accepts an exact host with no registrable domain (an address) as the site", async () => {
    const { call } = app();
    const granted = await call("POST", "/projects/demo/research/website/grants", {
      turnId: "turn-ip",
      access: "read",
      site: "203.0.113.7",
    });
    expect(granted).toMatchObject({ status: 200, body: { site: "203.0.113.7" } });
  });
});
