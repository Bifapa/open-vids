import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFileRoutes } from "./files";
import type { StudioApiAdapter } from "../types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function caseInsensitiveVolume(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "hf-case-probe-"));
  try {
    return existsSync(dir.toUpperCase());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "hf-files-delete-rename-"));
  tempDirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const adapter: StudioApiAdapter = {
    listProjects: () => [],
    resolveProject: async (id: string) => ({ id, dir }),
    bundle: async () => null,
    lint: async () => ({ findings: [] }),
    runtimeUrl: "/api/runtime.js",
    rendersDir: () => join(dir, "renders"),
    startRender: () => ({ id: "job", status: "rendering", progress: 0, outputPath: "out.mp4" }),
  };
  const app = new Hono();
  registerFileRoutes(app, adapter);
  return { dir, app };
}

function remove(app: Hono, subpath: string) {
  return app.request(`http://localhost/projects/demo/files${subpath}`, { method: "DELETE" });
}

function rename(app: Hono, subpath: string, newPath: string) {
  return app.request(`http://localhost/projects/demo/files/${subpath}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newPath }),
  });
}

describe("DELETE /projects/:id/files — project root and folders", () => {
  it.each(["", "/", "/.", "/%2E", "/assets/..", "/assets/%2E%2E"])(
    "refuses a delete that resolves to the project folder (%j) and leaves the project intact",
    async (subpath) => {
      const { dir, app } = project({
        "index.html": "<html></html>",
        "assets/a.png": "png",
        ".hyperframes/story/graph.json": "{}",
      });

      const response = await remove(app, subpath);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ why: "project_root" });
      expect(readFileSync(join(dir, "index.html"), "utf-8")).toBe("<html></html>");
      expect(existsSync(join(dir, "assets/a.png"))).toBe(true);
      expect(existsSync(join(dir, ".hyperframes/story/graph.json"))).toBe(true);
    },
  );

  it("refuses to delete the bookkeeping folder or the backup journal", async () => {
    const { dir, app } = project({
      "index.html": "x",
      ".hyperframes/story/graph.json": "{}",
      ".hyperframes/backup/old": "old",
    });

    expect((await remove(app, "/.hyperframes")).status).toBe(400);
    expect((await remove(app, "/.hyperframes/backup")).status).toBe(400);
    expect(existsSync(join(dir, ".hyperframes/story/graph.json"))).toBe(true);
    expect(readFileSync(join(dir, ".hyperframes/backup/old"), "utf-8")).toBe("old");
  });

  it.runIf(caseInsensitiveVolume())(
    "refuses them under another letter case, where the volume reads it as the same folder",
    async () => {
      const { dir, app } = project({
        "index.html": "x",
        ".hyperframes/story/graph.json": "{}",
        ".hyperframes/backup/old": "old",
      });

      for (const subpath of ["/.HYPERFRAMES", "/.hyperframes/BACKUP", "/.Hyperframes/Backup/old"]) {
        expect((await remove(app, subpath)).status).toBe(400);
      }
      expect(existsSync(join(dir, ".hyperframes/story/graph.json"))).toBe(true);
      expect(readFileSync(join(dir, ".hyperframes/backup/old"), "utf-8")).toBe("old");
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses them when reached through a linked folder",
    async () => {
      const { dir, app } = project({
        "index.html": "x",
        ".hyperframes/backup/old": "old",
      });
      symlinkSync(join(dir, ".hyperframes"), join(dir, "shortcut"), "dir");

      expect((await remove(app, "/shortcut/backup")).status).toBe(400);
      expect((await remove(app, "/shortcut/backup/old")).status).toBe(400);
      expect(readFileSync(join(dir, ".hyperframes/backup/old"), "utf-8")).toBe("old");

      // The link itself is removable: only the link goes, never what it points at.
      expect((await remove(app, "/shortcut")).status).toBe(200);
      expect(existsSync(join(dir, ".hyperframes/backup/old"))).toBe(true);
    },
  );

  it("journals every file of a deleted folder before removing it", async () => {
    const { dir, app } = project({
      "index.html": "x",
      "scenes/a.html": "scene a",
      "scenes/deep/b.html": "scene b",
    });

    const response = await remove(app, "/scenes");
    const payload = (await response.json()) as { ok: boolean; backupPaths: string[] };

    expect(response.status).toBe(200);
    expect(existsSync(join(dir, "scenes"))).toBe(false);
    expect(payload.backupPaths).toHaveLength(2);
    expect(
      payload.backupPaths.map((path) => readFileSync(join(dir, path), "utf-8")).sort(),
    ).toEqual(["scene a", "scene b"]);
  });

  it("leaves a folder in place when one of its files cannot be journaled", async () => {
    const { dir, app } = project({ "scenes/a.html": "scene a" });
    // `.hyperframes` is a file, so the journal directory cannot be created.
    writeFileSync(join(dir, ".hyperframes"), "not a directory");

    const response = await remove(app, "/scenes");

    expect(response.status).toBe(500);
    expect(readFileSync(join(dir, "scenes/a.html"), "utf-8")).toBe("scene a");
  });

  it("deletes a single file past the journal limit without copying it into the journal", async () => {
    const { dir, app } = project({ "assets/clip.mp4": "" });
    truncateSync(join(dir, "assets/clip.mp4"), 300 * 1024 * 1024);

    const response = await remove(app, "/assets/clip.mp4");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      backupPath: null,
      unbackedFiles: ["assets/clip.mp4"],
    });
    expect(existsSync(join(dir, "assets/clip.mp4"))).toBe(false);
    expect(existsSync(join(dir, ".hyperframes/backup"))).toBe(false);
  });

  it("journals a single file under the limit as before", async () => {
    const { dir, app } = project({ "assets/note.txt": "keep me" });

    const payload = (await (await remove(app, "/assets/note.txt")).json()) as {
      backupPath: string;
    };

    expect(readFileSync(join(dir, payload.backupPath), "utf-8")).toBe("keep me");
  });
});

describe("PATCH /projects/:id/files — reference updates", () => {
  it("renames a folder without rewriting the tags and words that merely contain its name", async () => {
    const html = [
      '<div class="img"><img src="img/a.png" alt="img"><img src=\'./img/b.png\'>',
      '<video src="../img/c.png"></video></div>',
      "<style>.hero { background: url(img/a.png) } .my-img { color: red }</style>",
      "<p>An img tag shows img/a.png here, and pre-img/a.png is another file.</p>",
      '<!-- <img src="my-img/a.png"> -->',
    ].join("\n");
    const { dir, app } = project({ "index.html": html, "img/a.png": "png" });

    const response = await rename(app, "img", "images");

    expect(response.status).toBe(200);
    expect(existsSync(join(dir, "images/a.png"))).toBe(true);
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toBe(
      [
        '<div class="img"><img src="images/a.png" alt="img"><img src=\'./images/b.png\'>',
        '<video src="../images/c.png"></video></div>',
        "<style>.hero { background: url(images/a.png) } .my-img { color: red }</style>",
        "<p>An img tag shows images/a.png here, and pre-img/a.png is another file.</p>",
        '<!-- <img src="my-img/a.png"> -->',
      ].join("\n"),
    );
  });

  it("renames a file only where its whole path is named, in plain and URL-encoded spelling", async () => {
    const { dir, app } = project({
      "index.html": [
        '<img src="logo.png"><img src="assets/my-logo.png"><img src="logo.png?v=2">',
        '<img src="my%20clip.mp4"><p>logo.png.bak and https://example.com/logo.png</p>',
      ].join("\n"),
      "logo.png": "png",
      "my clip.mp4": "mp4",
    });

    expect((await rename(app, "logo.png", "brand.png")).status).toBe(200);
    expect((await rename(app, "my%20clip.mp4", "your clip.mp4")).status).toBe(200);

    expect(readFileSync(join(dir, "index.html"), "utf-8")).toBe(
      [
        '<img src="brand.png"><img src="assets/my-logo.png"><img src="brand.png?v=2">',
        '<img src="your%20clip.mp4"><p>logo.png.bak and https://example.com/logo.png</p>',
      ].join("\n"),
    );
  });

  it("leaves chats and caches under .hyperframes alone but updates the records that name project files", async () => {
    const chat = JSON.stringify({ text: "I moved img/a.png and wrote img/a.png into index.html" });
    const { dir, app } = project({
      "index.html": "x",
      "img/a.png": "png",
      ".hyperframes/agent/chats/one/chat.json": chat,
      ".hyperframes/story/graph.json": '{"src":"img/a.png","note":"see img/a.png now"}',
      ".hyperframes/media/ranges.json": '{"img/a.png":{"from":1}}',
    });

    expect((await rename(app, "img/a.png", "img/b.png")).status).toBe(200);

    expect(readFileSync(join(dir, ".hyperframes/agent/chats/one/chat.json"), "utf-8")).toBe(chat);
    expect(readFileSync(join(dir, ".hyperframes/story/graph.json"), "utf-8")).toBe(
      '{"src":"img/b.png","note":"see img/a.png now"}',
    );
    expect(readFileSync(join(dir, ".hyperframes/media/ranges.json"), "utf-8")).toBe(
      '{"img/b.png":{"from":1}}',
    );
  });
});

describe("PATCH /projects/:id/files — letter case", () => {
  it("renames a file whose new name differs only in case, also on a case-insensitive volume", async () => {
    const { dir, app } = project({ "index.html": '<img src="Clip.MP4">', "Clip.MP4": "video" });

    const response = await rename(app, "Clip.MP4", "clip.mp4");

    expect(response.status).toBe(200);
    expect(readdirSync(dir).sort()).toEqual(["clip.mp4", "index.html"]);
    expect(readFileSync(join(dir, "clip.mp4"), "utf-8")).toBe("video");
    expect(readFileSync(join(dir, "index.html"), "utf-8")).toBe('<img src="clip.mp4">');
  });

  it("still refuses a different file that already has the new name", async () => {
    const { dir, app } = project({ "a.html": "a", "b.html": "b" });

    expect((await rename(app, "a.html", "b.html")).status).toBe(409);
    expect(readFileSync(join(dir, "a.html"), "utf-8")).toBe("a");
    expect(readFileSync(join(dir, "b.html"), "utf-8")).toBe("b");
  });
});
