// @vitest-environment node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import {
  isExternalProjectList,
  isImportFromProjectResult,
  isProjectManifest,
  isProjectPartsSummary,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCrossProjectFixture,
  type CrossProjectFixture,
} from "../crossProject/testSupport.js";
import { registerCrossProjectRoutes } from "./crossProject.js";

let fixture: CrossProjectFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function app(options: { capability?: boolean } = {}) {
  const f = createCrossProjectFixture(options);
  fixture = f;
  const api = new Hono();
  registerCrossProjectRoutes(api, f.adapter);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await api.request(`/projects/own/cross-project${path}`, {
      method,
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    const parsed: unknown = await response.json();
    return { status: response.status, body: parsed };
  };
  return { f, api, call };
}

describe("the cross-project routes", () => {
  it("list the other projects, summarise them and give the manifest the contract describes", async () => {
    const { f, call } = app();
    const other = f.add("aaaa1111aaaa1111", "Alpha");
    other.write("renders/out.mp4");
    other.write("assets/music/bed.mp3");

    const list = await call("GET", "/projects");
    expect(list.status).toBe(200);
    expect(isExternalProjectList(list.body) && list.body.projects.map((p) => p.key)).toEqual([
      "aaaa1111aaaa1111",
    ]);

    const summary = await call("GET", "/projects/aaaa1111aaaa1111/summary");
    expect(summary.status).toBe(200);
    expect(isProjectPartsSummary(summary.body) && summary.body.counts).toMatchObject({
      renders: 1,
      music: 1,
      story: 0,
    });

    const manifest = await call("GET", "/projects/aaaa1111aaaa1111/manifest?parts=renders,music");
    expect(manifest.status).toBe(200);
    expect(
      isProjectManifest(manifest.body) && manifest.body.files.map((file) => file.path),
    ).toEqual(["renders/out.mp4", "assets/music/bed.mp3"]);
    expect((await call("GET", "/projects/aaaa1111aaaa1111/manifest")).status).toBe(200);
    expect((await call("GET", "/projects/aaaa1111aaaa1111/manifest?parts=nonsense")).status).toBe(
      400,
    );
  });

  it("answer unknown_project (404) for an unknown key, the open project and a host without a list", async () => {
    const { call } = app();
    for (const path of [
      "/projects/nosuchkey/summary",
      "/projects/ownkey0000000000/summary",
      "/projects/nosuchkey/manifest?parts=all",
    ]) {
      const answer = await call("GET", path);
      expect(answer).toMatchObject({ status: 404, body: { error: { code: "unknown_project" } } });
    }
    const imported = await call("POST", "/import", { projectKey: "nosuchkey", files: ["a.mp3"] });
    expect(imported).toMatchObject({ status: 404, body: { error: { code: "unknown_project" } } });

    const bare = app({ capability: false });
    expect(await bare.call("GET", "/projects")).toEqual({ status: 200, body: { projects: [] } });
    expect((await bare.call("GET", "/projects/aaaa1111aaaa1111/summary")).status).toBe(404);
  });

  it("404 for an unknown open project", async () => {
    const { api } = app();
    const response = await api.request("/projects/nope/cross-project/projects");
    expect(response.status).toBe(404);
  });

  it("import, refuse a malformed request and cancel by request id", async () => {
    const { f, call } = app();
    const other = f.add("aaaa1111aaaa1111", "Alpha");
    other.write("assets/a.mp3", "bytes");

    expect(
      (await call("POST", "/import", { projectKey: "aaaa1111aaaa1111", files: [] })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/import", {
          projectKey: "aaaa1111aaaa1111",
          files: ["a"],
          requestId: "x".repeat(500),
        })
      ).status,
    ).toBe(400);

    const cancelled = await call("POST", "/requests/r-1/cancel");
    expect(cancelled).toEqual({ status: 200, body: { requestId: "r-1", state: "cancelled" } });
    const refused = await call("POST", "/import", {
      projectKey: "aaaa1111aaaa1111",
      files: ["assets/a.mp3"],
      requestId: "r-1",
    });
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "cancelled" } } });
    expect(existsSync(join(f.own.dir, "assets/from"))).toBe(false);

    const done = await call("POST", "/import", {
      projectKey: "aaaa1111aaaa1111",
      files: ["assets/a.mp3"],
      requestId: "r-2",
    });
    expect(done.status).toBe(200);
    expect(isImportFromProjectResult(done.body) && done.body.imported[0]?.asset).toBe(
      "assets/from/alpha/a.mp3",
    );
    expect((await call("POST", "/requests/r-2/cancel")).body).toEqual({
      requestId: "r-2",
      state: "finished",
    });
  });
});
