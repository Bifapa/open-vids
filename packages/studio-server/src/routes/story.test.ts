// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { StoryEditResponse, StoryError, StoryView } from "@hyperframes/agent-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AnalysisService } from "../analysis/service.js";
import { AnalysisStore } from "../analysis/store.js";
import {
  addClip,
  createAnalysisProject,
  hasFfmpeg,
  makeClip,
  waitFor,
  type TestProject,
} from "../analysis/testSupport.js";
import { createStoryFixture, type StoryFixture } from "../story/testSupport.js";
import { fakeProber } from "../editing/testProject.js";
import { registerStoryRoutes } from "./story.js";

let scratch = "";
let clip = "";
const cleanups: Array<() => void> = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "openvids-story-routes-"));
  if (hasFfmpeg) {
    clip = join(scratch, "clip.mp4");
    makeClip(clip);
  }
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fakeApi(): {
  fixture: StoryFixture;
  send: (method: string, path: string, body?: unknown, project?: string) => Promise<Response>;
} {
  const fixture = createStoryFixture();
  cleanups.push(() => fixture.cleanup());
  const api = new Hono();
  registerStoryRoutes(api, fixture.made.adapter, fixture.analysis, { probe: fakeProber });
  const send = (method: string, path: string, body?: unknown, project = "demo") =>
    api.request(`/projects/${project}/story${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  return { fixture, send };
}

async function errorOf(response: Response): Promise<StoryError> {
  const body: { error: StoryError } = await response.json();
  return body.error;
}

describe("the story routes", () => {
  it("answers a project with no story with an empty view, and an unknown project with 404", async () => {
    const { send } = fakeApi();
    const view: StoryView = await (await send("GET", "")).json();
    expect(view).toEqual({
      graph: null,
      version: null,
      order: { chapters: [], notes: [] },
      facts: {},
      composition: null,
      sync: null,
    });
    expect((await send("GET", "", undefined, "nope")).status).toBe(404);
  });

  it("creates, edits, saves and builds a story over HTTP, answering refusals as { error } with their status", async () => {
    const { send } = fakeApi();
    const edit = await send("POST", "/edit", {
      turnId: "turn-1",
      operations: [
        { op: "add_node", ref: "a", node: { kind: "chapter", title: "One", estimatedDuration: 4 } },
        { op: "add_node", ref: "b", node: { kind: "chapter", title: "Two", estimatedDuration: 6 } },
        { op: "connect", from: "@a", to: "@b" },
      ],
    });
    expect(edit.status).toBe(200);
    const { view, results }: StoryEditResponse = await edit.json();
    expect(results.map((result) => result.op)).toEqual(["add_node", "add_node", "connect"]);
    expect(view.order.chapters).toHaveLength(2);

    const stale = await send("PUT", "", { baseVersion: "sha256:stale", graph: view.graph });
    expect([stale.status, (await errorOf(stale)).code]).toEqual([409, "conflict"]);
    const saved = await send("PUT", "", { baseVersion: view.version, graph: view.graph });
    expect(saved.status).toBe(200);

    const built = await send("POST", "/build", { turnId: "turn-1", dryRun: true });
    expect(built.status).toBe(200);
    expect((await built.json()).duration).toBe(10);

    const cases: Array<[Response, number, StoryError["code"]]> = [
      [await send("POST", "/edit", "not json"), 400, "invalid_request"],
      [await send("POST", "/edit", { operations: [] }), 400, "invalid_request"],
      [
        await send("POST", "/edit", {
          operations: [{ op: "update_node", id: "chapter-x", set: { title: "x" } }],
        }),
        404,
        "unknown_node",
      ],
      [await send("PUT", "", { baseVersion: null, graph: { nope: true } }), 400, "invalid_request"],
      [await send("POST", "/build", { extra: 1 }), 400, "invalid_request"],
      [await send("POST", "/rebuild", { manualEdits: "merge" }), 400, "invalid_request"],
      // Nothing was built yet: there is no section to rebuild.
      [await send("POST", "/rebuild", { turnId: "turn-2" }), 400, "unsupported"],
      [await send("GET", "/frame?t=1"), 400, "invalid_request"],
      [await send("GET", "/frame?source=assets/a.mp4&t=-1"), 400, "invalid_request"],
    ];
    for (const [response, status, code] of cases) {
      expect([response.status, (await errorOf(response)).code]).toEqual([status, code]);
    }
  });
});

describe.skipIf(!hasFfmpeg)("with a real analysis service", () => {
  function realApi() {
    const test: TestProject = createAnalysisProject();
    cleanups.push(() => test.cleanup());
    addClip(test, clip, "assets/talk.mp4");
    const analysis = new AnalysisService(test.adapter, { orphanIntervalMs: 0 });
    const api = new Hono();
    registerStoryRoutes(api, test.adapter, analysis);
    return {
      test,
      analysis,
      get: (path: string) => api.request(`/projects/demo/story${path}`),
    };
  }

  it("serves a JPEG frame of a video for a card, and refuses what is not a video in the project", async () => {
    const { get } = realApi();
    const response = await get("/frame?source=assets/talk.mp4&t=1&w=200");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect((await get("/frame?source=assets/missing.mp4&t=1")).status).toBe(404);
    expect((await get("/frame?source=index.html&t=1")).status).toBe(400);
    expect((await get("/frame?source=../outside.mp4&t=1")).status).toBe(400);
  });

  it("sweeps the analysis of a deleted source when the story is viewed", async () => {
    const { test, analysis, get } = realApi();
    const job = await analysis.startJob(test.project, { source: "assets/talk.mp4" });
    await waitFor(
      () => (analysis.getJob(test.project, job.id)?.status ?? "running") !== "running",
      "analysis",
    );
    const store = new AnalysisStore(test.project.dir);
    expect((await store.listManifests()).map((manifest) => manifest.path)).toEqual([
      "assets/talk.mp4",
    ]);

    rmSync(test.path("assets/talk.mp4"));
    expect((await get("")).status).toBe(200);
    expect(await store.listManifests()).toEqual([]);
  });
});
