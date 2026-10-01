// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MissingAssetNode,
  SpecialistId,
  StoryGraph,
  VideoNode,
} from "@hyperframes/agent-protocol";
import { createAgentStore, type AgentStore } from "../agent/agentStore";
import {
  chatState,
  createFakeClient,
  createSourceLog,
  summary,
  type FakeClient,
} from "../agent/agentTestHarness";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { cleanupMounted, mountHost } from "../components/ui/mountHost.testHelpers";
import { createResearchClient } from "../research/researchClient";
import { ResearchProvider } from "../research/researchContext";
import { researchFetch, sourceEntry, sourcesView } from "../research/researchTestHarness";
import { createSourcesStore, type SourcesStore } from "../research/sourcesStore";
import { StoryProvider } from "./storyContext";
import { StoryPanel } from "./StoryPanel";
import { createStoryStore, type StoryStore } from "./storyStore";
import {
  attachment,
  chapter,
  createFakeStoryServer,
  sampleGraph,
  settle,
  type FakeStoryServer,
} from "./storyTestHarness";

function missing(id: string, overrides: Partial<MissingAssetNode> = {}): MissingAssetNode {
  return {
    id,
    kind: "missing",
    title: `Missing ${id}`,
    position: { x: 0, y: 300 },
    locked: false,
    createdBy: "ai",
    userEdited: [],
    mediaKind: "video",
    need: "Waves at dusk",
    neededDuration: 4,
    ...overrides,
  };
}

const RESOLVED: VideoNode = {
  id: "found",
  kind: "video",
  title: "Ocean waves",
  position: { x: 300, y: 300 },
  locked: false,
  createdBy: "ai",
  userEdited: [],
  asset: "assets/research/ocean.mp4",
  sourceIn: 0,
  sourceOut: 4,
  usageIntent: "B-roll over the intro",
  previewFrame: null,
  resolvedFrom: {
    missing: "m0",
    mediaKind: "video",
    need: "Waves at dusk",
    at: 1000,
    turnId: "t9",
  },
};

function researchGraph(): StoryGraph {
  const base = sampleGraph();
  return {
    ...base,
    nodes: [
      chapter("a", 0),
      missing("m1"),
      missing("m2", { locked: true, need: "Drone shot of the coast" }),
      RESOLVED,
    ],
    edges: [],
    attachments: [attachment("t1", "m1", "a"), attachment("t2", "found", "a")],
  };
}

let server: FakeStoryServer;
let story: StoryStore;
let sources: SourcesStore;
let agent: AgentStore;
let agentClient: FakeClient;
let host: HTMLElement;

async function mount({
  graph = researchGraph(),
  enabledAgents = ["research"],
}: { graph?: StoryGraph; enabledAgents?: SpecialistId[] } = {}) {
  server = createFakeStoryServer(graph);
  story = createStoryStore({ client: server.client, saveDelayMs: 400 });
  const research = researchFetch({
    "GET /api/projects/p1/research/sources": () =>
      sourcesView([sourceEntry({ licenseStatus: "unknown", license: "Unknown" })]),
  });
  const researchClient = createResearchClient(research.fetch);
  sources = createSourcesStore(researchClient);
  const chat = chatState({ chat: summary({ enabledAgents }) });
  agentClient = createFakeClient({ chat });
  agent = createAgentStore({ client: agentClient, openEventSource: createSourceLog().open });
  agent.setState({ availability: "ready", view: "chat", chatId: "c1", chat, streamStatus: "open" });
  await act(async () => {
    host = mountHost(
      <ResearchProvider store={sources} client={researchClient}>
        <StoryProvider store={story} client={server.client}>
          <StoryPanel projectId="p1" agentStore={agent} />
        </StoryProvider>
      </ResearchProvider>,
    );
    await sources.getState().open("p1");
  });
  await act(async () => settle());
}

const findButton = (id: string) =>
  host.querySelector<HTMLButtonElement>(`[data-story-node="${id}"] [data-story-find="${id}"]`);
const toolbarFind = () => host.querySelector<HTMLButtonElement>('[data-story-action="resolve"]');

async function click(element: Element | null) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
  });
}

