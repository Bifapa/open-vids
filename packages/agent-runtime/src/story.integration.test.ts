// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
import {
  isRecord,
  parseStoryGraph,
  type StoryGraph,
  type StoryView,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ChatService } from "./chats.js";
import { HttpCheckpointHost } from "./checkpointHost.http.js";
import type { ProjectScope } from "./checkpointHost.js";
import { HttpAnalysisHost } from "./analysis/host.http.js";
import { HttpEditingHost } from "./editing/host.http.js";
import { AgentSettingsStore } from "./settings.js";
import { HttpStoryHost } from "./story/host.http.js";
import { FileChatStore } from "./store/index.js";
import { ScriptedAgentBackend } from "./testing/backend.js";
import { waitUntil } from "./testing/runtimeFixture.js";
import { TurnRunner } from "./turns.js";

const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const COMPOSITION = `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="12" data-width="1280" data-height="720">
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;

const SOURCE = "assets/talk.mp4";
const PICTURE = "assets/card.png";

/** 12 s of "talk": a red and a blue shot with a tone. The story only needs a real file with real durations. */
function makeMedia(dir: string): void {
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x180:d=12:r=25",
      "-f",
      "lavfi",
      "-i",
      "sine=f=330:d=12:sample_rate=48000",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-y",
      join(dir, SOURCE),
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=320x180",
      "-frames:v",
      "1",
      "-y",
      join(dir, PICTURE),
    ],
    { stdio: "ignore" },
  );
}

async function studioWithMedia() {
  const root = await mkdtemp(join(tmpdir(), "openvids-story-integration-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  await mkdir(join(projectDir, "assets"), { recursive: true });
  await writeFile(join(projectDir, "index.html"), COMPOSITION);
  makeMedia(projectDir);
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
  cleanup.push(() => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Studio test server has no port");
  const scope: ProjectScope = {
    projectId: "demo",
    projectDir,
    studioOrigin: `http://127.0.0.1:${address.port}`,
  };
  const api = `${scope.studioOrigin}/api/projects/demo`;
  return {
    scope,
    root,
    read: (path: string) => readFile(join(projectDir, path), "utf-8"),
    exists: (path: string) => existsSync(join(projectDir, path)),
    /** The story as Studio serves it. */
    async view(): Promise<StoryView> {
      const response = await fetch(`${api}/story`);
      const payload: unknown = await response.json();
      if (!response.ok || !isRecord(payload))
        throw new Error(`GET story failed: ${response.status}`);
      return payload as unknown as StoryView;
    },
    /** What Studio does when the user edits the canvas: save the whole graph. */
    async save(graph: StoryGraph, baseVersion: string | null): Promise<void> {
      const response = await fetch(`${api}/story`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseVersion, graph }),
      });
      if (!response.ok) throw new Error(`PUT story failed: ${await response.text()}`);
    },
  };
}

