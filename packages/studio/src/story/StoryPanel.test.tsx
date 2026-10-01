// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentStore, type AgentStore } from "../agent/agentStore";
import {
  ACTIVE,
  chatState,
  createFakeClient,
  createSourceLog,
  summary,
  turn,
  type FakeClient,
} from "../agent/agentTestHarness";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { cleanupMounted, mountHost } from "../components/ui/mountHost.testHelpers";
import { StoryProvider } from "./storyContext";
import { removeItems } from "./storyGraphOps";
import { StoryPanel } from "./StoryPanel";
import { createStoryStore, type StoryStore } from "./storyStore";
import type { StoryGraph, StoryManualEdit, StorySyncReport } from "@hyperframes/agent-protocol";
import { usePlayerStore } from "../player/store/playerStore";
import {
  createFakeStoryServer,
  sampleGraph,
  settle,
  syncReport,
  type FakeStoryServer,
} from "./storyTestHarness";

let server: FakeStoryServer;
let story: StoryStore;
let agent: AgentStore;
let agentClient: FakeClient;
let host: HTMLElement;

async function mount({
  chatOpen = true,
  graph = sampleGraph(),
  sync = null,
}: { chatOpen?: boolean; graph?: StoryGraph; sync?: StorySyncReport | null } = {}) {
  server = createFakeStoryServer(graph);
  server.state.sync = sync;
  story = createStoryStore({ client: server.client, saveDelayMs: 400 });
  agentClient = createFakeClient({ chat: chatState() });
  agent = createAgentStore({ client: agentClient, openEventSource: createSourceLog().open });
  agent.setState({
    availability: "ready",
    ...(chatOpen
      ? { view: "chat" as const, chatId: "c1", chat: chatState(), streamStatus: "open" as const }
      : {}),
  });
  await act(async () => {
    host = mountHost(
      <StoryProvider store={story} client={server.client}>
        <StoryPanel projectId="p1" agentStore={agent} />
      </StoryProvider>,
    );
  });
  await act(async () => settle());
}

const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  ) ?? null;

async function click(element: Element | null) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
  });
}

async function pressOnPanel(key: string) {
  const root = host.querySelector<HTMLElement>("[data-studio-story]");
  if (!root) throw new Error("no story panel");
  await act(async () => {
    root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  // happy-dom has no layout; React Flow measures its pane and nodes.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(900);
});

afterEach(() => {
  cleanupMounted();
  story.getState().dispose();
  agent.getState().dispose();
  useDockLayoutStore.setState({ pendingActivation: null });
  vi.restoreAllMocks();
});

describe("Review with AI / Build Story", () => {
  it("saves pending edits, then starts a story-mode review turn in the open chat and brings Chat forward", async () => {
    await mount();
    let savesWhenTurnStarted = -1;
    agentClient.startTurn.mockImplementation(async () => {
      savesWhenTurnStarted = server.saves.length;
      return { turn: turn() };
    });
    act(() => {
      story.getState().commit((graph) => ({ ...graph, title: "Edited before review" }));
    });

    await click(button("Review with AI"));

    expect(agentClient.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ prompt: "Review the story", mode: "story", storyAction: "review" }),
    );
    expect(savesWhenTurnStarted).toBe(1);
    expect(useDockLayoutStore.getState().pendingActivation).toBe("chat");
  });

  it("Build Story with no chat open creates one and runs the build there", async () => {
    await mount({ chatOpen: false });
    agentClient.createChat.mockResolvedValue(summary({ id: "new" }));

    await click(button("Build Story"));

    expect(agentClient.createChat).toHaveBeenCalledTimes(1);
    expect(agentClient.startTurn).toHaveBeenCalledWith(
      "new",
      expect.objectContaining({ prompt: "Build the story", mode: "story", storyAction: "build" }),
    );
  });

  it("cannot build a story without chapters", async () => {
    const graph = sampleGraph();
    await mount({
      graph: {
        ...graph,
        nodes: graph.nodes.filter((node) => node.kind !== "chapter"),
        edges: [],
        attachments: [],
      },
    });
    expect(button("Build Story")?.disabled).toBe(true);
    expect(button("Review with AI")?.disabled).toBe(true);
  });
});

describe("while an agent turn runs", () => {
  it("is read-only with a banner, and reloads the story when the turn ends", async () => {
    await mount();
    await act(async () => {
      agent.setState({ activeTurn: ACTIVE });
    });
    expect(host.textContent).toContain("AI is working on the story");
    expect(button("Add node")?.disabled).toBe(true);
    expect(button("Review with AI")?.disabled).toBe(true);
    expect(button("Build Story")?.disabled).toBe(true);

    act(() => story.getState().select({ nodes: ["b"], edges: [] }));
    await pressOnPanel("Delete");
    expect(story.getState().graph?.nodes.some((node) => node.id === "b")).toBe(true);

    // The agent rewrote the story during its turn; the canvas picks that up once it ends.
    server.writeElsewhere(removeItems(sampleGraph(), ["c"]));
    await act(async () => {
      agent.setState({ activeTurn: null });
      await settle();
    });
    expect(host.textContent).not.toContain("AI is working on the story");
    expect(story.getState().graph?.nodes.some((node) => node.id === "c")).toBe(false);
  });
});

