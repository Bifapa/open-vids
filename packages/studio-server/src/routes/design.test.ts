// @vitest-environment node
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { DesignError, SaveDesignSystemResult } from "@hyperframes/agent-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAnalysisProject, type TestProject } from "../analysis/testSupport.js";
import { DesignFailure } from "../design/errors.js";
import { DesignLibrary } from "../design/library.js";
import { fakeFaces, makeTempDir, sampleRequest, sampleSpec } from "../design/testSupport.js";
import { registerDesignRoutes } from "./design.js";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const HOST = { host: "localhost:5190" };

let cleanup: () => void;
let project: TestProject;
let api: Hono;
let library: DesignLibrary;
let savedEnv: string | undefined;
let fontFailure: DesignFailure | null;

beforeEach(() => {
  const temp = makeTempDir("openvids-design-routes-");
  project = createAnalysisProject({ speech: false });
  savedEnv = process.env.OPENVIDS_DESIGN_SYSTEMS_DIR;
  process.env.OPENVIDS_DESIGN_SYSTEMS_DIR = join(temp.dir, "library");
  cleanup = () => {
    temp.cleanup();
    project.cleanup();
    if (savedEnv === undefined) delete process.env.OPENVIDS_DESIGN_SYSTEMS_DIR;
    else process.env.OPENVIDS_DESIGN_SYSTEMS_DIR = savedEnv;
  };
  fontFailure = null;
  api = new Hono();
  // The routes build the library (and its project-file resolver) themselves; only the network is replaced.
  const built = registerDesignRoutes(api, project.adapter);
  library = new DesignLibrary(built.root, {
    fetchFont: async (family, weights) => {
      if (fontFailure) throw fontFailure;
      return fakeFaces(family, weights);
    },
    resolveProjectFile: async (projectId, path) => {
      const resolved = await project.adapter.resolveProject(projectId);
      return resolved ? { absPath: join(resolved.dir, path) } : null;
    },
  });
  api = new Hono();
  registerDesignRoutes(api, project.adapter, { library });
});
afterEach(() => cleanup());

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  api.request(path, {
    method,
    headers: {
      ...HOST,
      ...(body !== undefined && { "content-type": "application/json" }),
      ...headers,
    },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const errorOf = async (response: Response): Promise<DesignError> => {
  const body: { error: DesignError } = await response.json();
  return body.error;
};
const save = async (
  id = "sunset-talks",
  request = sampleRequest(),
): Promise<SaveDesignSystemResult> => {
  const response = await send("PUT", `/design-systems/${id}`, request);
  expect(response.status).toBe(200);
  return response.json();
};

describe("design-systems routes", () => {
  it("creates, lists, reads, renames and deletes a system", async () => {
    expect(await (await send("GET", "/design-systems")).json()).toEqual({ systems: [] });
    const created = await save();
    expect(created.system).toMatchObject({ id: "sunset-talks", version: 1 });
    expect(created.notes.length).toBeGreaterThan(0);

    const list: { systems: { id: string }[] } = await (await send("GET", "/design-systems")).json();
    expect(list.systems.map((entry) => entry.id)).toEqual(["sunset-talks"]);
    const detail = await (await send("GET", "/design-systems/sunset-talks")).json();
    expect(detail).toMatchObject({ id: "sunset-talks", versions: [{ version: 1 }] });
    expect(detail.spec.tokens["--brand"]).toBe("#ff6a3d");

    const renamed = await send("PATCH", "/design-systems/sunset-talks", { name: "Golden Hour" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "Golden Hour", version: 1 });

    expect(await (await send("DELETE", "/design-systems/sunset-talks")).json()).toEqual({
      ok: true,
    });
    expect((await send("GET", "/design-systems/sunset-talks")).status).toBe(404);
  });

  it("answers each failure with its status and a { error } body", async () => {
    await save();
    const brand = sampleSpec();
    brand.tokens["--brand"] = "#000000";
    const stale = await send(
      "PUT",
      "/design-systems/sunset-talks",
      sampleRequest({ baseVersion: 7, spec: brand }),
    );
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe("conflict");
    expect((await send("PUT", "/design-systems/sunset-talks", sampleRequest())).status).toBe(409);

    const noTokens = sampleSpec();
    delete noTokens.tokens["--bg"];
    const invalid = await send("PUT", "/design-systems/other", sampleRequest({ spec: noTokens }));
    expect(invalid.status).toBe(422);
    expect(await errorOf(invalid)).toMatchObject({
      code: "invalid_system",
      issues: ["missing required token --bg"],
    });

    expect((await send("PUT", "/design-systems/other", { name: "x" })).status).toBe(400);
    expect((await send("PUT", "/design-systems/other", "{ nope")).status).toBe(400);
    expect((await send("PUT", "/design-systems/Bad_Id", sampleRequest())).status).toBe(400);
    expect((await send("PATCH", "/design-systems/sunset-talks", { name: "" })).status).toBe(400);
    expect((await send("PATCH", "/design-systems/missing", { name: "X" })).status).toBe(404);
    expect((await send("DELETE", "/design-systems/missing")).status).toBe(404);
    expect((await send("GET", "/design-systems/sunset-talks?version=0")).status).toBe(400);
    expect((await send("GET", "/design-systems/sunset-talks?version=9")).status).toBe(404);
    expect((await send("GET", "/design-systems/..%2Fetc")).status).toBe(404);

    fontFailure = new DesignFailure("asset_unavailable", "Google Fonts is unreachable");
    const offline = await send("PUT", "/design-systems/offline", sampleRequest());
    expect(offline.status).toBe(502);
    expect((await errorOf(offline)).code).toBe("asset_unavailable");
  });

  it("refuses a body over the limit", async () => {
    const huge = sampleRequest({ name: "x".repeat(3 * 1024 * 1024) });
    const response = await send("PUT", "/design-systems/huge", JSON.stringify(huge));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("too large");
  });

  it("refuses state-changing requests from another origin, but serves reads and same-origin writes", async () => {
    const foreign = { origin: "http://evil.test" };
    await save();
    const attempts = [
      await send("PUT", "/design-systems/evil", sampleRequest(), foreign),
      await send("PATCH", "/design-systems/sunset-talks", { name: "Hacked" }, foreign),
      await send("DELETE", "/design-systems/sunset-talks", undefined, foreign),
    ];
    expect(attempts.map((response) => response.status)).toEqual([403, 403, 403]);
    expect((await errorOf(attempts[0] as Response)).code).toBe("invalid_request");
    expect(library.list().map((entry) => [entry.id, entry.name])).toEqual([
      ["sunset-talks", "Sunset Talks"],
    ]);

    expect((await send("GET", "/design-systems", undefined, foreign)).status).toBe(200);
    const same = await send(
      "PATCH",
      "/design-systems/sunset-talks",
      { name: "Fine" },
      { origin: "http://localhost:5190" },
    );
    expect(same.status).toBe(200);
  });
});

describe("design-systems files", () => {
  it("serves a version's files sandboxed, with their content types", async () => {
    await save();
    const html = await send("GET", "/design-systems/sunset-talks/files/system.html");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("content-security-policy")).toBe(
      "sandbox allow-same-origin; default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:",
    );
    expect(html.headers.get("access-control-allow-origin")).toBeNull();
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await html.text()).toContain("openvids-design-manifest");

    const detail = await (await send("GET", "/design-systems/sunset-talks")).json();
    const fontPath: string = detail.files.find((file: string) => file.startsWith("fonts/"));
    const font = await send("GET", `/design-systems/sunset-talks/files/${fontPath}`);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("content-security-policy")).toContain("sandbox");
    // The showcase keeps its origin (sandbox allow-same-origin, no scripts), so no response grants cross-origin reads.
    expect(font.headers.get("access-control-allow-origin")).toBeNull();
    expect(
      Buffer.from(await font.arrayBuffer())
        .subarray(0, 4)
        .toString(),
    ).toBe("wOF2");

    const css = await send("GET", "/design-systems/sunset-talks/files/tokens.css");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("access-control-allow-origin")).toBeNull();
    const svg = await send("GET", "/design-systems/sunset-talks/files/thumbnail.svg");
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("serves an older version on request and only files that belong to a version", async () => {
    await save();
    const brand = sampleSpec();
    brand.tokens["--brand"] = "#00aa66";
    await send(
      "PUT",
      "/design-systems/sunset-talks",
      sampleRequest({ baseVersion: 1, spec: brand }),
    );
    const current = await (
      await send("GET", "/design-systems/sunset-talks/files/tokens.css")
    ).text();
    const first = await (
      await send("GET", "/design-systems/sunset-talks/files/tokens.css?version=1")
    ).text();
    expect(current).toContain("#00aa66");
    expect(first).toContain("#ff6a3d");

    for (const path of [
      "meta.json",
      "versions/1/version.json",
      "../meta.json",
      "..%2Fmeta.json",
      "fonts/..%2F..%2Fmeta.json",
      "nope.css",
      "fonts",
    ]) {
      const response = await send("GET", `/design-systems/sunset-talks/files/${path}`);
      expect([400, 404]).toContain(response.status);
    }
    expect((await send("GET", "/design-systems/missing/files/system.html")).status).toBe(404);
    expect(
      (await send("GET", "/design-systems/sunset-talks/files/system.html?version=9")).status,
    ).toBe(404);
  });
});

