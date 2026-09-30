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
  type SpeechTranscription,
  type StudioApiAdapter,
} from "@hyperframes/studio-server";
import { afterEach, describe, expect, it } from "vitest";
import { HttpAnalysisHost } from "./analysis/host.http.js";
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

/**
 * 12 s of "talk": a red shot then a blue shot (a hard cut at 6 s), a tone for the speech with a 2.5 s dead-air gap at
 * 4–6.5 s. The recognizer is faked with words that match the tone; everything else (levels, shots, frames, the
 * planner, the editing service, history) is the real code.
 */
async function makeTalk(path: string): Promise<void> {
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x180:d=6:r=25",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:d=6:r=25",
      "-f",
      "lavfi",
      "-i",
      "sine=f=330:d=4:sample_rate=48000",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono:d=2.5",
      "-f",
      "lavfi",
      "-i",
      "sine=f=330:d=5.5:sample_rate=48000",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a][4:a]concat=n=3:v=0:a=1[a]",
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-y",
      path,
    ],
    { stdio: "ignore" },
  );
}

const w = (text: string, start: number, end: number) => ({ text, start, end });

/** "…the first test is… let me start over." is a restart the take analysis removes. */
const WORDS: SpeechTranscription["words"] = [
  w("Welcome", 0.2, 0.6),
  w("to", 0.6, 0.8),
  w("the", 0.8, 1.0),
  w("show.", 1.0, 1.5),
  w("Today", 1.7, 2.0),
  w("we", 2.0, 2.2),
  w("test", 2.2, 2.6),
  w("the", 2.6, 2.8),
  w("room.", 2.8, 3.8),
  w("The", 6.6, 6.8),
  w("first", 6.8, 7.1),
  w("test", 7.1, 7.4),
  w("is", 7.4, 7.6),
  w("sorry,", 7.8, 8.2),
  w("let", 8.2, 8.4),
  w("me", 8.4, 8.5),
  w("start", 8.5, 8.8),
  w("over.", 8.8, 9.2),
  w("The", 9.4, 9.6),
  w("first", 9.6, 9.9),
  w("test", 9.9, 10.2),
  w("is", 10.2, 10.4),
  w("a", 10.4, 10.5),
  w("clap.", 10.5, 11.4),
];

