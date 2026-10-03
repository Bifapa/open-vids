// @vitest-environment happy-dom

import { createDockview, type DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStudioUiPreferences } from "../../utils/studioUiPreferences";
import { createDockArrangement, type DockArrangement } from "./dockArrangement";
import { addRegisteredPanel, buildEditLayout } from "./dockLayout";
import { DEFAULT_STORY_RATIOS, sameStructure } from "./dockWorkspace";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

let api: DockviewApi;
let arrangement: DockArrangement;
const onChange = vi.fn();
const stored = () => readStudioUiPreferences(undefined, "p1");

function mountArrangement() {
  arrangement = createDockArrangement(api, "p1", {
    openPanel: (id) =>
      addRegisteredPanel(api, id, { referencePanel: "preview", direction: "within" }),
    onChange,
  });
}

beforeEach(() => {
  localStorage.clear();
  onChange.mockClear();
  const host = document.createElement("div");
  document.body.append(host);
  api = createDockview(host, {
    createComponent: () => ({ element: document.createElement("div"), init() {}, dispose() {} }),
  });
  api.layout(1400, 800);
  buildEditLayout(api, 1400);
  mountArrangement();
});

afterEach(() => {
  api.dispose();
  document.body.innerHTML = "";
});

describe("dock arrangement", () => {
  it("keeps the Edit layout as the stored dock layout while Story is shown, and persists only Story's splits", () => {
    api.getPanel("chat")?.group.api.setSize({ width: 300 });
    const edit = api.toJSON();
    arrangement.enterStory();

    expect(arrangement.current()).toBe("story");
    expect(stored().dockWorkspace).toBe("story");
    expect(sameStructure(stored().dockLayout ?? edit, edit)).toBe(true);

    api.getPanel("chat")?.group.api.setSize({ width: 700 });
    arrangement.save();
    expect(stored().storyLayout?.left).toBeCloseTo(0.5, 1);
    expect(sameStructure(stored().dockLayout ?? edit, edit)).toBe(true);
  });

  it("returns to the user's resized Edit layout and remembers it as Edit", () => {
    api.getPanel("chat")?.group.api.setSize({ width: 300 });
    api.getPanel("timeline")?.group.api.setSize({ height: 200 });
    const chatWidth = api.getPanel("chat")?.group.width;
    const timelineHeight = api.getPanel("timeline")?.group.height;
    arrangement.enterStory();
    arrangement.leaveStory();

    expect(arrangement.current()).toBe("edit");
    expect(stored().dockWorkspace).toBe("edit");
    expect(api.getPanel("chat")?.group.width).toBe(chatWidth);
    expect(api.getPanel("timeline")?.group.height).toBe(timelineHeight);
  });

  it("reopens Story with the splits it was left with", () => {
    arrangement.enterStory();
    api.getPanel("chat")?.group.api.setSize({ width: 840 });
    arrangement.leaveStory();
    arrangement.enterStory();
    expect(api.getPanel("chat")?.group.width).toBe(840);
  });

  it("opens Story panels the Edit layout had closed, and closes them again on the way back", () => {
    const story = api.getPanel("story");
    if (story) api.removePanel(story);
    arrangement.enterStory();
    expect(arrangement.current()).toBe("story");
    expect(api.getPanel("story")).toBeDefined();
    arrangement.leaveStory();
    expect(api.getPanel("story")).toBeUndefined();
    expect(stored().dockLayout?.panels).not.toHaveProperty("story");
  });

  it("does nothing when asked to enter Story twice or leave Edit", () => {
    arrangement.leaveStory();
    expect(onChange).not.toHaveBeenCalled();
    arrangement.enterStory();
    arrangement.enterStory();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("resets Story to its default splits and Edit to the default layout", () => {
    arrangement.enterStory();
    api.getPanel("chat")?.group.api.setSize({ width: 840 });
    arrangement.reset();
    expect(arrangement.current()).toBe("story");
    expect(api.getPanel("chat")?.group.width).toBe(
      Math.round(api.width * DEFAULT_STORY_RATIOS.left),
    );
    expect(stored().storyLayout).toBeUndefined();

    arrangement.leaveStory();
    api.getPanel("timeline")?.group.api.setSize({ height: 150 });
    arrangement.reset();
    expect(api.getPanel("timeline")?.group.height).toBe(360);
  });

  it("writes nothing while panels are moving, whatever the dock reports", () => {
    let writes = -1;
    const probe = createDockArrangement(api, "p1", {
      openPanel: () => {},
      onChange: () => {},
    });
    localStorage.clear();
    api.onDidMovePanel(() => {
      if (writes < 0) writes = localStorage.length;
      probe.save();
      writes = Math.max(writes, localStorage.length);
    });
    probe.enterStory();
    expect(writes).toBe(0);
  });
});
