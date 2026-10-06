import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectScope } from "../checkpointHost.js";
import { ChatService } from "../chats.js";
import { AgentSettingsStore } from "../settings.js";
import { UsageJournal } from "../usage/journal.js";
import { FileChatStore } from "../store/index.js";
import { TurnRunner, type TurnRunnerOptions } from "../turns.js";
import { FakeCheckpointHost } from "./index.js";
import { FakeAnalysisHost } from "./analysis.js";
import { FakeFramesHost } from "./frames.js";
import { FakeEditingHost } from "./editing.js";
import { FakeStoryHost } from "./story.js";
import { FakeDesignHost } from "./design.js";
import { FakeResearchHost } from "./research.js";
import { FakeCrossProjectHost } from "./crossProject.js";
import { FakeQaHost } from "./qa.js";
import { ScriptedAgentBackend } from "./backend.js";

export interface RuntimeFixture {
  root: string;
  scope: ProjectScope;
  store: FileChatStore;
  settings: AgentSettingsStore;
  chats: ChatService;
  usage: UsageJournal;
  turns: TurnRunner;
  backend: ScriptedAgentBackend;
  checkpoints: FakeCheckpointHost;
  editing: FakeEditingHost;
  analysis: FakeAnalysisHost;
  frames: FakeFramesHost;
  story: FakeStoryHost;
  design: FakeDesignHost;
  research: FakeResearchHost;
  crossProject: FakeCrossProjectHost;
  qa: FakeQaHost;
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
  const settings = new AgentSettingsStore(join(root, "settings"));
  const backend = new ScriptedAgentBackend();
  const checkpoints = new FakeCheckpointHost(now);
  const editing = new FakeEditingHost();
  const analysis = new FakeAnalysisHost();
  const frames = new FakeFramesHost();
  const story = new FakeStoryHost();
  const design = new FakeDesignHost();
  const research = new FakeResearchHost();
  const crossProject = new FakeCrossProjectHost();
  const qa = new FakeQaHost();
  const usage = new UsageJournal(projectDir, store);
  const chats = await ChatService.open(scope, store, {
    now,
    ids,
    onTurnEnded: (state, turnId) => usage.recordTurn(state, turnId),
  });
  const turns = new TurnRunner(chats, backend, checkpoints, store, settings, {
    editing: () => editing,
    analysis: () => analysis,
    crossProject: () => crossProject,
    frames: () => frames,
    story: () => story,
    design: () => design,
    research: () => research,
    qa: () => qa,
    analysisPollMs: 1,
    ...options,
    now,
    ids,
  });
  return {
    root,
    scope,
    store,
    settings,
    chats,
    usage,
    turns,
    backend,
    checkpoints,
    editing,
    analysis,
    frames,
    story,
    design,
    research,
    crossProject,
    qa,
    now,
    setNow: (value) => {
      timestamp = value;
    },
    cleanup: async () => {
      await turns.dispose();
      await backend.dispose();
      // `turns.dispose()` already drains, but belt and suspenders: the directory must only go once no store write
      // is still in flight (Windows fails the removal, or the write, when they overlap).
      await chats.drain();
      await usage.drain();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Default patience of {@link waitUntil}: generous for a slow disk or a loaded CI runner, free when the test passes. */
const WAIT_TIMEOUT_MS = 10_000;

/** Polls `predicate` until it holds or `timeoutMs` of wall-clock time have passed (not a count of event-loop turns). */
export async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs: number = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