async function studioWithTalk() {
  const root = await mkdtemp(join(tmpdir(), "openvids-analysis-integration-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const projectDir = join(root, "project");
  await mkdir(join(projectDir, "assets"), { recursive: true });
  await writeFile(join(projectDir, "index.html"), COMPOSITION);
  await makeTalk(join(projectDir, SOURCE));
  const history: ProjectHistory = await openProjectHistory({
    projectDir,
    historyRoot: join(root, "history"),
  });
  cleanup.push(() => history.close());
  const recognizer = { calls: 0 };
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
    transcribeMedia: async () => {
      recognizer.calls += 1;
      return { words: WORDS, language: "en", producer: "test recognizer" };
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
  // The user's starting point: the raw recording as one clip, placed before any agent turn.
  const placed = await fetch(`${scope.studioOrigin}/api/projects/demo/editing/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operations: [{ op: "add_clip", asset: SOURCE, start: 0, track: 0 }],
    }),
  });
  if (!placed.ok) throw new Error(`placing the raw clip failed: ${await placed.text()}`);
  return {
    scope,
    root,
    recognizer,
    read: (path: string) => readFile(join(projectDir, path), "utf-8"),
    exists: (path: string) => existsSync(join(projectDir, path)),
  };
}

describe.skipIf(!hasFfmpeg())(
  "long-form pipeline through the real analysis and editing services (cache + checkpoint + revert)",
  () => {
    it("analyzes once, builds the rough cut in one revertible turn, and a second turn reuses the cache", async () => {
      const studio = await studioWithTalk();
      const before = await studio.read("index.html");

      const store = new FileChatStore(studio.scope.projectDir);
      const chats = await ChatService.open(studio.scope, store);
      const backend = new ScriptedAgentBackend();
      const settings = new AgentSettingsStore(join(studio.root, "settings"));
      const runner = new TurnRunner(chats, backend, new HttpCheckpointHost(), store, settings, {
        editing: (scope) => new HttpEditingHost(scope),
        analysis: (scope) => new HttpAnalysisHost(scope),
        analysisPollMs: 20,
      });
      cleanup.push(() => runner.dispose());

      const seen: Record<string, string> = {};
      const fail = (name: string, text: string) => {
        throw new Error(`${name} failed:\n${text}`);
      };
      backend.promptScript = async (input, session) => {
        const call = async (name: string, args: unknown) => {
          const result = await session.callTool(name, args);
          if (result.isError) fail(name, result.text);
          return result;
        };
        const agent = session.input.agent;
        if (agent === "director") {
          seen[input.text.includes("tighter") ? "analyze1" : "analyze2"] = (
            await call("analyze_media", { source: SOURCE })
          ).text;
          if (!input.text.includes("tighter")) return "completed";
          await call("delegate", {
            agent: "vision",
            title: "Check the flagged frames",
            task: `Inspect the vision targets of ${SOURCE}`,
          });
          await call("delegate", {
            agent: "editor",
            title: "Segment",
            task: `Read the transcript of ${SOURCE} and save the semantic segments`,
          });
          await call("wait_for_agents", {});
          await call("delegate", {
            agent: "editor",
            title: "Rough cut",
            task: `Plan the cut of ${SOURCE} and build it`,
          });
          await call("wait_for_agents", {});
          return "completed";
        }
        if (agent === "vision") {
          const frames = await session.callTool("inspect_frames", {
            source: SOURCE,
            times: [1, 8],
          });
          if (frames.isError) fail("inspect_frames", frames.text);
          seen.frames = String(frames.images?.length ?? 0);
          await call("save_vision_notes", {
            source: SOURCE,
            notes: [
              {
                start: 0,
                end: 12,
                frames: [1, 8],
                quality: "good",
                tags: ["speaker_on_camera"],
                finding: "Plain colour shots, nothing broken.",
              },
            ],
          });
          return "completed";
        }
        if (input.text.includes("semantic segments")) {
          const transcript = (await call("read_transcript", { source: SOURCE })).text;
          const version = /version (sha256:[0-9a-f]+)/.exec(transcript)?.[1];
          const ids = [...transcript.matchAll(/^s(\d+) /gm)].map((match) => Number(match[1]));
          if (!version || ids.length === 0) fail("read_transcript", transcript);
          await call("save_segments", {
            source: SOURCE,
            transcriptVersion: version,
            segments: [
              {
                firstSentence: "s1",
                lastSentence: `s${Math.max(...ids)}`,
                title: "Room tests",
                summary: "Welcome and the first room test.",
                role: "main",
                priority: "must",
              },
            ],
          });
          return "completed";
        }
        seen.plan = (await call("plan_cut", { source: SOURCE, label: "rough cut" })).text;
        const plan = /Cut plan (cut-\d+)/.exec(seen.plan)?.[1];
        if (!plan) fail("plan_cut", seen.plan);
        seen.build = (await call("build_rough_cut", { plan })).text;
        return "completed";
      };

      const chat = await chats.create({}, ["editor", "vision"]);
      const turn = await runner.start(chat.id, {
        prompt: "Turn this into a tighter video, remove pauses and bad takes",
      });
      await waitUntil(
        () => {
          const status = chats.get(chat.id)?.turns[0]?.status;
          return status !== undefined && status !== "running";
        },
        "the first turn to finish",
        60_000,
      );
      expect(chats.get(chat.id)?.turns[0]?.status, JSON.stringify(seen, null, 2)).toBe("completed");

      // Analysis: computed once, cached on disk outside the project history.
      expect(seen.analyze1).toMatch(/transcript computed/);
      expect(studio.recognizer.calls).toBe(1);
      expect(seen.frames).toBe("2");

      // The rough cut: the raw clip is replaced by the kept ranges, shorter than the source, dead air and the
      // abandoned attempt removed.
      const cut = await studio.read("index.html");
      expect(cut).not.toBe(before);
      const clips = cut.match(/src="assets\/talk\.mp4"/g)?.length ?? 0;
      expect(clips).toBeGreaterThan(1);
      const length = Number(/ long \(([\d.]+) s\)/.exec(seen.build ?? "")?.[1]);
      expect(length).toBeGreaterThan(5);
      expect(length).toBeLessThan(10);
      const checkpoint = chats.get(chat.id)?.turns[0]?.checkpoint;
      expect(checkpoint?.status).toBe("ready");

      // Revert this turn: the composition is byte for byte what it was; the analysis cache stays.
      const reverted = await runner.revert(chat.id, turn.id);
      expect(reverted.ok).toBe(true);
      expect(await studio.read("index.html")).toBe(before);
      expect(studio.exists(".hyperframes/analysis")).toBe(true);

      // A second turn reuses every stage instead of analysing again.
      await runner.start(chat.id, { prompt: "What is in this recording?" });
      await waitUntil(
        () => {
          const status = chats.get(chat.id)?.turns[1]?.status;
          return status !== undefined && status !== "running";
        },
        "the second turn to finish",
        30_000,
      );
      expect(chats.get(chat.id)?.turns[1]?.status).toBe("completed");
      expect(seen.analyze2).toMatch(/transcript cached/);
      expect(seen.analyze2).not.toMatch(/computed/);
      expect(studio.recognizer.calls).toBe(1);
    }, 90_000);
  },
);
