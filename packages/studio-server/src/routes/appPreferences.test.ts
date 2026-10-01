// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppPreferencesStore, defaultAppPreferences } from "../app/preferences.js";
import { registerAppPreferencesRoutes } from "./appPreferences.js";

let dir: string;
let api: Hono;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openvids-app-prefs-"));
  const store = new AppPreferencesStore({ dir });
  path = store.path;
  api = new Hono();
  registerAppPreferencesRoutes(api, { store });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const get = async () => (await api.request("/app/preferences")).json();
const put = (body: unknown, headers: Record<string, string> = {}) =>
  api.request("/app/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const stored = (): unknown => JSON.parse(readFileSync(path, "utf-8"));

describe("app preferences route", () => {
  it("answers the defaults while no file exists, without creating one", async () => {
    expect(await get()).toEqual(defaultAppPreferences());
    expect(readdirSync(dir)).toEqual([]);
  });

  it("falls back per key on invalid stored values and keeps unknown keys", async () => {
    writeFileSync(
      path,
      JSON.stringify({
        theme: "neon",
        onLaunch: "last",
        confirmTrash: "yes",
        future: { x: 1 },
        newProject: { fps: 23, width: 0, height: 1920, openIn: "story", location: "", extra: true },
      }),
    );
    expect(await get()).toEqual({
      version: 1,
      theme: "system",
      onLaunch: "last",
      confirmTrash: true,
      future: { x: 1 },
      newProject: {
        fps: 24,
        width: 1920,
        height: 1920,
        openIn: "story",
        location: "~/Movies/OpenVids",
        extra: true,
      },
    });
  });

  it("reads a corrupt file as the defaults", async () => {
    writeFileSync(path, "{ not json");
    expect(await get()).toEqual(defaultAppPreferences());
  });

  it("deep-merges a partial update, persists it and keeps keys written by the desktop", async () => {
    writeFileSync(
      path,
      JSON.stringify({ homeOnly: { sort: "recent" }, newProject: { fps: 30, location: "/x" } }),
    );
    const response = await put({ theme: "light", newProject: { fps: 60 } });
    expect(response.status).toBe(200);
    const next = await response.json();
    expect(next).toMatchObject({
      theme: "light",
      homeOnly: { sort: "recent" },
      newProject: { fps: 60, location: "/x", width: 1920 },
    });
    expect(stored()).toEqual(next);
    expect(await get()).toEqual(next);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each([
    [{ theme: "neon" }, "theme"],
    [{ onLaunch: "never" }, "onLaunch"],
    [{ confirmTrash: 1 }, "confirmTrash"],
    [{ newProject: { fps: 23.976 } }, "newProject.fps"],
    [{ newProject: { width: 9000 } }, "newProject.width"],
    [{ newProject: { height: 1.5 } }, "newProject.height"],
    [{ newProject: { openIn: "timeline" } }, "newProject.openIn"],
    [{ newProject: { location: "relative/path" } }, "newProject.location"],
    [{ newProject: "media" }, "newProject"],
  ])("refuses %j and leaves the file alone", async (patch, key) => {
    writeFileSync(path, JSON.stringify({ theme: "dark" }));
    const response = await put(patch);
    expect(response.status).toBe(400);
    const body: { error: { code: string; message: string } } = await response.json();
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain(key);
    expect(stored()).toEqual({ theme: "dark" });
  });

  it("refuses a body that is not a JSON object", async () => {
    expect((await put([1, 2])).status).toBe(400);
    expect((await put("not json")).status).toBe(400);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a write from another origin", async () => {
    const response = await put(
      { theme: "light" },
      { origin: "https://evil.example", host: "127.0.0.1:5190" },
    );
    expect(response.status).toBe(403);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("accepts a same-origin write", async () => {
    const response = await put(
      { theme: "dark" },
      { origin: "http://127.0.0.1:5190", host: "127.0.0.1:5190" },
    );
    expect(response.status).toBe(200);
    expect(stored()).toMatchObject({ theme: "dark" });
  });
});
