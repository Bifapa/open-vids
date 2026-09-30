// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioStoryStore } from "../story/storyContext";
import { sampleGraph } from "../story/storyTestHarness";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { dispatchStoryHistoryKey } from "./appHotkeysDispatch";

function keydown(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const before = sampleGraph();
const after = { ...before, title: "After a manual edit" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 500 })),
  );
  document.body.innerHTML = `
    <div data-studio-story data-keyboard-owner tabindex="-1">
      <div id="canvas" tabindex="0"></div>
      <input id="field" />
    </div>
    <div id="elsewhere" tabindex="0"></div>`;
  studioStoryStore.setState({
    projectId: "p1",
    status: "ready",
    graph: after,
    past: [before],
    future: [],
    agentBusy: false,
  });
  useDockLayoutStore.setState({ visiblePanels: new Set(["story", "timeline"]) });
});

afterEach(() => {
  studioStoryStore.getState().dispose();
  studioStoryStore.setState({ projectId: null, graph: null, past: [], future: [] });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const byId = (id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no #${id}`);
  return element;
};

describe("⌘Z in the Story panel", () => {
  it("undoes and redoes the story's manual edit instead of file history", () => {
    const undo = keydown(byId("canvas"), { key: "z", metaKey: true });
    expect(dispatchStoryHistoryKey(undo)).toBe(true);
    expect(undo.defaultPrevented).toBe(true);
    expect(studioStoryStore.getState().graph).toBe(before);

    const redo = keydown(byId("canvas"), { key: "z", metaKey: true, shiftKey: true });
    expect(dispatchStoryHistoryKey(redo)).toBe(true);
    expect(studioStoryStore.getState().graph).toBe(after);
  });

  it("leaves a text field its own undo, and keys outside the panel to the editor", () => {
    expect(dispatchStoryHistoryKey(keydown(byId("field"), { key: "z", metaKey: true }))).toBe(
      false,
    );
    expect(dispatchStoryHistoryKey(keydown(byId("elsewhere"), { key: "z", metaKey: true }))).toBe(
      false,
    );
    expect(studioStoryStore.getState().graph).toBe(after);
  });

  it("does not claim the key when the Story panel is not showing", () => {
    useDockLayoutStore.setState({ visiblePanels: new Set(["preview"]) });
    expect(dispatchStoryHistoryKey(keydown(byId("canvas"), { key: "z", metaKey: true }))).toBe(
      false,
    );
  });
});
