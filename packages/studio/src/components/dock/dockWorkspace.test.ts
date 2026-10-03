// @vitest-environment happy-dom

import {
  createDockview,
  type DockviewApi,
  type GroupPanelPartInitParameters,
  type SerializedDockview,
} from "dockview-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRegisteredPanel, buildEditLayout } from "./dockLayout";
import {
  DEFAULT_STORY_RATIOS,
  arrangeStory,
  readStoryRatios,
  restoreEdit,
  sameStructure,
  storyPlacement,
} from "./dockWorkspace";
import type { PanelId } from "./panelRegistry";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

/** A dockview whose panel bodies are counted: a body that mounts twice or disposes was re-parented by a rebuild. */
let mounted: Map<string, number>;
let disposed: string[];
let bodies: Map<string, HTMLElement>;
let api: DockviewApi;

beforeEach(() => {
  mounted = new Map();
  disposed = [];
  bodies = new Map();
  const host = document.createElement("div");
  document.body.append(host);
  api = createDockview(host, {
    createComponent: () => {
      const element = document.createElement("div");
      let id = "";
      return {
        element,
        init(parameters: GroupPanelPartInitParameters) {
          id = parameters.api.id;
          mounted.set(id, (mounted.get(id) ?? 0) + 1);
          bodies.set(id, element);
        },
        dispose() {
          disposed.push(id);
        },
      };
    },
  });
  api.layout(1400, 800);
  buildEditLayout(api, 1400);
});

afterEach(() => {
  api.dispose();
  document.body.innerHTML = "";
});

/** Each panel's group by id, as the layout of who shares a group with whom. */
function groupsOf(): string[] {
  return api.groups.map((group) => group.panels.map((panel) => panel.id).join("+")).sort();
}

function panelGroup(id: PanelId) {
  const group = api.getPanel(id)?.group;
  if (!group) throw new Error(`${id} is not open`);
  return group;
}

/** Group id -> [width, height, visible]; ids are stable across a round trip when the same groups host the same panels. */
function geometry(): Record<string, string> {
  return Object.fromEntries(
    api.groups.map((group) => [
      group.panels.map((panel) => panel.id).join("+"),
      `${Math.round(group.width)}x${Math.round(group.height)}${group.api.isVisible ? "" : " hidden"}`,
    ]),
  );
}

describe("arrangeStory", () => {
  it("puts Chat and Media in a full-height left column and the preview above the Story graph", () => {
    const created = arrangeStory(api, DEFAULT_STORY_RATIOS);
    if (!created) throw new Error("the Story panels are all open");

    expect(panelGroup("chat")).toBe(panelGroup("media"));
    expect(panelGroup("chat").height).toBe(api.height);
    expect(panelGroup("chat").width).toBe(Math.round(api.width * DEFAULT_STORY_RATIOS.left));
    const preview = panelGroup("preview");
    const story = panelGroup("story");
    expect(preview).not.toBe(story);
    expect(preview.width).toBe(story.width);
    expect(preview.height + story.height).toBe(api.height);
    expect(preview.width + panelGroup("chat").width).toBe(api.width);
  });

  it("hides every other group and creates only the left and bottom groups", () => {
    const created = arrangeStory(api, DEFAULT_STORY_RATIOS);
    const visible = api.groups.filter((group) => group.api.isVisible).map((group) => group.id);
    expect(visible).toHaveLength(3);
    expect([...(created ?? [])].every((id) => visible.includes(id))).toBe(true);
    for (const id of ["timeline", "compositions", "design"] as const) {
      expect(panelGroup(id).api.isVisible).toBe(false);
    }
  });

  it("applies the stored splits", () => {
    arrangeStory(api, { left: 0.5, top: 0.25 });
    expect(panelGroup("chat").width).toBe(700);
    expect(panelGroup("preview").height).toBe(Math.round(api.height * 0.25));
  });

  it("reads the splits back as ratios of the window", () => {
    arrangeStory(api, { left: 0.5, top: 0.25 });
    const ratios = readStoryRatios(api);
    expect(ratios?.left).toBeCloseTo(0.5, 2);
    expect(ratios?.top).toBeCloseTo(0.25, 2);
  });

  it("gives a preview group the user filled with other tabs a group of its own", () => {
    const preview = api.getPanel("preview");
    const design = api.getPanel("design");
    if (!preview || !design) throw new Error("default layout is missing panels");
    design.api.moveTo({ group: preview.group, position: "center" });
    arrangeStory(api, DEFAULT_STORY_RATIOS);
    expect(panelGroup("preview")).not.toBe(panelGroup("design"));
    expect(panelGroup("design").api.isVisible).toBe(false);
    expect(panelGroup("preview").api.isVisible).toBe(true);
  });

  it("refuses when a Story panel is closed", () => {
    const story = api.getPanel("story");
    if (story) api.removePanel(story);
    expect(arrangeStory(api, DEFAULT_STORY_RATIOS)).toBeNull();
  });
});

