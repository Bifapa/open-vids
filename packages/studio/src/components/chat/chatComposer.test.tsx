// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS, chatState, runningChatState, summary } from "../../agent/agentTestHarness";
import { useComposerContextStore } from "../../agent/composerContext";
import { useAssetPreviewStore } from "../../utils/assetPreviewStore";
import { useDockLayoutStore, type DockController } from "../dock/dockLayoutStore";
import type { PanelId } from "../dock/panelRegistry";
import {
  byLabel,
  click,
  mountChat,
  pressKey,
  type,
  unmountChat,
  type Mounted,
} from "./chatTestHarness";

const fileManager = vi.hoisted((): { value: { assets: string[]; fileTree: string[] } | null } => ({
  value: null,
}));
vi.mock("../../contexts/FileManagerContext", () => ({
  useFileManagerContextOptional: () => fileManager.value,
}));

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
  useDockLayoutStore.setState({ controller: null });
  useAssetPreviewStore.setState({ previewAsset: null, previewProjectId: null });
  useComposerContextStore.getState().clear();
  fileManager.value = null;
});

/** Base UI opens popups a task after the click. */
async function settle() {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
}

const controller: DockController = {
  open: vi.fn(),
  activate: vi.fn(),
  setTitle: vi.fn(),
  close: vi.fn(),
  setGroupVisible: vi.fn(),
  enterStory: vi.fn(),
  leaveStory: vi.fn(),
  reset: vi.fn(),
};

function showPanels(...panels: PanelId[]) {
  useDockLayoutStore.setState({ controller, visiblePanels: new Set(panels) });
}

const textarea = (host: HTMLElement) => {
  const field = host.querySelector<HTMLTextAreaElement>("textarea");
  if (!field) throw new Error("no composer");
  return field;
};

describe("story mode follows the Story workspace", () => {
  it("runs a new turn in story mode while the Story panel is shown, and says so", async () => {
    showPanels("story");
    mounted = mountChat({ view: "chat", chatId: "c1", chat: chatState() });
    expect(mounted.host.querySelector('[data-testid="composer-story-chip"]')).not.toBeNull();
    expect(textarea(mounted.host).placeholder).toContain("story");

    await type(textarea(mounted.host), "Make the opening chapter shorter");
    await pressKey(textarea(mounted.host), "Enter");
    expect(mounted.client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ prompt: "Make the opening chapter shorter", mode: "story" }),
    );
  });

  it("runs a normal turn when the Story panel is not shown, whatever the chat's saved mode", async () => {
    showPanels("preview");
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: chatState({ chat: summary({ activeMode: "story" }) }),
    });
    expect(mounted.host.querySelector('[data-testid="composer-story-chip"]')).toBeNull();
    await type(textarea(mounted.host), "Trim the intro");
    await pressKey(textarea(mounted.host), "Enter");
    expect(mounted.client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ mode: "normal" }),
    );
  });
});

describe("mode chip", () => {
  it("persists the chosen intent on the chat and shows it", async () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: chatState() });
    expect(byLabel(mounted.host, "Mode: Edit — Acts on the timeline")).not.toBeNull();

    await click(byLabel(mounted.host, "Mode: Edit — Acts on the timeline"));
    await settle();
    await click(byLabel(document.body, "Ask mode: Answers only"));

    expect(mounted.client.updateChat).toHaveBeenCalledWith("c1", { intent: "ask" });
    expect(byLabel(mounted.host, "Mode: Ask — Answers only")).not.toBeNull();
  });

  it("starts a new chat in Edit, and can switch the draft to Ask before it sends", async () => {
    mounted = mountChat({ view: "chat", chatId: null, chat: null, settings: SETTINGS });
    expect(byLabel(mounted.host, "Mode: Edit — Acts on the timeline")).not.toBeNull();

    await click(byLabel(mounted.host, "Mode: Edit — Acts on the timeline"));
    await settle();
    await click(byLabel(document.body, "Ask mode: Answers only"));
    expect(byLabel(mounted.host, "Mode: Ask — Answers only")).not.toBeNull();

    await type(textarea(mounted.host), "What is in the intro?");
    await pressKey(textarea(mounted.host), "Enter");
    await settle();
    // The chat is created with the mode its composer showed.
    expect(mounted.client.updateChat).toHaveBeenCalledWith("new", { intent: "ask" });
    expect(mounted.client.startTurn).toHaveBeenCalledWith(
      "new",
      expect.objectContaining({ prompt: "What is in the intro?" }),
    );
  });

  it("leaves a chat without a stored intent in Edit", () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: chatState() });
    expect(byLabel(mounted.host, "Mode: Edit — Acts on the timeline")).not.toBeNull();
  });

  it("cannot change the intent while the chat's turn runs", async () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: runningChatState() });
    await click(byLabel(mounted.host, "Mode: Edit — Acts on the timeline"));
    await settle();
    const ask = byLabel<HTMLButtonElement>(document.body, "Ask mode: Answers only");
    expect(ask?.disabled).toBe(true);
    await click(ask);
    expect(mounted.client.updateChat).not.toHaveBeenCalled();
  });
});

