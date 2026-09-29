// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendPromptOutcome } from "./backend.js";
import { ChatService } from "./chats.js";
import { HttpCheckpointHost } from "./checkpointHost.http.js";
import type { ProjectScope } from "./checkpointHost.js";
import { AgentSettingsStore } from "./settings.js";
import { FileChatStore } from "./store/index.js";
import { ScriptedAgentBackend } from "./testing/backend.js";
import { HeartbeatClock, RENEW_MS } from "./testing/heartbeatClock.js";
import { waitUntil } from "./testing/runtimeFixture.js";
import { TurnRunner } from "./turns.js";

const GAP_MS = 11 * 60_000;
const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Studio's real project history and history routes on loopback, driven by the runtime's real HTTP checkpoint host. */
async function studioWithProject() {
  const root = await mkdtemp(join(tmpdir(), "openvids-checkpoint-lifetime-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  await mkdir(projectDir);
  await writeFile(join(projectDir, "a.html"), "A0");
  await writeFile(join(projectDir, "b.html"), "B0");
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
  const { port } = address;
  const scope: ProjectScope = {
    projectId: "demo",
    projectDir,
    studioOrigin: `http://127.0.0.1:${port}`,
  };
  /** Writes like the Director's edit tool, dated `at` (the history engine dates a write by its mtime). */
  const writeAt = async (path: string, content: string, at: number) => {
    await writeFile(join(projectDir, path), content);
    await utimes(join(projectDir, path), at / 1000, at / 1000);
  };
  const read = (path: string) => readFile(join(projectDir, path), "utf-8");
  return { scope, history, writeAt, read };
}

/**
 * A real turn that writes a.html, pauses 11 minutes (longer than Studio's 10-minute window idle cap and 5x the
 * transaction lease), writes b.html and completes. The clock is moved by hand; `heartbeats` models the runtime alive.
 */
async function turnAcrossLongPause(heartbeats: boolean) {
  const studio = await studioWithProject();
  const t0 = Date.now() + 86_400_000; // ahead of real time, so no real ctime outdates the faked mtimes
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t0);

  const store = new FileChatStore(studio.scope.projectDir);
  const chats = await ChatService.open(studio.scope, store);
  const backend = new ScriptedAgentBackend();
  const clock = new HeartbeatClock();
  const settings = new AgentSettingsStore(join(studio.scope.projectDir, "..", "settings"));
  const runner = new TurnRunner(chats, backend, new HttpCheckpointHost(), store, settings, {
    timers: clock,
    renewIntervalMs: RENEW_MS,
  });
  cleanup.push(() => runner.dispose());

  const firstWriteDone = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  backend.promptScript = async (): Promise<BackendPromptOutcome> => {
    await studio.writeAt("a.html", "A1", t0 + 1_000);
    firstWriteDone.resolve();
    await resume.promise;
    await studio.writeAt("b.html", "B1", t0 + GAP_MS);
    return "completed";
  };

  const chat = await chats.create({});
  const turn = await runner.start(chat.id, { prompt: "Tighten the intro" });
  await firstWriteDone.promise;
  for (let at = t0 + RENEW_MS; at <= t0 + GAP_MS; at += RENEW_MS) {
    vi.setSystemTime(at);
    if (heartbeats) await clock.beat();
  }
  vi.setSystemTime(t0 + GAP_MS + 5_000);
  resume.resolve();
  await waitUntil(
    () => chats.get(chat.id)?.turns[0]?.status === "completed",
    "the turn to complete",
  );
  const checkpoint = chats.get(chat.id)?.turns[0]?.checkpoint;
  return { studio, runner, chat, turnId: turn.id, checkpoint };
}

describe("Revert this turn across a long pause (real history engine + routes + HTTP checkpoint host)", () => {
  it("reverts both writes of a turn whose writes are 11 minutes apart", async () => {
    const { studio, runner, chat, turnId, checkpoint } = await turnAcrossLongPause(true);

    expect(checkpoint).toMatchObject({ status: "ready" });
    const entries = studio.history
      .list()
      .filter((entry) => checkpoint?.entryIds.includes(entry.id));
    expect(entries.flatMap((entry) => entry.files.map((file) => file.path)).sort()).toEqual([
      "a.html",
      "b.html",
    ]);
    expect(entries.every((entry) => entry.who.name === "Director")).toBe(true);

    const reverted = await runner.revert(chat.id, turnId);
    expect(reverted.ok).toBe(true);
    expect([await studio.read("a.html"), await studio.read("b.html")]).toEqual(["A0", "B0"]);
  });

  it("would lose the late write without the heartbeat (the regression this guards against)", async () => {
    const { studio, runner, chat, turnId, checkpoint } = await turnAcrossLongPause(false);

    const entries = studio.history
      .list()
      .filter((entry) => checkpoint?.entryIds.includes(entry.id));
    expect(entries.flatMap((entry) => entry.files.map((file) => file.path))).toEqual(["a.html"]);
    await runner.revert(chat.id, turnId);
    expect([await studio.read("a.html"), await studio.read("b.html")]).toEqual(["A0", "B1"]);
  });
});

describe("Delegated runs share the Director turn's checkpoint (real history engine)", () => {
  async function multiAgentRunner() {
    const studio = await studioWithProject();
    const store = new FileChatStore(studio.scope.projectDir);
    const chats = await ChatService.open(studio.scope, store);
    const backend = new ScriptedAgentBackend();
    const settings = new AgentSettingsStore(join(studio.scope.projectDir, "..", "settings"));
    const runner = new TurnRunner(chats, backend, new HttpCheckpointHost(), store, settings, {
      stopGraceMs: 50,
    });
    cleanup.push(() => runner.dispose());
    const chat = await chats.create({}, ["editor", "vision"]);
    return { studio, chats, backend, runner, chat };
  }

  it("reverts the Director's and every specialist's writes as one turn", async () => {
    const { studio, chats, backend, runner, chat } = await multiAgentRunner();
    backend.promptScript = async (input, session) => {
      const now = Date.now();
      if (session.input.agent === "editor") await studio.writeAt("b.html", "B-editor", now);
      if (session.input.agent === "vision")
        input.onEvent({ type: "text.delta", delta: "Looks fine." });
      if (session.input.agent !== "director") return "completed";
      await studio.writeAt("a.html", "A-director", now);
      await session.callTool("delegate", {
        agent: "editor",
        title: "Edit b",
        task: "Write b.html",
      });
      await session.callTool("delegate", { agent: "vision", title: "Look", task: "Review" });
      await session.callTool("wait_for_agents", {});
      return "completed";
    };
    const turn = await runner.start(chat.id, { prompt: "Rework the scenes" });
    await waitUntil(() => chats.get(chat.id)?.turns[0]?.status === "completed", "the turn");

    const checkpoint = chats.get(chat.id)?.turns[0]?.checkpoint;
    const files = studio.history
      .list()
      .filter((entry) => checkpoint?.entryIds.includes(entry.id))
      .flatMap((entry) => entry.files.map((file) => file.path))
      .sort();
    expect(files).toEqual(["a.html", "b.html"]);

    expect(await runner.revert(chat.id, turn.id)).toMatchObject({ ok: true });
    expect([await studio.read("a.html"), await studio.read("b.html")]).toEqual(["A0", "B0"]);
  });

  it("an aborted turn stops its specialists first, and reverting it undoes their writes", async () => {
    const { studio, chats, backend, runner, chat } = await multiAgentRunner();
    const editorWrote = Promise.withResolvers<void>();
    backend.promptScript = async (input, session) => {
      if (session.input.agent === "editor") {
        await studio.writeAt("b.html", "B-editor", Date.now());
        editorWrote.resolve();
        const stopped = Promise.withResolvers<void>();
        input.signal.addEventListener("abort", () => stopped.resolve(), { once: true });
        await stopped.promise;
        return "aborted";
      }
      await session.callTool("delegate", {
        agent: "editor",
        title: "Edit b",
        task: "Write b.html",
      });
      await session.callTool("wait_for_agents", {}, input.signal);
      return "aborted";
    };
    const turn = await runner.start(chat.id, { prompt: "Rework the scenes" });
    await editorWrote.promise;
    runner.abort(chat.id, turn.id);
    await waitUntil(() => chats.get(chat.id)?.turns[0]?.status === "aborted", "the abort");

    expect(chats.get(chat.id)?.runs.map((run) => run.status)).toEqual(["aborted"]);
    expect(await runner.revert(chat.id, turn.id)).toMatchObject({ ok: true });
    expect(await studio.read("b.html")).toBe("B0");
  });
});
