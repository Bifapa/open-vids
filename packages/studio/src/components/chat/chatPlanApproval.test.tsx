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
  it("shows Carry out / Change on the latest finished proposal, and both act", async () => {
    mounted = mountChat({ view: "chat", chatId: "c1", chat: state([proposalTurn()]) });
    expect(buttonWithText(mounted.host, "Carry out")).not.toBeNull();
    expect(buttonWithText(mounted.host, "Change")).not.toBeNull();

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

  it("hides the buttons unless the proposal is the last turn, finished, with no turn running", async () => {
    // A newer turn ran: the old proposal is stale.
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: state([
        proposalTurn(),
        turn({ id: "t2", promptMessageId: "m3", assistantMessageId: "m4", status: "completed" }),
      ]),
    });
    expect(buttonWithText(mounted.host, "Carry out")).toBeNull();
    unmountChat(mounted);

    // The proposal turn is still running: nothing to approve yet.
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: state([proposalTurn({ status: "running", endedAt: undefined })]),
    });
    expect(buttonWithText(mounted.host, "Carry out")).toBeNull();
    unmountChat(mounted);

    // A turn is running in the project.
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      activeTurn: ACTIVE,
      chat: state([proposalTurn()]),
    });
    expect(buttonWithText(mounted.host, "Carry out")).toBeNull();
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
