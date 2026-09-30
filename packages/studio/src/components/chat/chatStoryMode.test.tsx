// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { chatState, runningChatState, summary } from "../../agent/agentTestHarness";
import { useDockLayoutStore } from "../dock/dockLayoutStore";
import { buttonWithText, click, mountChat, unmountChat, type Mounted } from "./chatTestHarness";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
  useDockLayoutStore.setState({ pendingActivation: null });
});

const radio = (host: HTMLElement, label: string) =>
  [
    ...host.querySelectorAll<HTMLButtonElement>(
      '[role="radiogroup"][aria-label="Chat mode"] [role="radio"]',
    ),
  ].find((option) => option.textContent === label) ?? null;

const composer = (host: HTMLElement) => host.querySelector<HTMLTextAreaElement>("textarea");

describe("chat mode", () => {
  it("switching to Story PATCHes the chat's activeMode and shows story mode", async () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: chatState() });
    expect(radio(mounted.host, "Normal")?.getAttribute("aria-checked")).toBe("true");
    expect(mounted.host.querySelector('[data-testid="story-mode-banner"]')).toBeNull();

    await click(radio(mounted.host, "Story"));

    expect(mounted.client.updateChat).toHaveBeenCalledWith("c1", { activeMode: "story" });
    expect(radio(mounted.host, "Story")?.getAttribute("aria-checked")).toBe("true");
    expect(mounted.host.querySelector('[data-testid="story-mode-banner"]')).not.toBeNull();
    expect(composer(mounted.host)?.placeholder).toContain("story");
  });

  it("Open Story brings the Story panel forward", async () => {
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: chatState({ chat: summary({ activeMode: "story" }) }),
    });
    await click(buttonWithText(mounted.host, "Open Story"));
    expect(useDockLayoutStore.getState().pendingActivation).toBe("story");
  });

  it("cannot change mode while the chat's turn runs", async () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: runningChatState() });
    expect(radio(mounted.host, "Story")?.disabled).toBe(true);
    await click(radio(mounted.host, "Story"));
    expect(mounted.client.updateChat).not.toHaveBeenCalled();
  });
});
