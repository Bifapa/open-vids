// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AgentModelInfo, ModelSelection } from "@hyperframes/agent-protocol";
import { ACTIVE, chatState, runningChatState, summary } from "../../agent/agentTestHarness";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { useProjectAgentStore } from "../../agent/agentContext";
import { AgentChatPanel } from "./AgentChatPanel";
import { ModelList } from "./ModelList";
import {
  buttonWithText,
  byLabel,
  click,
  mountChat,
  pressKey,
  type,
  unmountChat,
  type Mounted,
} from "./chatTestHarness";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
  vi.unstubAllGlobals();
});

describe("history view", () => {
  const chats = [
    summary({
      id: "c1",
      title: "Tighten the intro",
      status: "working",
      lastTaskSummary: "Trimming the title card",
    }),
    summary({ id: "c2", title: "Colour pass", status: "failed", updatedAt: 1000 }),
  ];

  it("lists chats with status and last task, and opens one to resume it", async () => {
    mounted = mountChat({ chats, activeTurn: null }, { chat: runningChatState() });
    const { host, client, store } = mounted;
    expect(host.textContent).toContain("Tighten the intro");
    expect(host.textContent).toContain("Working");
    expect(host.textContent).toContain("Trimming the title card");
    expect(host.textContent).toContain("Failed");

    await click(buttonWithText(host, "Tighten the intro"));
    expect(client.getChat).toHaveBeenCalledWith("c1");
    expect(store.getState().view).toBe("chat");
    expect(host.querySelector('[role="log"]')).not.toBeNull();
    expect(mounted.sources.latest("/chats/c1/events").url).toContain("after=2");
  });

  it("says which chat is working and offers to open it", async () => {
    mounted = mountChat({ chats, activeTurn: ACTIVE }, { chat: runningChatState() });
    const banner = mounted.host.querySelector('[role="status"]');
    expect(banner?.textContent).toContain("“Tighten the intro” is working on this project");
    await click(buttonWithText(banner ?? mounted.host, "Open"));
    expect(mounted.client.getChat).toHaveBeenCalledWith("c1");
  });

  it("opens on the new-chat draft when there are no chats, and creates the chat on the first send", async () => {
    mounted = mountChat({}, { chat: chatState({ chat: summary({ id: "c9" }) }) });
    const { host, client, store } = mounted;
    client.createChat.mockResolvedValueOnce(summary({ id: "c9" }));
    await act(async () => {
      await store.getState().init();
    });
    expect(store.getState().view).toBe("chat");
    expect(client.createChat).not.toHaveBeenCalled();
    await click(buttonWithText(host, "Add captions for the dialogue"));
    const field = host.querySelector("textarea");
    if (!field) throw new Error("no composer in the draft");
    expect(field.value).toBe("Add captions for the dialogue");
    await pressKey(field, "Enter");
    expect(client.createChat).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledWith(
      "c9",
      expect.objectContaining({ prompt: "Add captions for the dialogue" }),
    );
    expect(client.getChat).toHaveBeenCalledWith("c9");
    expect(store.getState().chatId).toBe("c9");
  });

  it("goes back to history from a chat, and moves focus to the history region", async () => {
    mounted = mountChat({ chats }, { chat: chatState() });
    await click(buttonWithText(mounted.host, "Tighten the intro"));
    await click(byLabel(mounted.host, "Chat history"));
    expect(mounted.store.getState().view).toBe("history");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Chats");
  });
});

describe("chat header", () => {
  it("locks the title while a run is live", () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: runningChatState() });
    expect(
      byLabel(mounted.host, "Rename chat: Tighten the intro")?.getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("renames inline: Enter commits through the server", async () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: chatState() });
    await click(byLabel(mounted.host, "Rename chat: Tighten the intro"));
    const input = byLabel<HTMLInputElement>(mounted.host, "Chat title");
    if (!input) throw new Error("no title field");
    await type(input, "Sharper intro");
    await pressKey(input, "Enter");
    expect(mounted.client.updateChat).toHaveBeenCalledWith("c1", { title: "Sharper intro" });
  });
});

describe("agent unavailable", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("shows a calm state with Retry instead of throwing into the editor", async () => {
    const context = {
      capture: () => {
        throw new Error("the editor context is not read in this test");
      },
    };
    function Panel() {
      return <AgentChatPanel store={useProjectAgentStore("demo", context, () => {})} />;
    }
    await act(async () => {
      mountHost(<Panel />);
    });
    await act(async () => {});
    const host = document.body;
    expect(host.textContent).toContain("Agent unavailable");
    expect(host.textContent).toContain("Your project is untouched");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/demo/agent/chats");

    const calls = fetchMock.mock.calls.length;
    await click(buttonWithText(host, "Retry"));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    cleanupMounted();
  });
});

describe("model list", () => {
  const many: AgentModelInfo[] = Array.from({ length: 1200 }, (_, index) => ({
    provider: `provider-${String(index % 30).padStart(2, "0")}`,
    modelId: `model-${index}`,
    name: `Model ${index}`,
    reasoning: index % 2 === 0,
    efforts: [],
  }));

  function mountList(
    onSelect: (model: ModelSelection | null) => void,
    explicit: ModelSelection | null = null,
  ) {
    return mountHost(
      <ModelList models={many} explicit={explicit} defaultName="Model 3" onSelect={onSelect} />,
    );
  }

  // happy-dom has no layout; the virtualizer measures its scroller through offsetWidth/Height.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(260);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
  });

  afterEach(() => {
    cleanupMounted();
    vi.restoreAllMocks();
  });

  it("keeps 1200 models out of the DOM: only a window of rows is rendered", () => {
    const host = mountList(() => {});
    const options = host.querySelectorAll('[role="option"]');
    expect(options.length).toBeGreaterThan(0);
    expect(options.length).toBeLessThan(60);
    expect(host.querySelector('[role="option"]')?.textContent).toContain("Default · Model 3");
  });

  it("filters by search and picks with the keyboard", async () => {
    const picked: (ModelSelection | null)[] = [];
    const host = mountList((model) => picked.push(model));
    const search = byLabel<HTMLInputElement>(host, "Search models");
    if (!search) throw new Error("no search field");

    await type(search, "model 1199");
    const options = [...host.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Model 1199"),
    ]);

    await pressKey(search, "Enter");
    expect(picked).toEqual([{ provider: "provider-29", modelId: "model-1199" }]);
  });

  it("tells the user when nothing matches, and lets the default row clear the choice", async () => {
    const picked: (ModelSelection | null)[] = [];
    const host = mountList((model) => picked.push(model), {
      provider: "provider-00",
      modelId: "model-0",
    });
    const search = byLabel<HTMLInputElement>(host, "Search models");
    if (!search) throw new Error("no search field");
    await type(search, "no such model");
    expect(host.textContent).toContain("No model matches");
    await type(search, "");

    await click(host.querySelector('[role="option"]'));
    expect(picked).toEqual([null]);
  });
});
