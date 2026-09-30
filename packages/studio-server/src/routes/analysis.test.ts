// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type {
  AnalysisError,
  AnalysisJob,
  AnalysisOverview,
  CutPlan,
  FramesResponse,
  SegmentMap,
  TranscriptView,
} from "@hyperframes/agent-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  addClip,
  createAnalysisProject,
  hasFfmpeg,
  makeClip,
  waitFor,
  type TestProject,
} from "../analysis/testSupport.js";
import { registerAnalysisRoutes } from "./analysis.js";

let scratch = "";
let clip = "";
const projects: TestProject[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "openvids-analysis-routes-"));
  if (hasFfmpeg) {
    clip = join(scratch, "clip.mp4");
    makeClip(clip);
  }
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  for (const test of projects.splice(0)) test.cleanup();
});

function setup() {
  const test = createAnalysisProject();
  projects.push(test);
  const api = new Hono();
  registerAnalysisRoutes(api, test.adapter);
  const url = (path: string) => `/projects/demo/analysis/${path}`;
  const send = (method: string, path: string, body?: unknown, project = "demo") =>
    api.request(`/projects/${project}/analysis/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  return { test, api, url, get: (path: string) => send("GET", path), send };
}

async function errorOf(response: Response): Promise<AnalysisError> {
  const body: { error: AnalysisError } = await response.json();
  return body.error;
}

describe("error answers", () => {
  it("answers an unknown project with 404 and every refusal with { error: { code, message } } and its status", async () => {
    const { test, get, send } = setup();
    writeFileSync(test.path("notes.txt"), "x");
    writeFileSync(test.path("fake.mp4"), "not a video");

    expect((await send("GET", "sources", undefined, "nope")).status).toBe(404);

    const cases: Array<[Response, number, AnalysisError["code"]]> = [
      [await send("POST", "jobs", "not json"), 400, "invalid_request"],
      [
        await send("POST", "jobs", { source: "fake.mp4", stages: ["vision"] }),
        400,
        "invalid_request",
      ],
      [await send("POST", "jobs", { source: "notes.txt" }), 400, "invalid_request"],
      [await send("POST", "jobs", { source: "../x.mp4" }), 400, "invalid_request"],
      [await send("POST", "jobs", { source: "missing.mp4" }), 404, "unknown_source"],
      [await get("overview"), 400, "invalid_request"],
      [await get("overview?source=missing.mp4"), 404, "unknown_source"],
      [await get("transcript?source=fake.mp4"), 404, "not_analyzed"],
      [await get("transcript?source=fake.mp4&from=-1"), 400, "invalid_request"],
      [await get("artifact?source=fake.mp4&stage=nonsense"), 400, "invalid_request"],
      [await get("artifact?source=fake.mp4&stage=shots"), 404, "not_analyzed"],
      [await get("jobs/job-unknown"), 404, "unknown_source"],
      [await send("POST", "jobs/job-unknown/cancel"), 404, "unknown_source"],
      [
        await send("PUT", "segments", {
          source: "fake.mp4",
          transcriptVersion: "sha256:x",
          segments: [
            {
              firstSentence: "s1",
              lastSentence: "s1",
              title: "t",
              summary: "s",
              role: "main",
              priority: "must",
            },
          ],
        }),
        404,
        "not_analyzed",
      ],
      [await send("POST", "vision", { source: "fake.mp4", notes: [] }), 400, "invalid_request"],
      [await send("POST", "frames", { source: "fake.mp4", times: [] }), 400, "invalid_request"],
      [await send("POST", "cuts", { source: "fake.mp4", basedOn: "cut-4" }), 404, "unknown_plan"],
      [await get("cuts/cut-4"), 404, "unknown_plan"],
    ];
    for (const [response, status, code] of cases) {
      expect([response.status, (await errorOf(response)).code]).toEqual([status, code]);
    }
  });

  it("refuses a body over the limit before looking at it", async () => {
    const { send } = setup();
    const response = await send("POST", "jobs", {
      source: "x.mp4",
      language: "x".repeat(3 * 1024 * 1024),
    });
    expect([response.status, (await errorOf(response)).code]).toEqual([400, "invalid_request"]);
  });

  it("lists the project's video and audio files, with states, and none from .hyperframes or renders", async () => {
    const { test, get } = setup();
    writeFileSync(test.path("a.mp4"), "x");
    writeFileSync(test.path("voice.mp3"), "x");
    writeFileSync(test.path("photo.png"), "x");
    mkdirSync(test.path("renders"), { recursive: true });
    writeFileSync(test.path("renders/out.mp4"), "x");
    mkdirSync(test.path(".hyperframes/analysis"), { recursive: true });
    writeFileSync(test.path(".hyperframes/analysis/x.mp4"), "x");
    const body: {
      sources: Array<{ source: string; kind: string; stages: Array<{ status: string }> }>;
    } = await (await get("sources")).json();
    expect(body.sources.map((source) => [source.source, source.kind])).toEqual([
      ["a.mp4", "video"],
      ["voice.mp3", "audio"],
    ]);
    expect(body.sources[0]?.stages.every((stage) => stage.status === "missing")).toBe(true);
  });
});

describe.skipIf(!hasFfmpeg)("the analysis flow over HTTP", () => {
  it("analyses, reads, segments, inspects, plans and applies", async () => {
    const { test, get, send } = setup();
    addClip(test, clip, "assets/talk.mp4");
    const source = "assets/talk.mp4";

    const started: AnalysisJob = await (await send("POST", "jobs", { source })).json();
    expect(started.status).toBe("running");
    let job = started;
    await waitFor(async () => {
      job = await (await get(`jobs/${started.id}`)).json();
      return job.status !== "running";
    }, "the job to finish");
    expect(job).toMatchObject({ id: started.id, status: "completed", progress: 100 });

    const overview: AnalysisOverview = await (await get(`overview?source=${source}`)).json();
    expect(overview.status.stages.filter((stage) => stage.status === "fresh")).toHaveLength(6);
    expect(overview.transcript?.sentences).toBeGreaterThan(0);

    const view: TranscriptView = await (
      await get(`transcript?source=${source}&words=1&from=5&to=8`)
    ).json();
    expect(view.sentences.every((sentence) => sentence.end > 5)).toBe(true);
    expect(view.words?.length).toBeGreaterThan(0);
    expect(view.totalSentences).toBe(overview.transcript?.sentences);

    const silence = await (await get(`artifact?source=${source}&stage=silence`)).json();
    expect(silence.silences.length).toBeGreaterThan(0);

    const segment = (transcriptVersion: string) => ({
      source,
      transcriptVersion,
      segments: [
        {
          firstSentence: "s1",
          lastSentence: `s${view.totalSentences}`,
          title: "Talk",
          summary: "All",
          role: "main",
          priority: "should",
        },
      ],
    });
    const conflict = await send("PUT", "segments", segment("sha256:stale"));
    expect([conflict.status, (await errorOf(conflict)).code]).toEqual([409, "conflict"]);
    // A model may hand the token back in quotes; it is the same version.
    const saved: SegmentMap = await (
      await send("PUT", "segments", segment(`"${view.version}"`))
    ).json();
    expect(saved.origin).toBe("semantic");

    const frames: FramesResponse = await (
      await send("POST", "frames", { source, times: [0.5, 3] })
    ).json();
    expect(frames.frames.map((frame) => frame.cached)).toEqual([false, false]);
    const vision = await send("POST", "vision", {
      source,
      notes: [
        {
          start: 2,
          end: 4,
          frames: [3],
          quality: "unusable",
          tags: ["black"],
          finding: "black screen",
        },
      ],
    });
    expect((await vision.json()).inspectedFrames).toEqual([0.5, 3]);

    const first: CutPlan = await (
      await send("POST", "cuts", { source, label: "rough cut" })
    ).json();
    const second: CutPlan = await (
      await send("POST", "cuts", { source, basedOn: first.id, maxPause: 0.5 })
    ).json();
    expect([first.id, second.id, second.basedOn]).toEqual(["cut-1", "cut-2", "cut-1"]);
    const list: { plans: Array<{ id: string }> } = await (
      await get(`cuts?source=${source}`)
    ).json();
    expect(list.plans.map((plan) => plan.id)).toEqual(["cut-1", "cut-2"]);
    expect(((await (await get("cuts/cut-2")).json()) as CutPlan).ranges.length).toBeGreaterThan(0);

    const finalOverview: AnalysisOverview = await (await get(`overview?source=${source}`)).json();
    expect(finalOverview.cuts.map((plan) => plan.id)).toEqual(["cut-1", "cut-2"]);
    expect(finalOverview.vision?.notes).toHaveLength(1);
    expect(finalOverview.visionTargets.length).toBeGreaterThan(0);
  });
});
