import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_HEADERS, isRecord } from "@hyperframes/agent-protocol";
import { createRuntimeApp, type RuntimeApp } from "./server.js";
import { AgentSettingsStore } from "./settings.js";
import {
  FakeAnalysisHost,
  FakeCheckpointHost,
  FakeEditingHost,
  FakeQaHost,
  FakeResearchHost,
  FakeStoryHost,
} from "./testing/index.js";
import { ScriptedAgentBackend } from "./testing/backend.js";

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

interface Harness {
  app: RuntimeApp;
  backend: ScriptedAgentBackend;
  projectDir: string;
  headers: Record<string, string>;
  call: (method: string, path: string, body?: unknown) => Promise<Reply>;
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "openvids-agent-chats-"));
  const projectDir = join(root, "project");
  await mkdir(projectDir);
  const backend = new ScriptedAgentBackend();
  const app = createRuntimeApp({
    backend,
    checkpoints: new FakeCheckpointHost(),
    editing: () => new FakeEditingHost(),
    analysis: () => new FakeAnalysisHost(),
    story: () => new FakeStoryHost(),
    research: () => new FakeResearchHost(),
    qa: () => new FakeQaHost(),
    settings: new AgentSettingsStore(join(root, "settings")),
    token: "secret",
  });
  const headers = {
    [AGENT_HEADERS.token]: "Bearer secret",
    [AGENT_HEADERS.projectId]: "project-one",
    [AGENT_HEADERS.projectDir]: projectDir,
    [AGENT_HEADERS.studioOrigin]: "http://127.0.0.1:4173",
  };
  return {
    app,
    backend,
    projectDir,
    headers,
    call: async (method, path, body) => {
      const response = await app.request(`/v1${path}`, {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const payload: unknown = await response.json();
      return { status: response.status, body: isRecord(payload) ? payload : {} };
    },
    cleanup: async () => {
      await app.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Polls an async condition (the app has no synchronous view of its chats). */
async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

async function turnEnded(h: Harness, chatId: string): Promise<boolean> {
  const turns = (await h.call("GET", `/chats/${chatId}`)).body.turns;
  const last = Array.isArray(turns) ? turns.at(-1) : null;
  return isRecord(last) && last.status !== "running";
}

describe("DELETE /chats/:chatId", () => {
  it("removes the chat and its stored files, and says so to the project", async () => {
    const h = await harness();
    try {
      const chatId = String((await h.call("POST", "/chats", {})).body.id);
      const chatDir = join(h.projectDir, ".hyperframes", "agent", "chats", chatId);
      expect(await exists(chatDir)).toBe(true);

      const stream = await h.app.request("/v1/events", { headers: h.headers });
      const reader = stream.body?.getReader();
      let received = "";
      const reading = (async () => {
        const decoder = new TextDecoder();
        while (reader) {
          const chunk = await reader.read();
          if (chunk.done) return;
          received += decoder.decode(chunk.value);
        }
      })();

      expect(await h.call("DELETE", `/chats/${chatId}`)).toMatchObject({
        status: 200,
        body: { chatId },
      });
      await eventually(async () => received.includes("chat.deleted"), "the chat.deleted event");
      expect(received).toContain(chatId);
      await reader?.cancel();
      await reading;

      expect((await h.call("GET", `/chats/${chatId}`)).status).toBe(404);
      expect((await h.call("GET", "/chats")).body.chats).toEqual([]);
      expect(await exists(chatDir)).toBe(false);
      expect((await h.call("DELETE", `/chats/${chatId}`)).status).toBe(404);
    } finally {
      await h.cleanup();
    }
  });

  it("refuses while the chat runs a turn, and works once it ended", async () => {
    const h = await harness();
    try {
      const gate = Promise.withResolvers<void>();
      const insidePrompt = Promise.withResolvers<void>();
      h.backend.promptScript = async () => {
        insidePrompt.resolve();
        await gate.promise;
        return "completed";
      };
      const chatId = String((await h.call("POST", "/chats", {})).body.id);
      await h.call("POST", `/chats/${chatId}/turns`, { prompt: "Tighten the intro" });
      await insidePrompt.promise;
      const busy = await h.call("DELETE", `/chats/${chatId}`);
      expect(busy.status).toBe(409);
      expect(busy.body.error).toMatchObject({ code: "chat_busy" });

      gate.resolve();
      await eventually(() => turnEnded(h, chatId), "the turn to end");
      expect((await h.call("DELETE", `/chats/${chatId}`)).status).toBe(200);
    } finally {
      await h.cleanup();
    }
  });
});

describe("linked sites", () => {
  it("lists the sites the user linked, and keeps the ones they removed out of it for good", async () => {
    const h = await harness();
    try {
      h.backend.promptScript = async () => "completed";
      const chatId = String((await h.call("POST", "/chats", {})).body.id);
      await h.call("POST", `/chats/${chatId}/turns`, {
        prompt: "Use the colours of https://linear.app/docs and the mood of https://vercel.com",
      });
      await eventually(() => turnEnded(h, chatId), "the first turn");
      const chat = (await h.call("GET", `/chats/${chatId}`)).body.chat;
      expect(isRecord(chat) && chat.linkedSites).toEqual(["linear.app", "vercel.com"]);

      const patched = await h.call("PATCH", `/chats/${chatId}`, { excludedSites: ["Linear.app"] });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        linkedSites: ["vercel.com"],
        excludedSites: ["linear.app"],
      });

      // Mentioning the removed site again does not bring it back.
      await h.call("POST", `/chats/${chatId}/turns`, {
        prompt: "Also https://linear.app/pricing looks right",
      });
      await eventually(() => turnEnded(h, chatId), "the second turn");
      const again = (await h.call("GET", `/chats/${chatId}`)).body.chat;
      expect(isRecord(again) && again.linkedSites).toEqual(["vercel.com"]);
      expect(isRecord(again) && again.excludedSites).toEqual(["linear.app"]);

      const cleared = await h.call("PATCH", `/chats/${chatId}`, { excludedSites: [] });
      expect(cleared.body).toMatchObject({ linkedSites: ["linear.app", "vercel.com"] });
      expect(cleared.body.excludedSites).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });
});

describe("run cancel and question routes", () => {
  it("stops one delegated run on request and keeps the turn going", async () => {
    const h = await harness();
    try {
      const chatId = String((await h.call("POST", "/chats", {})).body.id);
      await h.call("PATCH", `/chats/${chatId}`, { enabledAgents: ["editor"] });
      const runStarted = Promise.withResolvers<void>();
      const releaseDirector = Promise.withResolvers<void>();
      h.backend.promptScript = async (input, session) => {
        if (session.input.agent === "editor") {
          const aborted = Promise.withResolvers<void>();
          input.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          runStarted.resolve();
          await aborted.promise;
          return "aborted";
        }
        if (!input.text.includes("Tighten")) return "completed";
        await session.callTool("delegate", { agent: "editor", title: "Cut", task: "cut it" });
        await releaseDirector.promise;
        await session.callTool("wait_for_agents", {});
        return "completed";
      };
      const started = await h.call("POST", `/chats/${chatId}/turns`, {
        prompt: "Tighten the intro",
      });
      const turn = started.body.turn;
      const turnId = isRecord(turn) ? String(turn.id) : "";
      await runStarted.promise;
      const runs = (await h.call("GET", `/chats/${chatId}`)).body.runs;
      const runId = Array.isArray(runs) && isRecord(runs[0]) ? String(runs[0].id) : "";

      const missing = await h.call("POST", `/chats/${chatId}/turns/${turnId}/runs/nope/cancel`, {});
      expect(missing.status).toBe(409);
      expect(missing.body.error).toMatchObject({ code: "turn_not_active" });
      const cancelled = await h.call(
        "POST",
        `/chats/${chatId}/turns/${turnId}/runs/${runId}/cancel`,
        {
          reason: "not needed",
        },
      );
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.run).toMatchObject({ id: runId, status: "cancelled" });

      releaseDirector.resolve();
      await eventually(() => turnEnded(h, chatId), "the turn to end");
      const last = (await h.call("GET", `/chats/${chatId}`)).body.turns;
      expect(Array.isArray(last) && isRecord(last.at(-1)) && last.at(-1).status).toBe("completed");
      // The turn is over: cancelling again is refused.
      const late = await h.call(
        "POST",
        `/chats/${chatId}/turns/${turnId}/runs/${runId}/cancel`,
        {},
      );
      expect(late.status).toBe(409);
    } finally {
      await h.cleanup();
    }
  });

  it("refuses an answer for a question of a turn that is not running, and a malformed one", async () => {
    const h = await harness();
    try {
      h.backend.promptScript = async () => "completed";
      const chatId = String((await h.call("POST", "/chats", {})).body.id);
      const started = await h.call("POST", `/chats/${chatId}/turns`, {
        prompt: "Tighten the intro",
      });
      const turn = started.body.turn;
      const turnId = isRecord(turn) ? String(turn.id) : "";
      await eventually(() => turnEnded(h, chatId), "the turn to end");
      const stale = await h.call("POST", `/chats/${chatId}/turns/${turnId}/questions/q1`, {
        answer: "yes",
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatchObject({ code: "turn_not_active" });
      const malformed = await h.call("POST", `/chats/${chatId}/turns/${turnId}/questions/q1`, {});
      expect(malformed.status).toBe(400);
      const unknownTurn = await h.call("POST", `/chats/${chatId}/turns/none/questions/q1`, {
        answer: "yes",
      });
      expect(unknownTurn.status).toBe(404);
    } finally {
      await h.cleanup();
    }
  });
});

describe("GET /usage", () => {
  it("reports what the project's agents used, keeps it when the chat is deleted, and rejects a bad period", async () => {
    const h = await harness();
    try {
      h.backend.promptScript = async (input) => {
        input.onEvent({
          type: "usage",
          usage: {
            input: 80,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 100,
            cost: 0.25,
          },
        });
        return "completed";
      };
      const chatId = String((await h.call("POST", "/chats", {})).body.id);
      await h.call("POST", `/chats/${chatId}/turns`, { prompt: "Tighten the intro" });
      await eventually(() => turnEnded(h, chatId), "the turn to end");

      const first = await h.call("GET", "/usage");
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        live: false,
        total: { usage: { totalTokens: 100, cost: 0.25 }, unpricedTokens: 0 },
        byAgent: [{ agent: "director", internal: false }],
        byChat: [{ chatId, deleted: false }],
      });

      await h.call("DELETE", `/chats/${chatId}`);
      const after = await h.call("GET", "/usage");
      expect(after.body.total).toEqual(first.body.total);
      expect(after.body.byChat).toMatchObject([{ chatId, deleted: true }]);

      const future = await h.call("GET", `/usage?since=${Date.now() + 60_000}`);
      expect(future.body.total).toMatchObject({ usage: { totalTokens: 0, cost: null } });
      expect((await h.call("GET", "/usage?since=soon")).status).toBe(400);
    } finally {
      await h.cleanup();
    }
  });
});