describe("restoreEdit", () => {
  function roundTrip(): "moved" | "rebuilt" {
    const edit = api.toJSON();
    const created = arrangeStory(api, DEFAULT_STORY_RATIOS);
    if (!created) throw new Error("the Story panels are all open");
    return restoreEdit(api, edit, created);
  }

  it("gives back the Edit layout by moving panels: same groups, sizes and tab order", () => {
    const before = geometry();
    const groups = groupsOf();
    expect(roundTrip()).toBe("moved");
    expect(groupsOf()).toEqual(groups);
    expect(geometry()).toEqual(before);
  });

  it("brings a user-resized Edit layout back exactly", () => {
    panelGroup("chat").api.setSize({ width: 260 });
    panelGroup("design").api.setSize({ width: 300 });
    panelGroup("timeline").api.setSize({ height: 210 });
    const edit: SerializedDockview = api.toJSON();
    const before = geometry();
    expect(roundTrip()).toBe("moved");
    expect(geometry()).toEqual(before);
    expect(sameStructure(api.toJSON(), edit)).toBe(true);
  });

  it("keeps a group the user had hidden hidden, and shows the rest", () => {
    panelGroup("design").api.setVisible(false);
    expect(roundTrip()).toBe("moved");
    expect(panelGroup("design").api.isVisible).toBe(false);
    expect(panelGroup("chat").api.isVisible).toBe(true);
    expect(panelGroup("timeline").api.isVisible).toBe(true);
  });

  it("does not remount any panel body, including the preview's", () => {
    const previewBody = bodies.get("preview");
    roundTrip();
    expect(disposed).toEqual([]);
    expect(bodies.get("preview")).toBe(previewBody);
    for (const count of mounted.values()) expect(count).toBe(1);
  });

  it("restores the tab order and the shown tabs of a customised layout", () => {
    const assets = api.getPanel("assets");
    const chat = api.getPanel("chat");
    if (!assets || !chat) throw new Error("default layout is missing panels");
    assets.api.moveTo({ group: chat.group, position: "center", index: 0 });
    api.getPanel("code")?.api.setActive();
    const before = groupsOf();
    expect(roundTrip()).toBe("moved");
    expect(groupsOf()).toEqual(before);
    expect(panelGroup("code").activePanel?.id).toBe("code");
  });

  it("recreates a group that held only Story panels, beside its old neighbour", () => {
    const chat = api.getPanel("chat");
    const compositions = api.getPanel("compositions");
    if (!chat || !compositions) throw new Error("default layout is missing panels");
    // Chat alone in the left column: leaving it empties that group once Story takes Chat away.
    const own = api.addGroup({ referencePanel: "compositions", direction: "left" });
    chat.api.moveTo({ group: own, position: "center" });
    const before = groupsOf();
    expect(roundTrip()).toBe("moved");
    expect(groupsOf()).toEqual(before);
    expect(panelGroup("chat")).not.toBe(panelGroup("compositions"));
  });

  it("brings a panel back that was closed in Story", () => {
    const edit = api.toJSON();
    const created = arrangeStory(api, DEFAULT_STORY_RATIOS);
    const media = api.getPanel("media");
    if (media) api.removePanel(media);
    restoreEdit(api, edit, created ?? new Set());
    expect(panelGroup("media")).toBe(panelGroup("preview"));
  });

  it("drops a panel the stored Edit layout never had", () => {
    const story = api.getPanel("story");
    if (story) api.removePanel(story);
    const edit = api.toJSON();
    addRegisteredPanel(api, "story", { referencePanel: "preview", direction: "within" });
    const created = arrangeStory(api, DEFAULT_STORY_RATIOS);
    restoreEdit(api, edit, created ?? new Set());
    expect(api.getPanel("story")).toBeUndefined();
    expect(sameStructure(api.toJSON(), edit)).toBe(true);
  });

  it("falls back to rebuilding from the stored layout when moves cannot reproduce it", () => {
    const edit = api.toJSON();
    const created = arrangeStory(api, DEFAULT_STORY_RATIOS) ?? new Set<string>();
    // Scramble the stored structure so no live group can host its leaves.
    const scrambled: SerializedDockview = JSON.parse(JSON.stringify(edit));
    const reverseFirstSplit = (node: SerializedDockview["grid"]["root"]): boolean => {
      if (node.type !== "branch" || !Array.isArray(node.data)) return false;
      if (node.data.length > 1) {
        node.data.reverse();
        return true;
      }
      return node.data.some(reverseFirstSplit);
    };
    expect(reverseFirstSplit(scrambled.grid.root)).toBe(true);
    expect(restoreEdit(api, scrambled, created)).toBe("rebuilt");
    expect(sameStructure(api.toJSON(), scrambled)).toBe(true);
  });
});

describe("storyPlacement", () => {
  it("reopens Chat first beside Media, Media beside Chat, Story under the preview", () => {
    arrangeStory(api, DEFAULT_STORY_RATIOS);
    for (const id of ["chat", "media", "story", "preview"] as const) {
      const panel = api.getPanel(id);
      if (panel) api.removePanel(panel);
    }
    addRegisteredPanel(api, "preview");
    addRegisteredPanel(api, "story");
    expect(storyPlacement(api, "story")).toEqual({ referencePanel: "preview", direction: "below" });
    expect(storyPlacement(api, "media")).toBeUndefined();
    addRegisteredPanel(api, "media");
    expect(storyPlacement(api, "chat")).toEqual({
      referencePanel: "media",
      direction: "within",
      index: 0,
    });
  });
});
