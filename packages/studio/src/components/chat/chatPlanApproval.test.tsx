// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { TurnSummary } from "@hyperframes/agent-protocol";
import {
  ACTIVE,
  assistantMessage,
  chatState,
  summary,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import { buttonWithText, click, mountChat, unmountChat, type Mounted } from "./chatTestHarness";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
});

const proposalTurn = (overrides: Partial<TurnSummary> = {}) =>
  turn({
    status: "completed",
    endedAt: 9000,
    plan: {
      steps: [
        { id: "s1", title: "Build the intro", status: "pending", agent: "motion" },
        { id: "s2", title: "Cut the three moments", status: "pending", agent: null },
      ],
      updatedAt: 8000,
      proposal: true,
    },
    ...overrides,
  });

const dock = () => document.body.querySelector<HTMLElement>('[data-testid="plan-dock"]');
const feedPlans = () => document.body.querySelectorAll('[role="log"] [data-testid="turn-plan"]');

const state = (turns: TurnSummary[]) =>
  chatState({
    chat: summary({ status: "completed" }),
    turns,
    messages: [
      userMessage("m1", "Make a teaser", "t1"),
      assistantMessage({ id: "m2", turnId: "t1", status: "complete" }),
    ],
  });

describe("plan approval", () => {
  it("pins Carry out / Change under the latest finished proposal, and both act", async () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: state([proposalTurn()]) });
    // The buttons live in the plan dock; the feed does not draw the proposal's plan a second time.
    expect(dock()?.contains(buttonWithText(mounted.host, "Carry out"))).toBe(true);
    expect(dock()?.contains(buttonWithText(mounted.host, "Change"))).toBe(true);
    expect(feedPlans()).toHaveLength(0);

    await click(buttonWithText(mounted.host, "Change"));
    expect(document.activeElement).toBe(mounted.host.querySelector("textarea"));

    await click(buttonWithText(mounted.host, "Carry out"));
    expect(mounted.client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        prompt: "Carry out the plan",
        executePlan: { turnId: "t1" },
      }),
    );
    // The store asks for the turn; its own snapshot refresh must not throw the approval away.
    expect(mounted.client.startTurn).toHaveBeenCalledTimes(1);
  });

  it("pre-fills the box when Change is clicked, and never over a draft", async () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: state([proposalTurn()]) });
    await click(buttonWithText(mounted.host, "Change"));
    expect(mounted.store.getState().drafts.c1).toBe("Change the plan: ");
    expect(document.activeElement).toBe(mounted.host.querySelector("textarea"));
    unmountChat(mounted);

    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      drafts: { c1: "Make it shorter" },
      chat: state([proposalTurn()]),
    });
    await click(buttonWithText(mounted.host, "Change"));
    expect(mounted.store.getState().drafts.c1).toBe("Make it shorter");
  });

  it("marks a proposal out of date once another turn ran: it stays in the feed, and still offers to carry it out", async () => {
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: state([
        proposalTurn(),
        turn({ id: "t2", promptMessageId: "m3", assistantMessageId: "m4", status: "completed" }),
      ]),
    });
    // A turn ended after it: the dock lets go, the proposal keeps its buttons in the feed.
    expect(dock()).toBeNull();
    expect(feedPlans()).toHaveLength(1);
    expect(feedPlans()[0]?.contains(buttonWithText(mounted.host, "Carry out anyway"))).toBe(true);
    expect(mounted.host.querySelector('[data-testid="plan-stale"]')?.textContent).toContain(
      "out of date",
    );
    expect(buttonWithText(mounted.host, "Carry out")?.textContent).toBe("Carry out anyway");

    await click(buttonWithText(mounted.host, "Carry out anyway"));
    expect(mounted.client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ executePlan: { turnId: "t1" } }),
    );
  });

  it("does not call a carried-out proposal out of date", async () => {
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: chatState({
        chat: summary({ status: "completed" }),
        turns: [
          proposalTurn(),
          turn({
            id: "t2",
            promptMessageId: "m3",
            assistantMessageId: "m4",
            status: "completed",
            executedPlanTurnId: "t1",
          }),
        ],
        messages: [
          userMessage("m1", "Make a teaser", "t1"),
          assistantMessage({ id: "m2", turnId: "t1", status: "complete" }),
          userMessage("m3", "Carry out the plan", "t2"),
          assistantMessage({ id: "m4", turnId: "t2", status: "complete" }),
        ],
      }),
    });
    expect(mounted.host.querySelector('[data-testid="plan-stale"]')).toBeNull();
    expect(buttonWithText(mounted.host, "Carry out")).toBeNull();
  });

  it("attributes an execution to the plan it names, not to the proposal just before it", async () => {
    // t1 proposes A, t2 proposes B (the user changed their mind), t3 carries out A.
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: chatState({
        chat: summary({ status: "completed" }),
        turns: [
          proposalTurn(),
          proposalTurn({ id: "t2", promptMessageId: "m3", assistantMessageId: "m4" }),
          turn({
            id: "t3",
            promptMessageId: "m5",
            assistantMessageId: "m6",
            status: "completed",
            executedPlanTurnId: "t1",
          }),
        ],
        messages: [
          userMessage("m1", "Make a teaser", "t1"),
          assistantMessage({ id: "m2", turnId: "t1", status: "complete" }),
          userMessage("m3", "Make it shorter", "t2"),
          assistantMessage({ id: "m4", turnId: "t2", status: "complete" }),
          userMessage("m5", "Carry out the plan", "t3"),
          assistantMessage({ id: "m6", turnId: "t3", status: "complete" }),
        ],
      }),
    });
    // Nothing is current: A was carried out (folded in the feed, no buttons) and B, out of date since turn 3 ended,
    // keeps its own buttons in the feed. The dock pins no proposal that a later turn has outdated.
    expect(dock()).toBeNull();
    expect(feedPlans()).toHaveLength(2);
    expect(mounted.host.querySelectorAll('[data-testid="plan-stale"]')).toHaveLength(1);
    expect(buttonWithText(feedPlans()[0] ?? document.body, "Carry out")).toBeNull();
    expect(feedPlans()[1]?.contains(buttonWithText(mounted.host, "Carry out anyway"))).toBe(true);
    await click(buttonWithText(mounted.host, "Carry out anyway"));
    expect(mounted.client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ executePlan: { turnId: "t2" } }),
    );
  });

  it("never reads a hand-typed 'Carry out the plan' as an execution", async () => {
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: chatState({
        chat: summary({ status: "completed" }),
        turns: [
          proposalTurn(),
          turn({ id: "t2", promptMessageId: "m3", assistantMessageId: "m4", status: "completed" }),
        ],
        messages: [
          userMessage("m1", "Make a teaser", "t1"),
          assistantMessage({ id: "m2", turnId: "t1", status: "complete" }),
          userMessage("m3", "Carry out the plan", "t2"),
          assistantMessage({ id: "m4", turnId: "t2", status: "complete" }),
        ],
      }),
    });
    // The proposal still waits, in the feed: the typed message carried nothing out.
    expect(dock()).toBeNull();
    expect(buttonWithText(mounted.host, "Carry out anyway")).not.toBeNull();
  });

  it("offers nothing while the proposal turn itself is still running", async () => {
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: state([proposalTurn({ status: "running", endedAt: undefined })]),
    });
    expect(buttonWithText(mounted.host, "Carry out")).toBeNull();
    // Its plan is pinned like any running turn's, as a progress plan without a decision to make.
    expect(dock()?.getAttribute("data-turn-id")).toBe("t1");
  });

  it("disables the buttons while a turn runs in the project, and says why", async () => {
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      activeTurn: ACTIVE,
      chat: state([proposalTurn()]),
    });
    expect(buttonWithText(mounted.host, "Carry out")?.disabled).toBe(true);
    expect(buttonWithText(mounted.host, "Change")?.disabled).toBe(true);
    expect(dock()?.querySelector('[data-testid="plan-blocked"]')?.textContent).toBe(
      "Wait for the agent to finish first.",
    );
  });

  it("shows no buttons for an ordinary progress plan", async () => {
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: state([
        proposalTurn({
          plan: {
            steps: [{ id: "s1", title: "Build the intro", status: "done", agent: "motion" }],
            updatedAt: 8000,
          },
        }),
      ]),
    });
    expect(buttonWithText(mounted.host, "Carry out")).toBeNull();
  });
});