describe("editing on the canvas", () => {
  it("Delete removes the selected chapter together with its sequence edges and attachments", async () => {
    await mount();
    act(() => story.getState().select({ nodes: ["b"], edges: [] }));
    await pressOnPanel("Delete");
    const graph = story.getState().graph;
    expect(graph?.nodes.map((node) => node.id)).toEqual(["a", "c", "v"]);
    expect(graph?.edges).toEqual([]);
    expect(graph?.attachments).toEqual([]);

    await click(button("Undo story edit"));
    expect(story.getState().graph?.edges).toHaveLength(2);
  });

  it("the inspector edits the selected chapter and marks nothing locally as authored", async () => {
    await mount();
    act(() => story.getState().select({ nodes: ["a"], edges: [] }));
    const title = host.querySelector<HTMLInputElement>('input[aria-label="Title"]');
    if (!title) throw new Error("no title field");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(title, "The hook");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      title.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    const chapter = story.getState().graph?.nodes.find((node) => node.id === "a");
    expect(chapter?.title).toBe("The hook");
    // Authorship is the server's to record from the diff.
    expect(chapter?.userEdited).toEqual([]);
  });
});

function edit(clip: string, by: StoryManualEdit["by"]): StoryManualEdit {
  return {
    clip,
    label: `Clip ${clip}`,
    kind: "modified",
    by,
    turn: by === "ai" ? "t1" : null,
    fields: ["start"],
  };
}

/**
 * After a build: `a` is untouched but its A-roll was trimmed by hand, `b` changed in the graph while holding an
 * AI and a user edit (the conflict), its B-roll `v` changed, and the locked `c` changed too (pending permission).
 */
function outOfSync(): StorySyncReport {
  return syncReport({
    state: "out_of_sync",
    sections: [
      {
        chapter: "a",
        title: "Chapter a",
        change: "unchanged",
        moved: false,
        locked: false,
        reasons: [],
        current: { start: 0, end: 10 },
        next: { start: 0, end: 10 },
        units: [
          {
            node: "a",
            role: "a_roll",
            title: "Chapter a",
            change: "unchanged",
            reasons: [],
            action: "keep",
            clips: 1,
            edits: [edit("a1", "user")],
          },
        ],
      },
      {
        chapter: "b",
        title: "Chapter b",
        change: "changed",
        moved: false,
        locked: false,
        reasons: ["source ranges changed"],
        current: { start: 10, end: 20 },
        next: { start: 10, end: 24 },
        units: [
          {
            node: "b",
            role: "a_roll",
            title: "Chapter b",
            change: "changed",
            reasons: ["source ranges changed"],
            action: "keep_edited",
            clips: 2,
            edits: [edit("b1", "ai"), edit("b2", "user")],
          },
          {
            node: "v",
            role: "b_roll",
            title: "B-roll",
            change: "changed",
            reasons: ["placement start → end"],
            action: "rebuild",
            clips: 1,
            edits: [],
          },
        ],
      },
      {
        chapter: "c",
        title: "Chapter c",
        change: "changed",
        moved: true,
        locked: true,
        reasons: ["duration changed"],
        current: { start: 20, end: 30 },
        next: { start: 24, end: 34 },
        units: [
          {
            node: "c",
            role: "a_roll",
            title: "Chapter c",
            change: "changed",
            reasons: ["duration changed"],
            action: "keep_locked",
            clips: 1,
            edits: [],
          },
        ],
      },
    ],
    affected: ["b"],
    moved: ["c"],
    lockedPending: ["c"],
    manualEdits: 3,
    conflicts: 1,
    duration: { current: 30, next: 34 },
  });
}

const rebuildButton = () =>
  host.querySelector<HTMLButtonElement>('button[data-story-action="rebuild"]');
const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]');
const badgesOf = (node: string) =>
  [...host.querySelectorAll(`[data-story-node="${node}"] [data-sync-badge]`)].map((badge) =>
    badge.getAttribute("data-sync-badge"),
  );

/** A radio or checkbox in the open dialog, by the text of its label. */
function choice(label: string): HTMLInputElement {
  const row = [...(dialog()?.querySelectorAll("label") ?? [])].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  const input = row?.querySelector("input");
  if (!input) throw new Error(`no choice "${label}"`);
  return input;
}

async function tick(input: HTMLInputElement) {
  await act(async () => {
    input.click();
    await settle();
  });
}

function startedTurn() {
  const call = agentClient.startTurn.mock.calls.at(-1);
  if (!call) throw new Error("no turn started");
  return call[1];
}

