// @vitest-environment node
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createTestProject, type TestProject } from "../editing/testProject.js";
import { FakeEngine, makePreset } from "../voice/project/testSupport.js";
import { registerProjectVoiceRoutes } from "./projectVoice.js";

let project: TestProject | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

function setUp(preset = makePreset()) {
  const made = createTestProject();
  project = made;
  const engine = new FakeEngine(`${made.root}/cache`);
  engine.presets.set(preset.id, preset);
  const api = new Hono();
  registerProjectVoiceRoutes(api, made.adapter, engine);
  const call = (method: string, path: string, body?: unknown) =>
    api.request(`/projects/demo/voice${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return { call, engine };
}

describe("project voice routes", () => {
  it("saves a script, sets the voice and reads the view back", async () => {
    const { call } = setUp();
    expect((await call("PUT", "/voice", { presetId: "preset-1" })).status).toBe(200);
    const saved = await call("PUT", "/script", {
      language: "en",
      lines: [{ id: "intro", text: "Hello there." }],
    });
    expect(saved.status).toBe(200);
    const view = await (await call("GET", "/script")).json();
    expect(view).toMatchObject({
      language: "en",
      voice: { id: "preset-1" },
      dialect: { id: "gemini-tts" },
      lines: [{ id: "intro", speakerText: "Hello there.", textChanged: false, clipIds: [] }],
    });
    expect((await call("PUT", "/voice", { presetId: "missing" })).status).toBe(404);
  });

  it("generates, answers 422 with the issues for a dialect violation, and 400 for a bad body", async () => {
    const { call, engine } = setUp();
    await call("PUT", "/voice", { presetId: "preset-1" });
    await call("PUT", "/script", { lines: [{ id: "a", text: "Hello [laugh] there." }] });
    const refused = await call("POST", "/synthesize", { requestId: "request-0001" });
    expect(refused.status).toBe(422);
    const body = await refused.json();
    expect(body.error.code).toBe("dialect_violation");
    expect(body.error.issues[0].code).toBe("foreign_tag_syntax");
    expect(engine.calls).toHaveLength(0);
    expect((await call("POST", "/synthesize", { lineIds: [] })).status).toBe(400);

    await call("PUT", "/script", { lines: [{ id: "a", text: "Hello there." }] });
    const done = await call("POST", "/synthesize", { requestId: "request-0002" });
    expect(done.status).toBe(200);
    const result = await done.json();
    expect(result.lines[0].take.file).toMatch(/^assets\/voice\/hello-there-/);
    const progress = await (await call("GET", "/requests/request-0002")).json();
    expect(progress).toMatchObject({ state: "done", done: 1, total: 1 });
    expect((await call("GET", "/requests/request-nope")).status).toBe(404);
  });

  it("cancels a request and selects a take", async () => {
    const { call, engine } = setUp();
    await call("PUT", "/voice", { presetId: "preset-1" });
    await call("PUT", "/script", { lines: [{ id: "a", text: "Hello there." }] });
    let release: () => void = () => undefined;
    engine.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = call("POST", "/synthesize", { requestId: "request-cancel" });
    const cancel = await call("POST", "/requests/request-cancel/cancel");
    expect(await cancel.json()).toEqual({ requestId: "request-cancel", state: "cancelled" });
    release();
    const answered = await pending;
    expect(answered.status).toBe(409);
    expect((await answered.json()).error.code).toBe("cancelled");

    engine.gate = null;
    const done = await (await call("POST", "/synthesize", { requestId: "request-again" })).json();
    const takeId: string = done.lines[0].take.id;
    const selected = await call("PUT", "/lines/a/take", { takeId });
    expect(selected.status).toBe(200);
    expect((await call("PUT", "/lines/a/take", { takeId: "nope" })).status).toBe(404);
    expect((await call("PUT", "/lines/zzz/take", { takeId })).status).toBe(404);
  });

  it("answers an unknown project with the voice error envelope", async () => {
    setUp();
    const api = new Hono();
    registerProjectVoiceRoutes(
      api,
      project?.adapter ??
        (() => {
          throw new Error("no project");
        })(),
      new FakeEngine(`${project?.root}/cache2`),
    );
    const response = await api.request("/projects/nope/voice/script");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Project not found" },
    });
  });

  it("answers the check without calling the engine", async () => {
    const { call, engine } = setUp();
    await call("PUT", "/voice", { presetId: "preset-1" });
    await call("PUT", "/script", { lines: [{ id: "a", text: "Hello there." }] });
    const check = await (await call("POST", "/check", { lineIds: ["a"] })).json();
    expect(check).toMatchObject({ ok: true, estimate: { lines: 1, requests: 1, scene: false } });
    expect(engine.calls).toHaveLength(0);
    expect((await call("POST", "/check", { lineIds: ["zzz"] })).status).toBe(404);
  });
});
