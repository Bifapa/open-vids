// @vitest-environment node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  isProjectDesignExtraction,
  isProjectDesignState,
  isVideoPalette,
  type DesignError,
  type ProjectDesignState,
} from "@hyperframes/agent-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasFfmpeg, makeClip } from "../analysis/testSupport.js";
import { seedSystem, tempLibrary } from "../design/projectTestSupport.js";
import { createTestProject, fakeProber } from "../editing/testProject.js";
import type { StudioApiAdapter } from "../types.js";
import { registerProjectDesignRoutes, type ProjectDesignRouteOptions } from "./projectDesign.js";

const cleanups: Array<() => void> = [];
let scratch = "";
let clip = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "openvids-design-routes-"));
  if (hasFfmpeg) {
    clip = join(scratch, "clip.mp4");
    makeClip(clip);
  }
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(
  options: ProjectDesignRouteOptions = {},
  externalProjects?: StudioApiAdapter["externalProjects"],
) {
  const made = createTestProject();
  const lib = tempLibrary();
  cleanups.push(made.cleanup, lib.dispose);
  const api = new Hono();
  registerProjectDesignRoutes(
    api,
    externalProjects ? { ...made.adapter, externalProjects } : made.adapter,
    lib.library,
    options,
  );
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    project = "demo",
  ) =>
    api.request(`/projects/${project}/design${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { made, library: lib.library, send };
}

async function errorOf(response: Response): Promise<DesignError> {
  const body: { error: DesignError } = await response.json();
  return body.error;
}

describe("the project design routes", () => {
  it("attaches, reads, updates and detaches a library system over HTTP", async () => {
    const { library, send, made } = setup();
    await seedSystem(library, "midnight");

    const empty: ProjectDesignState = await (await send("GET", "")).json();
    expect(isProjectDesignState(empty)).toBe(true);
    expect(empty).toEqual({
      attached: null,
      library: null,
      updateAvailable: false,
      snapshotOk: false,
    });

    const attached = await send("PUT", "", { id: "midnight" });
    expect(attached.status).toBe(200);
    expect(await attached.json()).toMatchObject({
      attached: { id: "midnight", version: 1 },
      snapshotOk: true,
    });
    expect(existsSync(join(made.project.dir, "design/tokens.css"))).toBe(true);

    expect((await send("POST", "/update")).status).toBe(409);
    await seedSystem(library, "midnight", { baseVersion: 1, brand: "#00ff88" });
    const waiting: ProjectDesignState = await (await send("GET", "")).json();
    expect(waiting).toMatchObject({ attached: { version: 1 }, updateAvailable: true });
    const updated = await send("POST", "/update");
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      attached: { version: 2 },
      updateAvailable: false,
    });

    const detached = await send("DELETE", "");
    expect(detached.status).toBe(200);
    expect(await detached.json()).toMatchObject({ attached: null });
    expect(existsSync(join(made.project.dir, "design"))).toBe(false);
  });

  it("refuses bad requests with { error } and the right status", async () => {
    const { send, library } = setup();
    await seedSystem(library, "midnight");
    expect((await errorOf(await send("PUT", "", { id: "Not An Id" }))).code).toBe(
      "invalid_request",
    );
    expect((await send("PUT", "", { id: "Not An Id" })).status).toBe(400);
    const unknown = await send("PUT", "", { id: "ghost" });
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe("not_found");
    expect((await send("POST", "/update")).status).toBe(404);
    expect((await send("GET", "", undefined, {}, "nope")).status).toBe(404);
  });

  it("refuses a state-changing request from another origin and changes nothing", async () => {
    const { send, library, made } = setup();
    await seedSystem(library, "midnight");
    const foreign = await send(
      "PUT",
      "",
      { id: "midnight" },
      { origin: "http://evil.example", host: "localhost:5190" },
    );
    expect(foreign.status).toBe(403);
    expect(existsSync(join(made.project.dir, "design"))).toBe(false);
    const same = await send(
      "PUT",
      "",
      { id: "midnight" },
      { origin: "http://localhost:5190", host: "localhost:5190" },
    );
    expect(same.status).toBe(200);
    expect(
      (
        await send("DELETE", "", undefined, {
          origin: "http://evil.example",
          host: "localhost:5190",
        })
      ).status,
    ).toBe(403);
    expect(existsSync(join(made.project.dir, "design/design.json"))).toBe(true);
  });

  it("answers the deterministic extraction of the project", async () => {
    const { send, made } = setup();
    made.write("styles/theme.css", ".a { color: #ff3366; font-family: 'Inter'; }");
    made.write(
      "index.html",
      `<link rel="stylesheet" href="styles/theme.css"><div style="background:#111111"></div>`,
    );
    const response = await send("GET", "/extract");
    const body: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(isProjectDesignExtraction(body)).toBe(true);
    expect(body).toMatchObject({
      files: expect.arrayContaining(["index.html"]),
      colors: expect.arrayContaining([{ value: "#ff3366", count: 1, roles: ["text"] }]),
      fonts: [{ family: "Inter", count: 1, loading: "unresolved" }],
    });
  });

  it("serves the snapshot's files sandboxed, and nothing outside design/", async () => {
    const { send, library, made } = setup();
    await seedSystem(library, "midnight");
    await send("PUT", "", { id: "midnight" });
    const html = await send("GET", "/files/system.html");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:",
    );
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await html.text()).length).toBeGreaterThan(100);
    expect((await send("GET", "/files/..%2Findex.html")).status).toBeGreaterThanOrEqual(400);
    expect((await send("GET", "/files/%2e%2e/index.html")).status).toBeGreaterThanOrEqual(400);
    expect((await send("GET", "/files/missing.css")).status).toBe(404);
    expect((await send("GET", "/files/fonts")).status).toBe(404);
    expect(made.read("index.html")).toContain("data-composition-id");
  });
});

describe("GET /design/video-palette", () => {
  it.skipIf(!hasFfmpeg)("returns the exact dominant colours of a project video", async () => {
    const { send, made } = setup();
    const target = join(made.project.dir, "assets/clip.mp4");
    copyFileSync(clip, target);
    const response = await send("GET", "/video-palette?video=assets/clip.mp4&samples=8");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(isVideoPalette(body)).toBe(true);
    expect(body).toMatchObject({ video: "assets/clip.mp4", samples: 8 });
    if (!isVideoPalette(body)) return;
    expect(body.durationSec).toBeGreaterThan(7);
    expect(body.colors.length).toBeGreaterThanOrEqual(3);
    expect(body.colors[0]?.share).toBeGreaterThan(0.1);
    expect(
      await (await send("GET", "/video-palette?video=assets/clip.mp4&samples=8")).json(),
    ).toEqual(body);
  });

  it("refuses a missing, escaping or non-video file and bad sample counts", async () => {
    const { send } = setup({ probe: fakeProber });
    const code = async (query: string) => {
      const response = await send("GET", `/video-palette${query}`);
      return [response.status, (await errorOf(response)).code] as const;
    };
    expect(await code("")).toEqual([400, "invalid_request"]);
    expect(await code("?video=..%2F..%2Fetc%2Fpasswd.mp4")).toEqual([400, "invalid_request"]);
    expect(await code("?video=assets/music.mp3")).toEqual([400, "invalid_request"]);
    expect(await code("?video=assets/none.mp4")).toEqual([404, "not_found"]);
    expect(await code("?video=assets/a.mp4&samples=0")).toEqual([400, "invalid_request"]);
    expect(await code("?video=assets/a.mp4&samples=25")).toEqual([400, "invalid_request"]);
    expect(await code("?video=assets/a.mp4&samples=2.5")).toEqual([400, "invalid_request"]);
  });

  it("answers unavailable when ffmpeg is missing", async () => {
    const { send } = setup({ probe: fakeProber, ffmpegPath: join(scratch, "no-such-ffmpeg") });
    const response = await send("GET", "/video-palette?video=assets/a.mp4");
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe("unavailable");
  });
});

describe("GET /design/extract/external/:key", () => {
  function otherProject(): string {
    const dir = mkdtempSync(join(scratch, "other-"));
    mkdirSync(join(dir, "fonts"));
    writeFileSync(join(dir, "fonts", "acme.woff2"), "wOF2");
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><head><style>
        @font-face { font-family: "Acme Sans"; src: url("fonts/acme.woff2"); font-weight: 700; }
        body { background: #102030; color: #fafafa; font-family: "Acme Sans", sans-serif; }
      </style></head><body><div data-composition-id="main"></div></body></html>`,
    );
    return dir;
  }

  it("extracts another project by its key and never reveals its folder or font file paths", async () => {
    const dir = otherProject();
    const { made, send } = setup(
      {},
      {
        list: async () => [],
        resolve: async (key) => (key === "k-other" ? { key, name: "Other", dir } : null),
      },
    );
    const response = await send("GET", "/extract/external/k-other");
    expect(response.status).toBe(200);
    const text = await response.text();
    const extraction: unknown = JSON.parse(text);
    expect(isProjectDesignExtraction(extraction)).toBe(true);
    expect(text).toContain("#102030");
    expect(text).not.toContain(dir);
    expect(text).not.toContain("acme.woff2");
    expect(JSON.parse(text).fonts).toEqual([
      { family: "Acme Sans", count: 1, weights: [700], loading: "unresolved" },
    ]);
    expect(made.read("index.html")).not.toContain("Acme Sans");
  });

  it("refuses an unknown key, the open project itself and a host without the capability", async () => {
    const dir = otherProject();
    const withHost = setup(
      {},
      {
        list: async () => [],
        resolve: async (key) =>
          key === "k-other"
            ? { key, name: "Other", dir }
            : key === "k-self"
              ? { key, name: "Self", dir: withHostDir() }
              : null,
      },
    );
    function withHostDir(): string {
      return withHost.made.project.dir;
    }
    for (const key of ["k-nope", "k-self"]) {
      const response = await withHost.send("GET", `/extract/external/${key}`);
      expect([response.status, (await errorOf(response)).code]).toEqual([404, "not_found"]);
    }
    const bare = setup();
    const response = await bare.send("GET", "/extract/external/k-other");
    expect([response.status, (await errorOf(response)).code]).toEqual([404, "not_found"]);
  });
});