describe("model chip", () => {
  it("shows the resolved default model and locks model and effort while a run is live", async () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: runningChatState() });
    const chip = byLabel<HTMLButtonElement>(
      mounted.host,
      "Main model: Sonnet, Default thinking effort",
    );
    expect(chip).not.toBeNull();
    await click(chip);
    await settle();
    const field = byLabel<HTMLButtonElement>(document.body, "Main model: Default · Sonnet");
    expect(field?.disabled).toBe(true);
    const efforts = document.body.querySelectorAll<HTMLButtonElement>(
      '[role="radiogroup"][aria-label="Thinking effort"] [role="radio"]',
    );
    expect(efforts.length).toBeGreaterThan(1);
    expect([...efforts].every((effort) => effort.disabled)).toBe(true);
  });
});

describe("context chips", () => {
  it("shows what goes with the next message and lets the user take it out", async () => {
    useAssetPreviewStore.setState({ previewAsset: "assets/city-night.mp4", previewProjectId: "" });
    mounted = mountChat({ view: "chat", chatId: "c1", chat: chatState() });
    const list = mounted.host.querySelector('[data-testid="composer-context"]');
    expect(list?.textContent).toContain("city-night.mp4");

    await click(byLabel(mounted.host, "Remove city-night.mp4 from the next message"));
    expect(mounted.host.querySelector('[data-testid="composer-context"]')).toBeNull();
    expect(useComposerContextStore.getState().excluded.has("asset:assets/city-night.mp4")).toBe(
      true,
    );
  });
});

describe("@ mentions", () => {
  it("completes a project file from the popup and attaches it without sending", async () => {
    const assets = ["assets/logo.png", "assets/intro.mp4", "music/interlude.mp3"];
    fileManager.value = { assets, fileTree: assets };
    mounted = mountChat({ view: "chat", chatId: "c1", chat: chatState() });
    const field = textarea(mounted.host);
    await act(async () => field.focus());

    await type(field, "look at @int");
    await act(async () => field.setSelectionRange(12, 12));
    const menu = mounted.host.querySelector('[data-testid="composer-mention-menu"]');
    expect(menu?.getAttribute("role")).toBe("listbox");
    const names = [...(menu?.querySelectorAll('[role="option"]') ?? [])].map(
      (option) => option.querySelector("span")?.textContent,
    );
    expect(names).toEqual(["interlude.mp3", "intro.mp4"]);

    await pressKey(field, "ArrowDown");
    await pressKey(field, "Enter");

    expect(field.value).toBe("look at @intro.mp4 ");
    expect(field.selectionStart).toBe(19);
    expect(mounted.client.startTurn).not.toHaveBeenCalled();
    expect(mounted.host.querySelector('[data-testid="composer-mention-menu"]')).toBeNull();
    const chips = mounted.host.querySelector('[data-testid="composer-attachments"]');
    expect(chips?.textContent).toContain("intro.mp4");
  });
});

describe("input method composition", () => {
  // WebKit ends the composition before it delivers the Enter that committed it: `isComposing` is already false, and
  // only keyCode 229 marks the key as the input method's.
  const IME_COMMIT = { keyCode: 229 };

  it("does not send on the Enter that commits a composition, or while one is open", async () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: chatState() });
    const field = textarea(mounted.host);
    await type(field, "こんにちは");

    await pressKey(field, "Enter", IME_COMMIT);
    await pressKey(field, "Enter", { isComposing: true });
    expect(mounted.client.startTurn).not.toHaveBeenCalled();
    expect(field.value).toBe("こんにちは");

    // The next Enter is the user's own.
    await pressKey(field, "Enter", { keyCode: 13 });
    expect(mounted.client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ prompt: "こんにちは" }),
    );
  });

  it("does not pick a file from the @ popup on the Enter that commits a composition", async () => {
    const assets = ["assets/intro.mp4"];
    fileManager.value = { assets, fileTree: assets };
    mounted = mountChat({ view: "chat", chatId: "c1", chat: chatState() });
    const field = textarea(mounted.host);
    await act(async () => field.focus());
    await type(field, "@int");
    await act(async () => field.setSelectionRange(4, 4));
    expect(mounted.host.querySelector('[data-testid="composer-mention-menu"]')).not.toBeNull();

    await pressKey(field, "Enter", IME_COMMIT);

    expect(field.value).toBe("@int");
    expect(mounted.host.querySelector('[data-testid="composer-attachments"]')).toBeNull();
  });
});