beforeEach(() => {
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

describe("Find with Research", () => {
  it("a Missing Asset card starts a resolve turn scoped to that node and brings Chat forward", async () => {
    await mount();

    await click(findButton("m1"));

    expect(agentClient.startTurn).toHaveBeenCalledWith("c1", {
      prompt: "Find the missing material",
      mode: "story",
      storyAction: "resolve",
      storyOptions: { missing: ["m1"] },
      editorContext: undefined,
      userLanguage: "en",
    });
    expect(useDockLayoutStore.getState().pendingActivation).toBe("chat");
  });

  it("a locked Missing Asset node cannot be sent to Research", async () => {
    await mount();

    expect(findButton("m2")?.disabled).toBe(true);
    expect(findButton("m2")?.parentElement?.getAttribute("title")).toContain("Locked");
  });

  it("the toolbar resolves every unlocked Missing Asset node in one turn", async () => {
    await mount();

    expect(toolbarFind()?.textContent).toContain("Find missing material1");
    await click(toolbarFind());

    expect(agentClient.startTurn).toHaveBeenCalledTimes(1);
    const [, request] = agentClient.startTurn.mock.calls[0] ?? [];
    expect(request).toMatchObject({ mode: "story", storyAction: "resolve" });
    expect(request).not.toHaveProperty("storyOptions");
  });

  it("is disabled when the open chat has Research turned off", async () => {
    await mount({ enabledAgents: ["editor", "vision"] });

    expect(toolbarFind()?.disabled).toBe(true);
    expect(findButton("m1")?.disabled).toBe(true);
    expect(findButton("m1")?.parentElement?.getAttribute("title")).toContain(
      "Research is turned off in this chat",
    );
    await click(toolbarFind());
    expect(agentClient.startTurn).not.toHaveBeenCalled();
  });

  it("is disabled when nothing is missing", async () => {
    const graph = researchGraph();
    await mount({
      graph: {
        ...graph,
        nodes: graph.nodes.filter((node) => node.kind !== "missing" || node.locked),
        attachments: [],
      },
    });

    expect(toolbarFind()?.disabled).toBe(true);
  });
});

describe("Material found by Research", () => {
  it("shows the need it resolved and a license chip from the project's sources", async () => {
    await mount();

    const card = host.querySelector('[data-story-node="found"]');
    expect(card?.textContent).toContain("Found by Research");
    expect(card?.textContent).toContain("For: Waves at dusk");
    const chip = card?.querySelector("[data-license-status]");
    expect(chip?.getAttribute("data-license-status")).toBe("unknown");
    expect(chip?.textContent).toBe("Unknown");
    expect(chip?.parentElement?.textContent).toContain("Wikimedia Commons");
  });

  it("the inspector shows the provenance and opens the Sources panel on the record", async () => {
    await mount();
    act(() => story.getState().select({ nodes: ["found"], edges: [] }));

    const inspector = host.querySelector('[aria-label="Story inspector"]');
    expect(inspector?.textContent).toContain("Jane Doe");
    expect(inspector?.textContent).toContain("Wikimedia Commons API (LicenseShortName)");
    const show = [...(inspector?.querySelectorAll("button") ?? [])].find((button) =>
      button.textContent?.includes("Show in Sources"),
    );
    await click(show ?? null);

    expect(sources.getState().revealed).toBe("assets/research/ocean.mp4");
    expect(useDockLayoutStore.getState().pendingActivation).toBe("sources");
  });

  it("keeps resolvedFrom when the user edits the node in the inspector and the story saves", async () => {
    await mount();
    act(() => story.getState().select({ nodes: ["found"], edges: [] }));
    const title = host.querySelector<HTMLInputElement>(
      '[aria-label="Story inspector"] input[aria-label="Title"]',
    );
    if (!title) throw new Error("no title field");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        title,
        "Waves",
      );
      title.dispatchEvent(new Event("input", { bubbles: true }));
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await story.getState().flush();
    });

    const saved = server.saves.at(-1)?.graph.nodes.find((node) => node.id === "found");
    expect(saved).toMatchObject({ title: "Waves", resolvedFrom: RESOLVED.resolvedFrom });
  });
});
