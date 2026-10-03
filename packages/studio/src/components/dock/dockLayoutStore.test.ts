import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDockLayoutStore, type DockController } from "./dockLayoutStore";
import type { PanelId } from "./panelRegistry";

const snapshot = (groupActivePanels: PanelId[], activePanel: PanelId | null = null) => ({
  arrangement: "edit" as const,
  openPanels: new Set<PanelId>(["design", "renders", "compositions"]),
  visiblePanels: new Set<PanelId>(groupActivePanels),
  activePanel,
  groupActivePanels,
});

describe("dock store sync", () => {
  beforeEach(() => useDockLayoutStore.setState({ lastActive: {} }));

  it("records what every side group shows, not only the globally active panel", () => {
    useDockLayoutStore.getState().sync(snapshot(["compositions", "renders"], "compositions"));
    expect(useDockLayoutStore.getState().lastActive).toEqual({
      left: "compositions",
      right: "renders",
    });
  });

  it("forgets the previous dock's memory on detach", () => {
    useDockLayoutStore.getState().sync(snapshot(["renders"], "renders"));
    useDockLayoutStore.getState().detach();
    expect(useDockLayoutStore.getState().lastActive).toEqual({});
  });
});

describe("dock store workspaces", () => {
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
  const inStory = (openPanels: PanelId[]) =>
    useDockLayoutStore.setState({ arrangement: "story", openPanels: new Set(openPanels) });

  beforeEach(() => {
    calls.length = 0;
    useDockLayoutStore.setState({
      controller,
      arrangement: "edit",
      openPanels: new Set<PanelId>(["chat", "media", "preview", "story", "design", "timeline"]),
      pendingWorkspace: null,
      pendingActivation: null,
    });
  });

  it("enters Story when the Story panel is asked for, from any workspace", () => {
    useDockLayoutStore.getState().setWorkspace("story");
    expect(calls).toEqual(["enterStory", "show:story:true", "activate:story"]);
  });

  it("takes Story back to Edit before showing a panel Story does not have", () => {
    inStory(["chat", "media", "preview", "story"]);
    useDockLayoutStore.getState().activatePanel("design");
    expect(calls).toEqual(["leaveStory", "show:design:true", "activate:design"]);
  });

  it("keeps Story for the panels it shows", () => {
    inStory(["chat", "media", "preview", "story"]);
    for (const id of ["chat", "media", "preview", "story"] as const) {
      useDockLayoutStore.getState().activatePanel(id);
    }
    expect(calls).not.toContain("leaveStory");
  });

  it("leaves Story for Edit and for Media, then brings that workspace's panel forward", () => {
    inStory(["chat", "media", "preview", "story"]);
    useDockLayoutStore.getState().setWorkspace("media");
    useDockLayoutStore.getState().setWorkspace("edit");
    expect(calls).toEqual([
      "leaveStory",
      "show:media:true",
      "activate:media",
      "leaveStory",
      "show:preview:true",
      "activate:preview",
    ]);
  });

  it("treats the Edit panels as closed in Story, so the Window menu brings Edit back", () => {
    inStory(["chat", "media", "preview", "story"]);
    useDockLayoutStore.getState().togglePanel("timeline");
    expect(calls).toEqual(["leaveStory", "show:timeline:true", "activate:timeline"]);
  });

  it("hides and shows no Edit-only zone from Story", () => {
    inStory(["chat", "media", "preview", "story"]);
    useDockLayoutStore.getState().setZoneVisible("right", true);
    expect(calls).toEqual([]);
  });

  it("holds a workspace asked for before the dock mounted until it takes it", () => {
    useDockLayoutStore.setState({ controller: null });
    useDockLayoutStore.getState().setWorkspace("story");
    expect(calls).toEqual([]);
    expect(useDockLayoutStore.getState().takePendingWorkspace()).toBe("story");
    expect(useDockLayoutStore.getState().takePendingWorkspace()).toBeNull();
  });
});
