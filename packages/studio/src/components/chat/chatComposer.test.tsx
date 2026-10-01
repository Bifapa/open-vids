// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatState, runningChatState, summary } from "../../agent/agentTestHarness";
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

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
  useDockLayoutStore.setState({ controller: null });
  useAssetPreviewStore.setState({ previewAsset: null, previewProjectId: null });
  useComposerContextStore.getState().clear();
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

  it("cannot change the intent while the chat's turn runs", async () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: runningChatState() });
    await click(byLabel(mounted.host, "Mode: Edit — Acts on the timeline"));
    await settle();
    const plan = byLabel<HTMLButtonElement>(document.body, "Plan mode: Proposes a plan first");
    expect(plan?.disabled).toBe(true);
    await click(plan);
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
