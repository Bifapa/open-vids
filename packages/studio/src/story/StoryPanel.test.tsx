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
import {
  createFakeStoryServer,
  sampleGraph,
  settle,
  type FakeStoryServer,
} from "./storyTestHarness";

let server: FakeStoryServer;
let story: StoryStore;
let agent: AgentStore;
let agentClient: FakeClient;
let host: HTMLElement;

async function mount({ chatOpen = true, graph = sampleGraph() } = {}) {
  server = createFakeStoryServer(graph);
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
    expect(button("Add")?.disabled).toBe(true);
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
