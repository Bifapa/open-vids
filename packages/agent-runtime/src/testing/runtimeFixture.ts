import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectScope } from "../checkpointHost.js";
import { ChatService } from "../chats.js";
import { FileChatStore } from "../store/index.js";
import { TurnRunner, type TurnRunnerOptions } from "../turns.js";
import { FakeCheckpointHost } from "./index.js";
import { ScriptedAgentBackend } from "./backend.js";

export interface RuntimeFixture {
  root: string;
  scope: ProjectScope;
  store: FileChatStore;
  chats: ChatService;
  turns: TurnRunner;
  backend: ScriptedAgentBackend;
  checkpoints: FakeCheckpointHost;
  now: () => number;
  setNow: (value: number) => void;
  cleanup: () => Promise<void>;
}

export async function createRuntimeFixture(
  options: TurnRunnerOptions = {},
): Promise<RuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), "openvids-agent-runtime-"));
  const projectDir = join(root, "project");
  await mkdir(projectDir);
  let timestamp = 1_700_000_000_000;
  let id = 0;
  const now = () => timestamp++;
  const ids = () => `id-${++id}`;
  const scope: ProjectScope = {
    projectId: "project-one",
    projectDir,
    studioOrigin: "http://127.0.0.1:4173",
  };
  const store = new FileChatStore(projectDir);
  const backend = new ScriptedAgentBackend();
  const checkpoints = new FakeCheckpointHost(now);
  const chats = await ChatService.open(scope, store, { now, ids });
  const turns = new TurnRunner(chats, backend, checkpoints, store, { ...options, now, ids });
  return {
    root,
    scope,
    store,
    chats,
    turns,
    backend,
    checkpoints,
    now,
    setNow: (value) => {
      timestamp = value;
    },
    cleanup: async () => {
      await turns.dispose();
      await backend.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