describe("Story ↔ timeline sync", () => {
  it("badges each card from the report, and nothing on cards that are in sync", async () => {
    await mount({ sync: outOfSync() });
    expect(badgesOf("a")).toEqual(["edited"]);
    expect(badgesOf("b")).toEqual(["changed", "edited"]);
    expect(badgesOf("c")).toEqual(["locked"]);
    expect(badgesOf("v")).toEqual(["changed"]);
    expect(
      host.querySelector('[data-story-node="b"] [data-sync-badge="edited"]')?.getAttribute("title"),
    ).toContain("1 by you · 1 by AI");

    await act(async () => {
      server.state.sync = syncReport({ state: "in_sync" });
      await story.getState().reload();
    });
    expect(host.querySelectorAll("[data-sync-badge]")).toHaveLength(0);
  });

  it("Rebuild affected runs only when the timeline is out of sync and the agent is free", async () => {
    const remount = async (sync: StorySyncReport) => {
      cleanupMounted();
      story.getState().dispose();
      agent.getState().dispose();
      await mount({ sync });
    };
    await mount({ sync: syncReport({ state: "not_built" }) });
    expect(rebuildButton()?.disabled).toBe(true);
    for (const state of ["untracked", "in_sync"] as const) {
      await remount(syncReport({ state }));
      expect(rebuildButton()?.disabled).toBe(true);
    }
    await remount(outOfSync());
    expect(rebuildButton()?.disabled).toBe(false);
    // `b` regenerates and `c` moves: two sections.
    expect(rebuildButton()?.textContent).toContain("2");

    await act(async () => agent.setState({ activeTurn: ACTIVE }));
    expect(rebuildButton()?.disabled).toBe(true);
  });

  it("the impact dialog passes the chosen edit policy and locked permission to the rebuild turn", async () => {
    await mount({ sync: outOfSync() });
    await click(rebuildButton());
    expect(dialog()).not.toBeNull();
    expect(choice("Keep my edits").checked).toBe(true);
    expect(choice("Allow rebuilding “Chapter c”").checked).toBe(false);
    expect(agentClient.startTurn).not.toHaveBeenCalled();

    await tick(choice("Replace my edits"));
    // Both edits of b's A-roll are about to go: the dialog names them.
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("Clip b1");
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("Clip b2");
    expect(
      dialog()
        ?.querySelector('[data-sync-section="b"] [data-unit-action]')
        ?.getAttribute("data-unit-action"),
    ).toBe("rebuild");
    await tick(choice("Allow rebuilding “Chapter c”"));
    await click(button("Rebuild 2 sections"));

    expect(startedTurn()).toMatchObject({
      prompt: "Rebuild the affected story sections",
      mode: "story",
      storyAction: "rebuild",
      storyOptions: { manualEdits: "replace", allowLocked: ["c"] },
    });
    expect(startedTurn().storyOptions).not.toHaveProperty("chapters");
    expect(dialog()).toBeNull();
  });

  it("Rebuild this section in the chapter inspector narrows the rebuild to that chapter", async () => {
    await mount({ sync: outOfSync() });
    act(() => story.getState().select({ nodes: ["b"], edges: [] }));
    await click(button("Rebuild this section"));
    expect(dialog()?.querySelectorAll("[data-sync-section]")).toHaveLength(1);
    // c is locked and outside this rebuild: nothing to allow.
    expect(() => choice("Allow rebuilding")).toThrow();

    await click(button("Rebuild 1 section"));
    expect(startedTurn()).toMatchObject({
      storyAction: "rebuild",
      storyOptions: { manualEdits: "keep", chapters: ["b"] },
    });
    expect(startedTurn().storyOptions).not.toHaveProperty("allowLocked");
  });

  it("a full build over manual edits and locked sections asks first, and passes the allowed locked chapters", async () => {
    await mount({ sync: outOfSync() });
    await click(button("Build Story"));
    expect(dialog()).not.toBeNull();
    expect(agentClient.startTurn).not.toHaveBeenCalled();

    await tick(choice("Rebuild “Chapter c” too"));
    await click(button("Build everything"));
    expect(startedTurn()).toMatchObject({
      storyAction: "build",
      storyOptions: { allowLocked: ["c"] },
    });
  });

  it("a full build without manual edits or locked sections starts right away, with no options", async () => {
    await mount({ sync: syncReport({ state: "out_of_sync", affected: ["b"] }) });
    await click(button("Build Story"));
    expect(dialog()).toBeNull();
    expect(startedTurn()).toMatchObject({ storyAction: "build" });
    expect(startedTurn()).not.toHaveProperty("storyOptions");
  });

  it("reloads the report when the story's composition is saved", async () => {
    await mount({ sync: syncReport({ state: "in_sync" }) });
    const loads = server.client.load.mock.calls.length;
    server.state.sync = outOfSync();
    await act(async () => {
      usePlayerStore.getState().bumpThumbnailRevisions(["index.html"]);
      // Past the reload's debounce.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 300);
      await promise;
      await settle();
    });
    expect(server.client.load.mock.calls.length).toBe(loads + 1);
    expect(badgesOf("b")).toEqual(["changed", "edited"]);
  });
});
