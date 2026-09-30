import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoryGraph } from "@hyperframes/agent-protocol";
import { moveNodes, removeItems, replaceNode } from "./storyGraphOps";
import { CONFLICT_NOTICE, createStoryStore, type StoryStore } from "./storyStore";
import {
  createFakeStoryServer,
  sampleGraph,
  settle,
  syncReport,
  type FakeStoryServer,
} from "./storyTestHarness";

let server: FakeStoryServer;
let store: StoryStore;

async function openStore(initial: StoryGraph | null = sampleGraph()) {
  server = createFakeStoryServer(initial);
  store = createStoryStore({ client: server.client, saveDelayMs: 400 });
  await store.getState().open("p1");
}

function retitle(id: string, title: string) {
  return store.getState().commit((graph) => {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    return node ? replaceNode(graph, { ...node, title }) : graph;
  });
}

const titleOf = (graph: StoryGraph | null | undefined, id: string) =>
  graph?.nodes.find((node) => node.id === id)?.title;

async function waitForSave() {
  await vi.advanceTimersByTimeAsync(400);
  await settle();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  store.getState().dispose();
  vi.useRealTimers();
});

describe("debounced save", () => {
  it("saves a burst of edits once, on the version it was made on, then builds on the new version", async () => {
    await openStore();
    retitle("a", "One");
    await vi.advanceTimersByTimeAsync(200);
    retitle("a", "Two");
    store.getState().commit((graph) => moveNodes(graph, new Map([["c", { x: 900, y: 40 }]])));
    await vi.advanceTimersByTimeAsync(399);
    expect(server.saves).toHaveLength(0);
    await waitForSave();

    expect(server.saves).toHaveLength(1);
    expect(server.saves[0].baseVersion).toBe("sha256:0001");
    expect(titleOf(server.saves[0].graph, "a")).toBe("Two");
    expect(store.getState()).toMatchObject({ version: "sha256:0002", saveState: "saved" });

    retitle("b", "Three");
    await waitForSave();
    expect(server.saves[1].baseVersion).toBe("sha256:0002");
  });

  it("creates the story with the first edit when the project has none", async () => {
    await openStore(null);
    expect(store.getState().graph).toBeNull();
    store.getState().commit((graph) => ({ ...graph, title: "Fresh" }));
    await waitForSave();
    expect(server.saves[0]).toMatchObject({ baseVersion: null, graph: { title: "Fresh" } });
    // Nothing before the story existed to undo back to.
    expect(store.getState().past).toEqual([]);
  });

  it("flush sends a pending edit right away", async () => {
    await openStore();
    retitle("a", "Now");
    await expect(store.getState().flush()).resolves.toBe(true);
    expect(server.saves).toHaveLength(1);
  });
});

describe("local undo/redo", () => {
  it("restores graph snapshots and saves every state it lands on", async () => {
    await openStore();
    const original = store.getState().graph;
    retitle("a", "First");
    await waitForSave();
    store.getState().commit((graph) => removeItems(graph, ["b"]));
    await waitForSave();

    expect(store.getState().undo()).toBe(true);
    await waitForSave();
    expect(titleOf(store.getState().graph, "b")).toBe("Chapter b");
    expect(titleOf(server.state.graph, "b")).toBe("Chapter b");
    expect(server.state.graph?.edges).toHaveLength(2);

    expect(store.getState().undo()).toBe(true);
    await waitForSave();
    expect(titleOf(server.state.graph, "a")).toBe(titleOf(original, "a"));
    expect(store.getState().undo()).toBe(false);

    expect(store.getState().redo()).toBe(true);
    await waitForSave();
    expect(titleOf(server.state.graph, "a")).toBe("First");
    expect(server.state.graph?.nodes.some((node) => node.id === "b")).toBe(true);
    expect(server.saves.map((save) => save.baseVersion)).toEqual([
      "sha256:0001",
      "sha256:0002",
      "sha256:0003",
      "sha256:0004",
      "sha256:0005",
    ]);
  });

  it("a new edit after undo drops the redo branch", async () => {
    await openStore();
    retitle("a", "First");
    store.getState().undo();
    retitle("a", "Other");
    expect(store.getState().redo()).toBe(false);
    expect(store.getState().future).toEqual([]);
  });
});

describe("conflicts and agent turns", () => {
  it("a 409 reloads the server's graph, drops the local stacks and says so", async () => {
    await openStore();
    retitle("a", "Mine");
    await waitForSave();
    const theirs = { ...sampleGraph(), title: "Agent's version" };
    server.writeElsewhere(theirs);

    retitle("b", "Also mine");
    await waitForSave();

    const state = store.getState();
    expect(state.graph?.title).toBe("Agent's version");
    expect(state.version).toBe("sha256:0003");
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
    expect(state.notice).toBe(CONFLICT_NOTICE);
    expect(state.saveState).toBe("saved");
  });

  it("is read-only while a turn runs, and sends a pending edit before the agent starts", async () => {
    await openStore();
    retitle("a", "Before the turn");
    store.getState().setAgentBusy(true);
    await settle();
    expect(server.saves).toHaveLength(1);

    const before = store.getState().graph;
    expect(retitle("a", "During the turn")).toBe(false);
    expect(store.getState().undo()).toBe(false);
    expect(store.getState().graph).toBe(before);
  });

  it("reloading after the agent changed the story forgets undo history; an unchanged story keeps it", async () => {
    await openStore();
    retitle("a", "Mine");
    await waitForSave();
    await store.getState().reload();
    expect(store.getState().past).toHaveLength(1);

    server.writeElsewhere({ ...sampleGraph(), title: "Rebuilt by the agent" });
    await store.getState().reload();
    expect(store.getState().graph?.title).toBe("Rebuilt by the agent");
    expect(store.getState().past).toEqual([]);
  });

  it("drops selected ids the reloaded graph no longer has", async () => {
    await openStore();
    store.getState().select({ nodes: ["b"], edges: ["e1"] });
    server.writeElsewhere(removeItems(sampleGraph(), ["b"]));
    await store.getState().reload();
    expect(store.getState().selection).toEqual({ nodes: [], edges: [] });
  });

  it("a reload for a timeline change takes the new sync report and keeps the unchanged graph object", async () => {
    await openStore();
    const graph = store.getState().graph;
    expect(store.getState().sync).toBeNull();

    server.state.sync = syncReport({ state: "out_of_sync", affected: ["b"] });
    await store.getState().reload();
    expect(store.getState().sync).toMatchObject({ state: "out_of_sync", affected: ["b"] });
    // Same graph version: the canvas keeps its cards.
    expect(store.getState().graph).toBe(graph);
  });
});
