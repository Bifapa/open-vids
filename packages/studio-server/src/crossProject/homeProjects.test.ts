// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHomeExternalProjects } from "./homeProjects.js";

const SECRET = "s3cret";

interface Seen {
  url: string;
  secret: string | undefined;
  origin: string | undefined;
}

let server: Server | undefined;
let folder: string | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

/** A fake home server: `answers` maps a request path to a status and a body. */
async function home(
  answers: Record<string, { status?: number; body: unknown }>,
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const created = createServer((req: IncomingMessage, res) => {
    seen.push({
      url: req.url ?? "",
      secret: req.headers["x-openvids-secret"]?.toString(),
      origin: req.headers.origin,
    });
    if (req.headers["x-openvids-secret"] !== SECRET) {
      res.writeHead(401).end();
      return;
    }
    const answer = answers[req.url ?? ""];
    if (!answer) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
  server = created;
  await new Promise<void>((done) => created.listen(0, "127.0.0.1", done));
  const address = created.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}`, seen };
}

describe("the home server's project list", () => {
  it("lists and resolves over loopback with the shell's secret, and never sends an Origin", async () => {
    folder = mkdtempSync(join(tmpdir(), "ov-home-"));
    const { url, seen } = await home({
      "/internal/projects": {
        body: {
          projects: [
            { key: "abc", name: "Alpha", openedAt: 5 },
            { key: "def", name: "Beta" },
          ],
        },
      },
      "/internal/projects/abc": { body: { key: "abc", name: "Alpha", dir: folder } },
    });
    const projects = createHomeExternalProjects({
      OPENVIDS_HOME_URL: url,
      OPENVIDS_HOME_SECRET: SECRET,
    });
    expect(await projects?.list()).toEqual([
      { key: "abc", name: "Alpha", openedAt: 5 },
      { key: "def", name: "Beta" },
    ]);
    expect(await projects?.resolve("abc")).toEqual({ key: "abc", name: "Alpha", dir: folder });
    expect(await projects?.resolve("def")).toBeNull();
    expect(seen.every((request) => request.secret === SECRET && request.origin === undefined)).toBe(
      true,
    );
    expect(seen.map((request) => request.url)).toEqual([
      "/internal/projects",
      "/internal/projects/abc",
      "/internal/projects/def",
    ]);
  });

  it("keeps the folder the list carries only when it is an absolute path", async () => {
    const { url } = await home({
      "/internal/projects": {
        body: {
          projects: [
            { key: "abs", name: "Abs", dir: "/tmp/abs" },
            { key: "rel", name: "Rel", dir: "relative/dir" },
            { key: "none", name: "None" },
            { key: "bad", name: 7 },
          ],
        },
      },
    });
    const projects = createHomeExternalProjects({
      OPENVIDS_HOME_URL: url,
      OPENVIDS_HOME_SECRET: SECRET,
    });
    expect(await projects?.list()).toEqual([
      { key: "abs", name: "Abs", dir: "/tmp/abs" },
      { key: "rel", name: "Rel" },
      { key: "none", name: "None" },
    ]);
  });

  it("treats a wrong secret, a bad shape and an unusable folder as nothing", async () => {
    folder = mkdtempSync(join(tmpdir(), "ov-home-"));
    const file = join(folder, "plain.txt");
    writeFileSync(file, "x");
    const { url } = await home({
      "/internal/projects": { body: { projects: "nope" } },
      "/internal/projects/a": { body: { key: "other", name: "A", dir: folder } },
      "/internal/projects/b": { body: { key: "b", name: "B", dir: "relative/dir" } },
      "/internal/projects/c": { body: { key: "c", name: "C", dir: file } },
      "/internal/projects/d": { body: { key: "d", name: "D", dir: join(folder, "missing") } },
    });
    const wrong = createHomeExternalProjects({
      OPENVIDS_HOME_URL: url,
      OPENVIDS_HOME_SECRET: "bad",
    });
    expect(await wrong?.list()).toEqual([]);
    expect(await wrong?.resolve("a")).toBeNull();

    const projects = createHomeExternalProjects({
      OPENVIDS_HOME_URL: url,
      OPENVIDS_HOME_SECRET: SECRET,
    });
    expect(await projects?.list()).toEqual([]);
    for (const key of ["a", "b", "c", "d"]) expect(await projects?.resolve(key)).toBeNull();
  });

  it("gives up on a server that is not there", async () => {
    const projects = createHomeExternalProjects(
      { OPENVIDS_HOME_URL: "http://127.0.0.1:1", OPENVIDS_HOME_SECRET: SECRET },
      { timeoutMs: 500 },
    );
    expect(await projects?.list()).toEqual([]);
    expect(await projects?.resolve("abc")).toBeNull();
  });

  it("is only offered for a loopback http address, and only with a secret", () => {
    expect(createHomeExternalProjects({})).toBeNull();
    for (const url of [
      "https://127.0.0.1:5000",
      "http://example.com",
      "http://192.168.1.5:5000",
      "http://user:pw@127.0.0.1:5000",
      "not a url",
    ]) {
      expect(
        createHomeExternalProjects({ OPENVIDS_HOME_URL: url, OPENVIDS_HOME_SECRET: SECRET }),
      ).toBeNull();
    }
    expect(createHomeExternalProjects({ OPENVIDS_HOME_URL: "http://127.0.0.1:5000" })).toBeNull();
    expect(
      createHomeExternalProjects({
        OPENVIDS_HOME_URL: "http://127.0.0.1:5000",
        OPENVIDS_HOME_SECRET: SECRET,
      }),
    ).not.toBeNull();
  });

  it("reads the dev link file again on every call: absent, then written, then changed", async () => {
    folder = mkdtempSync(join(tmpdir(), "ov-home-"));
    const linkFile = join(folder, "home-link.json");
    const projects = createHomeExternalProjects({ OPENVIDS_HOME_FILE: linkFile });
    expect(projects).not.toBeNull();
    expect(await projects?.list()).toEqual([]);

    const first = await home({
      "/internal/projects": { body: { projects: [{ key: "a", name: "First" }] } },
    });
    writeFileSync(linkFile, JSON.stringify({ url: first.url, secret: SECRET }));
    expect(await projects?.list()).toEqual([{ key: "a", name: "First" }]);

    writeFileSync(linkFile, JSON.stringify({ url: "http://example.com", secret: SECRET }));
    expect(await projects?.list()).toEqual([]);
    writeFileSync(linkFile, "{ broken");
    expect(await projects?.list()).toEqual([]);
  });
});