describe("project files through the routes' own resolver", () => {
  it("copies a logo from the project the request names, inside the project only", async () => {
    mkdirSync(project.path("assets"), { recursive: true });
    writeFileSync(project.path("assets/logo.svg"), SVG);
    const spec = sampleSpec({
      fonts: [],
      logo: { projectPath: "assets/logo.svg", license: { name: "Own work" } },
    });
    const own = new Hono();
    registerDesignRoutes(own, project.adapter); // the default library: the real resolver over the adapter
    const put = (id: string, request: unknown) =>
      own.request(`/design-systems/${id}`, {
        method: "PUT",
        headers: { ...HOST, "content-type": "application/json" },
        body: JSON.stringify(request),
      });

    expect((await put("branded", sampleRequest({ spec, projectId: "demo" }))).status).toBe(200);
    const logo = await own.request("/design-systems/branded/files/logo.svg", { headers: HOST });
    expect(await logo.text()).toBe(SVG);

    // Editing it later (the file moved or the edit runs from another project): the stored logo is named by its
    // library path, the request still carries the projectId, and the missing project file keeps the stored copy.
    rmSync(project.path("assets/logo.svg"));
    const stored: { spec: ReturnType<typeof sampleSpec> } = await (
      await own.request("/design-systems/branded", { headers: HOST })
    ).json();
    expect(stored.spec.logo?.projectPath).toBe("logo.svg");
    const edited = await put(
      "branded",
      sampleRequest({
        spec: { ...stored.spec, motionRules: ["Edited"] },
        baseVersion: 1,
        projectId: "demo",
      }),
    );
    expect(edited.status).toBe(200);
    const again = await own.request("/design-systems/branded/files/logo.svg", { headers: HOST });
    expect(await again.text()).toBe(SVG);

    const traversal = sampleSpec({
      fonts: [],
      logo: { projectPath: "../outside.svg", license: null },
    });
    expect(
      (await put("escape", sampleRequest({ spec: traversal, projectId: "demo" }))).status,
    ).toBe(502);
    const unknownProject = await put(
      "nowhere",
      sampleRequest({ spec, projectId: "other-project" }),
    );
    expect(unknownProject.status).toBe(502);

    if (process.platform !== "win32") {
      writeFileSync(join(project.root, "secret.svg"), SVG);
      symlinkSync(join(project.root, "secret.svg"), project.path("assets/leak.svg"));
      const leak = sampleSpec({
        fonts: [],
        logo: { projectPath: "assets/leak.svg", license: null },
      });
      const refused = await put("leak", sampleRequest({ spec: leak, projectId: "demo" }));
      expect(refused.status).toBe(502);
    }
  });
});
