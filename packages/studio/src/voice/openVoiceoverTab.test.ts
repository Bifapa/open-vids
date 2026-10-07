import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDockLayoutStore, type DockController } from "../components/dock/dockLayoutStore";
import type { PanelId } from "../components/dock/panelRegistry";
import { openVoiceoverTab } from "./openVoiceoverTab";

describe("openVoiceoverTab", () => {
  const calls: string[] = [];
  const controller: DockController = {
    open: vi.fn(),
    activate: (id) => void calls.push(`activate:${id}`),
    setTitle: vi.fn(),
    close: vi.fn(),
    setGroupVisible: (id, visible) => void calls.push(`show:${id}:${visible}`),
    enterStory: () => void calls.push("enterStory"),
    leaveStory: () => void calls.push("leaveStory"),
    reset: vi.fn(),
  };

  beforeEach(() => {
    calls.length = 0;
    useDockLayoutStore.setState({
      controller,
      arrangement: "edit",
      openPanels: new Set<PanelId>(["media", "preview", "design", "voiceover", "timeline"]),
      pendingWorkspace: null,
      pendingActivation: null,
    });
  });

  it("goes back to the Edit workspace before showing the tab, so the Media workspace does not hide it", () => {
    openVoiceoverTab();
    expect(calls).toEqual([
      "leaveStory",
      "show:preview:true",
      "activate:preview",
      "show:voiceover:true",
      "activate:voiceover",
    ]);
  });

  it("leaves Story for the tab too", () => {
    useDockLayoutStore.setState({ arrangement: "story" });
    openVoiceoverTab();
    expect(calls.slice(0, 1)).toEqual(["leaveStory"]);
    expect(calls.at(-1)).toBe("activate:voiceover");
  });
});
