// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import {
  createStudioApi,
  openProjectHistory,
  type ProjectHistory,
  type StudioApiAdapter,
} from "@hyperframes/studio-server";
import { afterEach, describe, expect, it } from "vitest";
import { ChatService } from "./chats.js";
import { HttpCheckpointHost } from "./checkpointHost.http.js";
import type { ProjectScope } from "./checkpointHost.js";
import { HttpEditingHost } from "./editing/host.http.js";
import { AgentSettingsStore } from "./settings.js";
import { FileChatStore } from "./store/index.js";
import { ScriptedAgentBackend } from "./testing/backend.js";
import { waitUntil } from "./testing/runtimeFixture.js";
import { TurnRunner } from "./turns.js";

const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A 1×1 PNG: a real image asset the editing service can place without a media probe. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const COMPOSITION = `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="10" data-width="1920" data-height="1080">
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;

/** Studio's real history engine, history routes and editing routes on loopback, with a real project on disk. */
async function studioWithProject() {
  const root = await mkdtemp(join(tmpdir(), "openvids-editing-integration-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  await mkdir(join(projectDir, "assets"), { recursive: true });
  await writeFile(join(projectDir, "index.html"), COMPOSITION);
  await writeFile(join(projectDir, "assets", "one.png"), PIXEL);
  await writeFile(join(projectDir, "assets", "two.png"), PIXEL);
  const history: ProjectHistory = await openProjectHistory({
    projectDir,
    historyRoot: join(root, "history"),
  });
  cleanup.push(() => history.close());
  const adapter: StudioApiAdapter = {
    listProjects: () => [],
    resolveProject: (id) => (id === "demo" ? { id, dir: projectDir } : null),
    history: () => history,
    bundle: async () => null,
    lint: () => ({ findings: [] }),
    runtimeUrl: "/runtime.js",
    rendersDir: () => join(root, "renders"),
    startRender: () => {
      throw new Error("not used");
    },
  };
  const app = new Hono().route("/api", createStudioApi(adapter));
  const { promise: listening, resolve } = Promise.withResolvers<ServerType>();
  const server: ServerType = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
    resolve(server),
  );
  await listening;
  cleanup.push(() => new Promise((settle) => server.close(settle)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Studio test server has no port");
  const scope: ProjectScope = {
    projectId: "demo",
    projectDir,
    studioOrigin: `http://127.0.0.1:${address.port}`,
  };
  return { scope, root, read: (path: string) => readFile(join(projectDir, path), "utf-8") };
}

describe("Editor edits through the real editing service (checkpoint + revert)", () => {
  it("adds two clips and splits one in a turn, and Revert this turn restores the composition byte for byte", async () => {
    const studio = await studioWithProject();
    const before = await studio.read("index.html");

    const store = new FileChatStore(studio.scope.projectDir);
    const chats = await ChatService.open(studio.scope, store);
    const backend = new ScriptedAgentBackend();
    const settings = new AgentSettingsStore(join(studio.root, "settings"));
    const runner = new TurnRunner(chats, backend, new HttpCheckpointHost(), store, settings, {
      editing: (scope) => new HttpEditingHost(scope),
    });
    cleanup.push(() => runner.dispose());

    const results: string[] = [];
    backend.promptScript = async (_input, session) => {
      if (session.input.agent === "director") {
        await session.callTool("delegate", {
          agent: "editor",
          title: "Assemble",
          task: "Place assets/one.png and assets/two.png back to back, then split the first",
        });
        await session.callTool("wait_for_agents", {});
        return "completed";
      }
      const inspected = await session.callTool("inspect_project", {});
      results.push(inspected.text);
      const edit = await session.callTool("edit_timeline", {
        operations: [
          { op: "add_clip", asset: "assets/one.png", start: 0, track: 0, duration: 4 },
          { op: "add_clip", asset: "assets/two.png", start: 4, track: 0, duration: 4 },
        ],
      });
      results.push(edit.text);
      const snapshot = await session.callTool("inspect_timeline", {});
      results.push(snapshot.text);
      const first = /^(\S+) \| image \| one\.png/m.exec(snapshot.text)?.[1];
      if (!first) throw new Error(`the first clip is missing from:\n${snapshot.text}`);
      const split = await session.callTool("edit_timeline", {
        operations: [{ op: "split_clip", clip: first, at: 2 }],
      });
      results.push(split.text);
      return "completed";
    };

    const chat = await chats.create({}, ["editor"]);
    const turn = await runner.start(chat.id, { prompt: "Assemble a short slideshow" });
    await waitUntil(
      () => chats.get(chat.id)?.turns[0]?.status === "completed",
      "the turn to complete",
      15_000,
    );

    const after = await studio.read("index.html");
    expect(after, results.join("\n---\n")).not.toBe(before);
    expect(after.match(/one\.png/g)?.length).toBe(2); // the split left two halves of the first clip
    expect(after).toContain("two.png");
    const checkpoint = chats.get(chat.id)?.turns[0]?.checkpoint;
    expect(checkpoint?.status).toBe("ready");
    expect(checkpoint?.entryIds.length).toBeGreaterThan(0);

    const reverted = await runner.revert(chat.id, turn.id);
    expect(reverted.ok).toBe(true);
    expect(await studio.read("index.html")).toBe(before);
  });
});
