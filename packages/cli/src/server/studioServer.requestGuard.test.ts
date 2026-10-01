import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createStudioServer, type StudioServer } from "./studioServer.js";
import {
  cleanupStudioServerRoot,
  makeStudioServerRoot,
  writeStudioIndexHtml,
} from "./studioServerTestFixture.js";

const hooks = vi.hoisted(() => ({ studioDir: "" }));

// Point the bundle directory lookup at a temp tree (same trick as the static-assets test).
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof path>();
  return {
    ...actual,
    resolve: (...parts: string[]) =>
      hooks.studioDir && parts.length === 2 && parts[0]?.endsWith("server") && parts[1] === "studio"
        ? hooks.studioDir
        : actual.resolve(...parts),
  };
});

let root: string;
let projectDir: string;
let server: StudioServer;

beforeEach(() => {
  delete process.env["HYPERFRAMES_PREVIEW_HOST"];
  const fixture = makeStudioServerRoot("hf-studio-guard-");
  root = fixture.root;
  projectDir = fixture.projectDir;
  hooks.studioDir = fixture.studioDir;
  fs.writeFileSync(path.join(hooks.studioDir, "assets", "app.js"), "export {};");
  writeStudioIndexHtml(hooks.studioDir);
  server = createStudioServer({ projectDir, projectName: "film" });
});

afterEach(() => {
  cleanupStudioServerRoot(server, root, () => (hooks.studioDir = ""));
});

const evil = { host: "evil.example:5401" };
const local = { host: "127.0.0.1:5401" };
const FILE = "/api/projects/film/files/planted.txt";

describe("Studio server Host guard", () => {
  it.each([
    ["config probe", "/__hyperframes_config"],
    ["api", "/api/projects"],
    ["spa", "/"],
    ["spa deep link", "/some/route"],
    ["bundle asset", "/assets/app.js"],
  ])("refuses an untrusted Host on %s", async (_label, url) => {
    const response = await server.app.request(url, { headers: evil });
    expect(response.status).toBe(403);
  });

  it.each([
    ["config probe", "/__hyperframes_config"],
    ["api", "/api/projects"],
    ["spa", "/"],
    ["bundle asset", "/assets/app.js"],
  ])("serves loopback Hosts on %s", async (_label, url) => {
    for (const host of ["127.0.0.1:5401", "localhost:5401", "[::1]:5401"]) {
      const response = await server.app.request(url, { headers: { host } });
      expect(response.status).toBe(200);
    }
  });
});

describe("Studio server cross-origin guard", () => {
  const post = (headers: Record<string, string>) =>
    server.app.request(FILE, { method: "POST", headers, body: "planted" });

  it("refuses a CORS-simple text/plain POST from a foreign site and writes nothing", async () => {
    const response = await post({
      ...local,
      origin: "https://evil.example",
      "content-type": "text/plain",
      "sec-fetch-site": "cross-site",
    });
    expect(response.status).toBe(403);
    expect(fs.existsSync(path.join(projectDir, "planted.txt"))).toBe(false);
  });

  it("refuses a POST from a sibling loopback port", async () => {
    const response = await post({ ...local, origin: "http://127.0.0.1:5402" });
    expect(response.status).toBe(403);
    expect(fs.existsSync(path.join(projectDir, "planted.txt"))).toBe(false);
  });

  it("accepts a same-origin POST", async () => {
    const response = await post({
      ...local,
      origin: "http://127.0.0.1:5401",
      "sec-fetch-site": "same-origin",
    });
    expect(response.status).toBe(201);
    expect(fs.readFileSync(path.join(projectDir, "planted.txt"), "utf-8")).toBe("planted");
  });

  it("accepts a POST with no Origin (CLI / agent runtime callers)", async () => {
    const response = await post(local);
    expect(response.status).toBe(201);
    expect(fs.existsSync(path.join(projectDir, "planted.txt"))).toBe(true);
  });
});
