// @vitest-environment node
import { Hono } from "hono";
import type {
  ApplyEditsResponse,
  EditError,
  PresetInfo,
  ProjectAsset,
  ProjectInventory,
  TimelineSnapshot,
} from "@hyperframes/agent-protocol";
import type { RegistryItem } from "@hyperframes/core";
import { afterEach, describe, expect, it } from "vitest";
import { fakeProber, createTestProject, type TestProject } from "../editing/testProject.js";
import { registerEditingRoutes } from "./editing.js";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const SKINS = join(import.meta.dirname, "../../../../skills/hyperframes-creative/frame-presets");
const CATALOG: RegistryItem[] = [
  {
    type: "hyperframes:block",
    name: "lower-third-pop",
    title: "Lower Third Pop",
    description: "A pop-in name bar",
    tags: ["Titles", "social"],
    dimensions: { width: 1920, height: 1080 },
    duration: 5,
    files: [{ path: "a.html", target: "compositions/a.html", type: "hyperframes:composition" }],
  },
  {
    type: "hyperframes:component",
    name: "badge-pop",
    title: "Badge",
    description: "A badge",
    files: [
      { path: "b.html", target: "compositions/components/b.html", type: "hyperframes:snippet" },
    ],
  },
];

let project: TestProject | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

function setup() {
  const made = createTestProject({
    adapter: { captionSkinsDir: () => SKINS, listRegistryCatalog: async () => CATALOG },
  });
  project = made;
  const api = new Hono();
  registerEditingRoutes(api, made.adapter, { probe: fakeProber });
  const get = (path: string) => api.request(`/projects/demo/editing/${path}`);
  const post = (body: unknown, id = "demo") =>
    api.request(`/projects/${id}/editing/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { made, api, get, post };
}

async function errorOf(response: Response): Promise<EditError> {
  const body: { error: EditError } = await response.json();
  return body.error;
}

describe("GET /editing/project", () => {
  it("lists compositions, probed media assets and renders", async () => {
    const { made, get } = setup();
    mkdirSync(join(made.project.dir, "renders"));
    writeFileSync(join(made.project.dir, "renders/out.mp4"), "video");
    const inventory: ProjectInventory = await (await get("project")).json();

    expect(inventory.compositions.map((c) => [c.path, c.isMain, c.clipCount, c.duration])).toEqual([
      ["compositions/lower-third.html", false, 1, 3],
      ["index.html", true, 4, 10],
    ]);
    expect(
      inventory.assets.map((a) => [a.path, a.kind, a.duration, a.width, a.height, a.hasAudio]),
    ).toEqual([
      ["assets/a.mp4", "video", 8, 1920, 1080, true],
      ["assets/b.mp4", "video", 5, 1280, 720, false],
      ["assets/fonts/brand.woff2", "font", null, null, null, null],
      ["assets/music.mp3", "audio", 30, null, null, null],
      ["assets/photo.png", "image", null, 800, 600, null],
    ]);
    expect(inventory.renders.map((r) => r.path)).toEqual(["renders/out.mp4"]);
  });

  it("does not list hidden folders, or renders, as assets", async () => {
    const { made, get } = setup();
    made.write(".hyperframes/backup/x.mp4", "x");
    made.write("renders/take1.mp4", "x");
    const inventory: ProjectInventory = await (await get("project")).json();
    expect(
      inventory.assets.some(
        (a) => a.path.startsWith(".hyperframes") || a.path.startsWith("renders"),
      ),
    ).toBe(false);
  });

  it("404s an unknown project", async () => {
    const { api } = setup();
    expect((await api.request("/projects/nope/editing/project")).status).toBe(404);
  });
});

describe("GET /editing/timeline and /editing/probe", () => {
  it("returns the main composition by default and a named one on request", async () => {
    const { get } = setup();
    const main: TimelineSnapshot = await (await get("timeline")).json();
    expect(main.composition.path).toBe("index.html");
    const sub: TimelineSnapshot = await (
      await get("timeline?composition=compositions/lower-third.html")
    ).json();
    expect(sub.clips.map((c) => c.domId)).toEqual(["lt-bar"]);
    const missing = await get("timeline?composition=nope.html");
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toMatchObject({ code: "unknown_composition" });
  });

  it("probes any project file, renders included, and 404s a missing one", async () => {
    const { made, get } = setup();
    made.write("renders/out.mp4", "video");
    const asset: ProjectAsset = await (await get("probe?path=assets/a.mp4")).json();
    expect(asset).toMatchObject({
      path: "assets/a.mp4",
      kind: "video",
      duration: 8,
      hasAudio: true,
    });
    expect((await get("probe?path=renders/out.mp4")).status).toBe(200);
    const missing = await get("probe?path=assets/missing.mp4");
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toMatchObject({ code: "unknown_asset" });
    expect((await get("probe?path=../outside.mp4")).status).toBe(404);
  });
});

describe("GET /editing/presets", () => {
  it("lists caption skins by folder with titles, and blocks/components from the registry", async () => {
    const { get } = setup();
    const { presets }: { presets: PresetInfo[] } = await (await get("presets")).json();
    const coral = presets.find((p) => p.name === "coral");
    expect(coral).toMatchObject({ kind: "caption", title: "Coral — Frame (video / frame layer)" });
    expect(presets.filter((p) => p.kind === "caption").length).toBeGreaterThanOrEqual(13);
    expect(presets.find((p) => p.name === "lower-third-pop")).toMatchObject({
      kind: "block",
      duration: 5,
      tags: ["Titles", "social"],
    });
    expect(presets.find((p) => p.name === "badge-pop")).toMatchObject({
      kind: "component",
      duration: null,
    });
  });

  it("filters by kind and by name, title or tag, case-insensitively", async () => {
    const { get } = setup();
    const blocks: { presets: PresetInfo[] } = await (await get("presets?kind=block")).json();
    expect(blocks.presets.map((p) => p.name)).toEqual(["lower-third-pop"]);
    const byTag: { presets: PresetInfo[] } = await (await get("presets?query=SOCIAL")).json();
    expect(byTag.presets.map((p) => p.name)).toEqual(["lower-third-pop"]);
    const byTitle: { presets: PresetInfo[] } = await (
      await get("presets?kind=component&query=badge")
    ).json();
    expect(byTitle.presets.map((p) => p.name)).toEqual(["badge-pop"]);
    expect(
      ((await (await get("presets?query=zzzz")).json()) as { presets: PresetInfo[] }).presets,
    ).toEqual([]);
  });

  it("caps the list at 100 results", async () => {
    const many: RegistryItem[] = Array.from({ length: 150 }, (_, index) => ({
      type: "hyperframes:component" as const,
      name: `c-${index}`,
      title: `C ${index}`,
      description: "",
      files: [
        { path: "x.html", target: "compositions/x.html", type: "hyperframes:snippet" as const },
      ],
    }));
    const made = createTestProject({ adapter: { listRegistryCatalog: async () => many } });
    project = made;
    const api = new Hono();
    registerEditingRoutes(api, made.adapter, { probe: fakeProber });
    const body: { presets: PresetInfo[] } = await (
      await api.request("/projects/demo/editing/presets")
    ).json();
    expect(body.presets).toHaveLength(100);
  });

  it("rejects an unknown kind", async () => {
    const { get } = setup();
    const response = await get("presets?kind=sticker");
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: "invalid_request" });
  });
});

describe("POST /editing/apply boundary", () => {
  it("applies a batch and returns the timeline, results and changed files", async () => {
    const { post, get } = setup();
    const response = await post({
      operations: [
        { op: "add_clip", asset: "assets/b.mp4", start: 10, track: 1 },
        { op: "add_text", text: "Hi", start: 10, duration: 2, track: 2 },
      ],
    });
    expect(response.status).toBe(200);
    const body: ApplyEditsResponse = await response.json();
    expect(body.results.map((r) => r.op)).toEqual(["add_clip", "add_text"]);
    expect(body.changedFiles).toEqual(["index.html"]);
    const timeline: TimelineSnapshot = await (await get("timeline")).json();
    expect(timeline).toEqual(body.timeline);
    expect(timeline.clips).toHaveLength(6);
  });

  it.each([
    ["a non-object body", "[]", undefined],
    ["broken JSON", "{", undefined],
    ["no operations", { operations: [] }, undefined],
    [
      "an unknown top-level field",
      { operations: [{ op: "set_composition", duration: 5 }], extra: 1 },
      undefined,
    ],
    ["an unknown operation", { operations: [{ op: "explode" }] }, 0],
    [
      "an unknown operation field",
      { operations: [{ op: "move_clip", clip: "a", start: 1, colour: "red" }] },
      0,
    ],
    [
      "a string where a number belongs",
      { operations: [{ op: "split_clip", clip: "a", at: "2" }] },
      0,
    ],
    [
      "a negative time",
      {
        operations: [
          { op: "set_composition", duration: 3 },
          { op: "move_clip", clip: "a", start: -1 },
        ],
      },
      1,
    ],
    [
      "a fractional track",
      { operations: [{ op: "add_text", text: "x", start: 0, duration: 1, track: 1.5 }] },
      0,
    ],
    ["a volume past the limit", { operations: [{ op: "set_clip", clip: "a", volume: 9 }] }, 0],
    [
      "a cue ending before it starts",
      {
        operations: [
          { op: "apply_captions", preset: "coral", cues: [{ text: "x", start: 2, end: 1 }] },
        ],
      },
      0,
    ],
    ["a move that changes nothing", { operations: [{ op: "move_clip", clip: "a" }] }, 0],
  ])("400s %s with invalid_request", async (_name, body, opIndex) => {
    const { post } = setup();
    const response = await post(body);
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe("invalid_request");
    expect(error.opIndex).toBe(opIndex);
  });

  it("400s more than 50 operations", async () => {
    const { post } = setup();
    const operations = Array.from({ length: 51 }, () => ({ op: "set_composition", duration: 5 }));
    const response = await post({ operations });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("50");
  });

  it("404s an unknown project", async () => {
    const { post } = setup();
    expect(
      (await post({ operations: [{ op: "set_composition", duration: 5 }] }, "nope")).status,
    ).toBe(404);
  });

  it("answers 409 for a stale baseVersion and 400 with opIndex for a refused operation", async () => {
    const { post, made } = setup();
    const before = made.read("index.html");
    const stale = await post({
      baseVersion: '"sha256:old"',
      operations: [{ op: "set_composition", duration: 5 }],
    });
    expect(stale.status).toBe(409);
    expect(await errorOf(stale)).toMatchObject({ code: "conflict" });

    const refused = await post({
      operations: [
        { op: "add_text", text: "x", start: 0, duration: 1, track: 1 },
        { op: "remove_clip", clip: "ghost" },
      ],
    });
    expect(refused.status).toBe(400);
    expect(await errorOf(refused)).toMatchObject({ code: "unknown_clip", opIndex: 1 });
    expect(made.read("index.html")).toBe(before);
  });

  it("serialises concurrent batches so none overwrites another", async () => {
    const { post, get } = setup();
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        post({
          operations: [
            { op: "add_text", text: `t${index}`, start: index, duration: 1, track: 10 + index },
          ],
        }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const timeline: TimelineSnapshot = await (await get("timeline")).json();
    expect(timeline.clips.filter((c) => c.kind === "text" && c.label.startsWith("t"))).toHaveLength(
      5,
    );
  });
});
