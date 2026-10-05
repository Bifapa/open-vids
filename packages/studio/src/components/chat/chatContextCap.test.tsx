// @vitest-environment happy-dom

import { afterEach, expect, it } from "vitest";
import { LIMITS } from "@hyperframes/agent-protocol";
import { chatState } from "../../agent/agentTestHarness";
import { usePlayerStore, type TimelineElement } from "../../player";
import { mountChat, unmountChat, type Mounted } from "./chatTestHarness";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
  usePlayerStore.setState({ elements: [] });
});

function timelineOf(count: number): TimelineElement[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `clip-${index}`,
    tag: "div",
    start: index,
    duration: 1,
    track: index % 4,
  }));
}

const note = () => mounted?.host.querySelector('[data-testid="composer-context-cap"]');

it("tells the user when a long timeline goes to the agent only in part", () => {
  const total = LIMITS.contextElements + 140;
  usePlayerStore.setState({ elements: timelineOf(total) });
  mounted = mountChat({ view: "chat", chatId: "c1", chat: chatState() });

  expect(note()?.textContent).toBe(
    `Only the first ${LIMITS.contextElements} of ${total} timeline clips go with your message; the agent reads the rest from the timeline itself.`,
  );
  // The note is not a chip: nothing to remove, no empty chip list.
  expect(mounted.host.querySelector('[data-testid="composer-context"]')).toBeNull();
});

it("says nothing while the whole timeline goes along", () => {
  usePlayerStore.setState({ elements: timelineOf(LIMITS.contextElements) });
  mounted = mountChat({ view: "chat", chatId: "c1", chat: chatState() });

  expect(note()).toBeNull();
});
