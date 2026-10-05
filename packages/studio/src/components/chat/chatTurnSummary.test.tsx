// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, expect, it } from "vitest";
import type { TurnCheckpoint, TurnSummary } from "@hyperframes/agent-protocol";
import {
  assistantMessage,
  chatEvent,
  chatState,
  summary,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import { buttonWithText, mountChat, unmountChat, type Mounted } from "./chatTestHarness";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
});

function finishedTurn(checkpoint: TurnCheckpoint, extra: Partial<TurnSummary> = {}) {
  const chat = chatState({
    chat: summary({ status: "completed" }),
    messages: [userMessage(), assistantMessage({ status: "complete" })],
    turns: [turn({ status: "completed", endedAt: 9000, checkpoint, ...extra })],
    lastSeq: 5,
  });
  mounted = mountChat({ view: "chat", chatId: "c1", chat }, { chat });
  return mounted;
}

const ready: TurnCheckpoint = { status: "ready", entryIds: ["e1"], createdAt: 1 };
const changes = (host: ParentNode) => host.querySelector('[data-testid="turn-changes"]');
const kinds = (host: ParentNode) =>
  [...(changes(host)?.querySelectorAll("[data-change-kind]") ?? [])].map((item) => [
    item.getAttribute("data-change-kind"),
    item.textContent,
  ]);

it("lists what a revertible turn changed, by kind", () => {
  const { host } = finishedTurn(ready, {
    changes: [
      { kind: "add_clip", count: 3 },
      { kind: "captions", count: 1 },
      { kind: "rough_cut", count: 1 },
      { kind: "a_kind_from_a_newer_runtime", count: 2 },
    ],
  });

  expect(kinds(host)).toEqual([
    ["add_clip", "Clips added: 3"],
    ["captions", "Captions: 1"],
    ["rough_cut", "Rough cuts: 1"],
    ["a_kind_from_a_newer_runtime", "Other changes: 2"],
  ]);
  expect(changes(host)?.getAttribute("aria-label")).toBe("What this turn changed");
  expect(buttonWithText(host, "Revert this turn")).not.toBeNull();
});

it("shows no list for a turn without a change summary", () => {
  const { host } = finishedTurn(ready);
  expect(changes(host)).toBeNull();

  unmountChat(mounted);
  const empty = finishedTurn(ready, { changes: [] });
  expect(changes(empty.host)).toBeNull();
});

it("keeps Revert in view, disabled with the reason, while the turn's history is still closing", async () => {
  const { host, store, sources } = finishedTurn({
    status: "active",
    entryIds: ["e1"],
    createdAt: 1,
  });

  const revert = buttonWithText(host, "Revert this turn");
  expect(revert?.disabled).toBe(true);
  expect(host.querySelector('[data-testid="blocked-reason"]')?.textContent).toBe(
    "Saving this run's changes for Revert — it unlocks when the project history catches up.",
  );

  // Once the runtime closes the checkpoint the same row becomes the working button.
  await act(async () => {
    await store.getState().openChat("c1");
  });
  const stream = sources.latest("/chats/c1/events");
  await act(async () => {
    stream.open();
    stream.emit(
      "chat",
      chatEvent(6, { type: "checkpoint.updated", turnId: "t1", checkpoint: ready }),
    );
  });
  expect(buttonWithText(host, "Revert this turn")?.disabled).toBe(false);
  expect(host.querySelector('[data-testid="blocked-reason"]')).toBeNull();
});
