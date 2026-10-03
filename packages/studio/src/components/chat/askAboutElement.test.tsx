// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStoreProvider, useAgentStoreApi } from "../../agent/agentContext";
import { createAgentStore, type AgentState, type AgentStore } from "../../agent/agentStore";
import {
  CATALOG,
  chatState,
  createFakeClient,
  createSourceLog,
  runningChatState,
  type FakeClient,
} from "../../agent/agentTestHarness";
import { useComposerContextStore } from "../../agent/composerContext";
import { useComposerRequestBridge, useComposerRequestStore } from "../../agent/composerRequest";
import { usePlayerStore } from "../../player";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { useDockLayoutStore, type DockController } from "../dock/dockLayoutStore";
import { AgentChatBody } from "./AgentChatPanel";
import { askAgentAboutElement } from "./askAboutElement";
import { type } from "./chatTestHarness";

const controller: DockController = {
  open: vi.fn(),
  activate: vi.fn(),
  setTitle: vi.fn(),
  close: vi.fn(),
  setGroupVisible: vi.fn(),
  reset: vi.fn(),
};

const HERO = {
  id: "hero-title",
  hfId: "hf-hero",
  selector: "#hero-title",
  label: "Hero title",
  tagName: "h1",
  sourceFile: "index.html",
};

let store: AgentStore | undefined;
let client: FakeClient | undefined;

/** The chat panel under a real store, the way StudioRightPanels mounts it with its request bridge. */
function mountPanel(state: Partial<AgentState>) {
  client = createFakeClient({ chat: chatState() });
  store = createAgentStore({ client, openEventSource: createSourceLog().open });
  store.setState({ availability: "ready", models: CATALOG, ...state });
  function Bridge() {
    useComposerRequestBridge(useAgentStoreApi());
    return null;
  }
  return mountHost(
    <AgentStoreProvider store={store}>
      <Bridge />
      <AgentChatBody />
    </AgentStoreProvider>,
  );
}

const field = (host: HTMLElement) => {
  const area = host.querySelector<HTMLTextAreaElement>("textarea");
  if (!area) throw new Error("no composer");
  return area;
};

afterEach(() => {
  store?.getState().dispose();
  store = undefined;
  client = undefined;
  cleanupMounted();
  useDockLayoutStore.setState({ controller: null, pendingActivation: null });
  useComposerContextStore.getState().clear();
  useComposerRequestStore.setState({ request: null, focusPending: false });
  usePlayerStore.setState({ elements: [] });
  vi.clearAllMocks();
});