describe.skipIf(!hasFfmpeg())(
  "Story Mode through the real story, editing and history services (plan → user edits → review → build → revert)",
  () => {
    it("plans a story, respects the user's locks and decisions in a review, builds one revertible turn, and revert restores graph and timeline together", async () => {
      const studio = await studioWithMedia();
      const before = await studio.read("index.html");

      const store = new FileChatStore(studio.scope.projectDir);
      const chats = await ChatService.open(studio.scope, store);
      const backend = new ScriptedAgentBackend();
      const settings = new AgentSettingsStore(join(studio.root, "settings"));
      const runner = new TurnRunner(chats, backend, new HttpCheckpointHost(), store, settings, {
        editing: (scope) => new HttpEditingHost(scope),
        analysis: (scope) => new HttpAnalysisHost(scope),
        story: (scope) => new HttpStoryHost(scope),
        analysisPollMs: 20,
      });
      cleanup.push(() => runner.dispose());
      const chat = await chats.create({}, []);

      const seen: Record<string, string> = {};
      const refusals: string[] = [];
      let script: (
        text: string,
        call: (name: string, args: unknown) => Promise<string>,
      ) => Promise<void> = async () => undefined;
      backend.promptScript = async (input, session) => {
        const call = async (name: string, args: unknown) => {
          const result = await session.callTool(name, args);
          if (result.isError) refusals.push(`${name}: ${result.text}`);
          return result.text;
        };
        await script(input.text, call);
        return "completed";
      };
      const finished = (index: number, what: string) =>
        waitUntil(
          () => {
            const status = chats.get(chat.id)?.turns[index]?.status;
            return status !== undefined && status !== "running";
          },
          what,
          60_000,
        );

      // ── Turn 1: plan (story mode, no timeline) ────────────────────────────────────────────────
      script = async (_text, call) => {
        await call("edit_story", {
          operations: [
            { op: "set_story", title: "Room tour", brief: "A short tour of the room" },
            {
              op: "add_node",
              ref: "a",
              node: {
                kind: "chapter",
                title: "Welcome",
                narrativeRole: "intro",
                estimatedDuration: 4,
                sourceRanges: [{ source: SOURCE, from: 0, to: 4 }],
              },
            },
            {
              op: "add_node",
              ref: "b",
              node: {
                kind: "chapter",
                title: "The test",
                narrativeRole: "main",
                estimatedDuration: 5,
                sourceRanges: [{ source: SOURCE, from: 6, to: 11 }],
              },
            },
            {
              op: "add_node",
              ref: "pic",
              node: { kind: "picture", title: "Title card", asset: PICTURE },
            },
            { op: "connect", from: "@a", to: "@b", transition: "cut on the clap" },
            { op: "attach", node: "@pic", chapter: "@a", placement: "start", duration: 2 },
          ],
        });
        seen.plan = await call("read_story", {});
      };
      await runner.start(chat.id, { prompt: "Plan a short room tour", mode: "story" });
      await finished(0, "the plan turn");
      expect(refusals).toEqual([]);
      expect(chats.get(chat.id)?.turns[0]).toMatchObject({ status: "completed", mode: "story" });
      expect(seen.plan).toContain('"Welcome"');
      expect(studio.exists(".hyperframes/story/graph.json")).toBe(true);
      // Planning never touches the timeline.
      expect(await studio.read("index.html")).toBe(before);

      // ── The user reshapes the plan by hand: locks "Welcome", sets the duration of "The test" ─────
      const planned = await studio.view();
      const planGraph = planned.graph;
      if (!planGraph) throw new Error("the plan turn wrote no graph");
      const welcome = planGraph.nodes.find(
        (node) => node.kind === "chapter" && node.title === "Welcome",
      );
      const test = planGraph.nodes.find(
        (node) => node.kind === "chapter" && node.title === "The test",
      );
      if (welcome?.kind !== "chapter" || test?.kind !== "chapter")
        throw new Error("chapters missing");
      const edited: StoryGraph = {
        ...planGraph,
        nodes: planGraph.nodes.map((node) =>
          node.id === welcome.id
            ? { ...node, locked: true }
            : node.id === test.id && node.kind === "chapter"
              ? { ...node, estimatedDuration: 8 }
              : node,
        ),
      };
      await studio.save(edited, planned.version);
      const userView = await studio.view();
      const userTest = userView.graph?.nodes.find((node) => node.id === test.id);
      // Authorship is recorded by the service, not the client.
      expect(userTest?.userEdited).toContain("estimatedDuration");

      // ── Turn 2: review (story action) — locks and user decisions hold ───────────────────────────
      refusals.length = 0;
      script = async (text, call) => {
        seen.reviewPrompt = text;
        seen.readForReview = await call("read_story", {});
        await call("edit_story", {
          operations: [{ op: "update_node", id: welcome.id, set: { description: "AI rewrite" } }],
        });
        await call("edit_story", {
          operations: [{ op: "update_node", id: test.id, set: { estimatedDuration: 20 } }],
        });
        seen.allowed = await call("edit_story", {
          operations: [
            { op: "update_node", id: test.id, set: { description: "The clap test, tightened" } },
            { op: "set_story", reviewSummary: "Kept the user's 8 s for The test." },
          ],
        });
      };
      const review = await runner.start(chat.id, {
        prompt: "Review the story",
        storyAction: "review",
      });
      await finished(1, "the review turn");
      expect(chats.get(chat.id)?.turns[1]).toMatchObject({ mode: "story", storyAction: "review" });
      expect(seen.reviewPrompt).toContain("LOCKED");
      expect(seen.reviewPrompt).toContain("estimatedDuration");
      expect(refusals.map((entry) => entry.split(":")[1]?.trim().split(" ")[0])).toEqual([
        "locked",
        "user_decision",
      ]);
      expect(seen.allowed).toContain("Applied 2 operations");
      const reviewed = (await studio.view()).graph;
      expect(reviewed?.nodes.find((node) => node.id === test.id)).toMatchObject({
        estimatedDuration: 8,
        description: "The clap test, tightened",
      });
      expect(reviewed?.nodes.find((node) => node.id === welcome.id)).toMatchObject({
        description: "",
      });
      expect(reviewed?.review?.summary).toBe("Kept the user's 8 s for The test.");

      // Revert the review: the graph file is what the user left.
      expect((await runner.revert(chat.id, review.id)).ok).toBe(true);
      const afterRevert = await studio.view();
      expect(afterRevert.version).toBe(userView.version);
      expect(afterRevert.graph?.review).toBeNull();

      // ── Turn 3: build (story action) — one atomic, revertible timeline edit with provenance ─────
      script = async (_text, call) => {
        seen.build = await call("build_story", {});
      };
      const build = await runner.start(chat.id, {
        prompt: "Build the story",
        storyAction: "build",
      });
      await finished(2, "the build turn");
      expect(chats.get(chat.id)?.turns[2]).toMatchObject({
        status: "completed",
        storyAction: "build",
      });
      expect(refusals.filter((entry) => entry.startsWith("build_story"))).toEqual([]);
      expect(seen.build).toContain("Built the story on index.html");
      expect(seen.build).toContain('"Welcome"');

      const built = await studio.read("index.html");
      expect(built).not.toBe(before);
      expect(built).toContain(`data-ov-story-node="${welcome.id}"`);
      expect(built).toContain(`data-ov-story-node="${test.id}"`);
      expect(built).toContain(`data-ov-turn="${build.id}"`);
      const builtView = await studio.view();
      expect(builtView.facts[welcome.id]?.timeline).toMatchObject({ start: 0 });
      expect(builtView.graph?.build?.turnId).toBe(build.id);
      expect(chats.get(chat.id)?.turns[2]?.checkpoint?.status).toBe("ready");

      // Revert the build: the composition is byte for byte what it was, and nothing is shown as built.
      expect((await runner.revert(chat.id, build.id)).ok).toBe(true);
      expect(await studio.read("index.html")).toBe(before);
      const unbuilt = await studio.view();
      expect(unbuilt.graph?.build ?? null).toBeNull();
      expect(unbuilt.facts[welcome.id]?.timeline ?? null).toBeNull();
      // The user's own decisions survived the AI turns and their reverts.
      expect(unbuilt.graph?.nodes.find((node) => node.id === welcome.id)?.locked).toBe(true);
      expect(parseStoryGraph(unbuilt.graph).ok).toBe(true);
    }, 120_000);
  },
);