describe("Ask Agent about an element", () => {
  it("fills the open chat's composer, focuses it with the caret at the end and sends nothing", async () => {
    useDockLayoutStore.setState({ controller });
    const host = mountPanel({ view: "chat", chatId: "c1", chat: chatState() });

    await act(async () => askAgentAboutElement(HERO));

    const area = field(host);
    expect(area.value).toBe("About “Hero title”: ");
    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe(area.value.length);
    expect(area.selectionEnd).toBe(area.value.length);
    expect(store?.getState().drafts.c1).toBe("About “Hero title”: ");
    expect(controller.setGroupVisible).toHaveBeenCalledWith("chat", true);
    expect(controller.activate).toHaveBeenCalledWith("chat");
    expect(client?.startTurn).not.toHaveBeenCalled();
    expect(client?.steerTurn).not.toHaveBeenCalled();
  });

  it("goes on a new line after what the user already typed", async () => {
    const host = mountPanel({ view: "chat", chatId: "c1", chat: chatState() });
    await type(field(host), "make it punchier");

    await act(async () => askAgentAboutElement(HERO));

    expect(field(host).value).toBe("make it punchier\nAbout “Hero title”: ");
    expect(client?.startTurn).not.toHaveBeenCalled();
  });

  it("only fills the composer while a turn is running: no steer is sent", async () => {
    const host = mountPanel({ view: "chat", chatId: "c1", chat: runningChatState() });

    await act(async () => askAgentAboutElement(HERO));

    expect(field(host).value).toBe("About “Hero title”: ");
    expect(client?.steerTurn).not.toHaveBeenCalled();
    expect(client?.startTurn).not.toHaveBeenCalled();
  });

  it("opens the new-chat draft from the history view and fills it", async () => {
    const host = mountPanel({ view: "history", chatId: null, chat: null });

    await act(async () => askAgentAboutElement(HERO));

    expect(store?.getState().view).toBe("chat");
    expect(field(host).value).toBe("About “Hero title”: ");
    expect(client?.startTurn).not.toHaveBeenCalled();
  });

  it("takes back the element chip the user had removed", async () => {
    const chipKey = "element:hf-hero";
    useComposerContextStore.getState().exclude(chipKey);
    useComposerContextStore.getState().exclude("asset:assets/keep-removed.mp4");

    askAgentAboutElement(HERO);

    const { excluded } = useComposerContextStore.getState();
    expect(excluded.has(chipKey)).toBe(false);
    expect(excluded.has("asset:assets/keep-removed.mp4")).toBe(true);
  });

  it("takes back the clip chip when the element is a timeline clip", () => {
    usePlayerStore.setState({
      elements: [
        {
          id: "hero-title",
          key: "index.html#hero-title",
          tag: "h1",
          start: 0,
          duration: 3,
          track: 0,
          hfId: "hf-hero",
        },
        { id: "other", tag: "div", start: 0, duration: 3, track: 1, hfId: "hf-other" },
      ],
    });
    useComposerContextStore.getState().exclude("clip:index.html#hero-title");
    useComposerContextStore.getState().exclude("clip:other");

    askAgentAboutElement(HERO);

    const { excluded } = useComposerContextStore.getState();
    expect(excluded.has("clip:index.html#hero-title")).toBe(false);
    expect(excluded.has("clip:other")).toBe(true);
  });

  it("is not lost when it comes before the chat panel exists", () => {
    function Probe({ source }: { source: AgentStore | null }): ReactElement | null {
      useComposerRequestBridge(source);
      return null;
    }
    const target = createAgentStore({
      client: createFakeClient({ chat: chatState() }),
      openEventSource: createSourceLog().open,
    });
    target.setState({ view: "chat", chatId: "c1", chat: chatState() });
    const host = document.createElement("div");
    const root = createRoot(host);

    act(() => root.render(<Probe source={null} />));
    act(() => askAgentAboutElement(HERO));
    expect(target.getState().drafts.c1).toBeUndefined();

    act(() => root.render(<Probe source={target} />));
    expect(target.getState().drafts.c1).toBe("About “Hero title”: ");
    expect(useComposerRequestStore.getState().request).toBeNull();

    act(() => root.unmount());
    target.getState().dispose();
  });
});

describe("a request to send (Checks › Fix with Agent)", () => {
  const ask = (text: string) => useComposerRequestStore.getState().ask(text, { send: true });

  it("goes out as the next message of the open chat", async () => {
    mountPanel({ view: "chat", chatId: "c1", chat: chatState() });

    await act(async () => ask("Fix these problems"));

    expect(client?.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ prompt: "Fix these problems" }),
    );
  });

  it("only joins the draft while a turn is running, so it never steers that turn", async () => {
    const host = mountPanel({
      view: "chat",
      chatId: "c1",
      chat: runningChatState(),
      activeTurn: { chatId: "c1", turnId: "t1", startedAt: 1 },
    });

    await act(async () => ask("Fix these problems"));

    expect(field(host).value).toBe("Fix these problems");
    expect(client?.steerTurn).not.toHaveBeenCalled();
    expect(client?.startTurn).not.toHaveBeenCalled();
  });

  it("does not send what the user was typing: the findings join the draft instead", async () => {
    const host = mountPanel({ view: "chat", chatId: "c1", chat: chatState() });
    await type(field(host), "half-written idea");

    await act(async () => ask("Fix these problems"));

    expect(field(host).value).toBe("half-written idea\nFix these problems");
    expect(client?.startTurn).not.toHaveBeenCalled();
  });
});
