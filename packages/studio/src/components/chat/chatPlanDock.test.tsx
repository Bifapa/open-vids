// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatEventPayload,
  ChatState,
  ExecutionPlan,
  PlanStepStatus,
  TurnSummary,
} from "@hyperframes/agent-protocol";
import {
  ACTIVE,
  agentRun,
  assistantMessage,
  chatEvent,
  chatState,
  runReply,
  summary,
  taskMessage,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import { buttonWithText, click, mountChat, unmountChat, type Mounted } from "./chatTestHarness";
import { statusSentence } from "./ChatView";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
});

const TITLES = ["Cut the intro", "Add captions", "Render the teaser"];

const plan = (statuses: PlanStepStatus[], extra: Partial<ExecutionPlan> = {}): ExecutionPlan => ({
  steps: statuses.map((status, index) => ({
    id: `s${index + 1}`,
    title: TITLES[index] ?? `Step ${index + 1}`,
    status,
    agent: null,
  })),
  updatedAt: 1,
  ...extra,
});

/** A chat whose only turn is running, with `turnPlan` (none yet when undefined). */
const runningChat = (turnPlan?: ExecutionPlan): ChatState =>
  chatState({
    chat: summary({ status: "working" }),
    messages: [userMessage(), assistantMessage()],
    turns: [turn(turnPlan ? { plan: turnPlan } : {})],
    lastSeq: 2,
  });

const proposal = (id: string, n: number, overrides: Partial<TurnSummary> = {}) =>
  turn({
    id,
    promptMessageId: `m${n}`,
    assistantMessageId: `m${n + 1}`,
    status: "completed",
    endedAt: 9000,
    plan: plan(["pending", "pending"], { proposal: true }),
    ...overrides,
  });

/** A finished chat with these turns, a prompt and a reply for each. */
const finishedChat = (turns: TurnSummary[]): ChatState =>
  chatState({
    chat: summary({ status: "completed" }),
    turns,
    messages: turns.flatMap((each) => [
      userMessage(each.promptMessageId, "Make a teaser", each.id),
      assistantMessage({ id: each.assistantMessageId, turnId: each.id, status: "complete" }),
    ]),
  });

const open = (chat: ChatState, extra: Partial<Parameters<typeof mountChat>[0]> = {}) => {
  mounted = mountChat({ view: "chat", chatId: "c1", chat, ...extra });
  return mounted;
};

const dock = () => document.body.querySelector<HTMLElement>('[data-testid="plan-dock"]');
const dockStep = () => dock()?.querySelector('[data-testid="plan-dock-step"]')?.textContent;
const toggle = () => dock()?.querySelector<HTMLButtonElement>("button[aria-expanded]");
const feedPlans = () => document.body.querySelectorAll('[role="log"] [data-testid="turn-plan"]');
const stepStatuses = (root: ParentNode | null | undefined) =>
  [...(root?.querySelectorAll("[data-step-status]") ?? [])].map((step) =>
    step.getAttribute("data-step-status"),
  );

describe("the plan dock of a running turn", () => {
  it("pins the plan above the conversation as one line: the step the Director is on", () => {
    open(runningChat(plan(["done", "running", "pending"])));
    expect(dockStep()).toBe("Step 2 of 3 · Add captions");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(stepStatuses(dock())).toEqual([]);

    // Above the conversation, not inside it.
    const log = document.body.querySelector('[role="log"]');
    expect(dock()?.compareDocumentPosition(log ?? document)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // Not drawn a second time in the feed.
    expect(feedPlans()).toHaveLength(0);
  });

  it("opens into the list of steps and folds back", async () => {
    open(runningChat(plan(["done", "running", "pending"])));
    await click(toggle());
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(stepStatuses(dock())).toEqual(["done", "running", "pending"]);
    const listId = toggle()?.getAttribute("aria-controls") ?? "";
    expect(dock()?.contains(document.getElementById(listId))).toBe(true);

    await click(toggle());
    expect(stepStatuses(dock())).toEqual([]);
  });

  it("names the plan and counts what is reached when no step is running", () => {
    open(runningChat(plan(["done", "pending", "pending"])));
    expect(dockStep()).toBeUndefined();
    expect(toggle()?.textContent).toContain("Plan");
    expect(toggle()?.textContent).toContain("1 of 3");
  });

  it("shows nothing for a running turn that has no plan yet, or no steps in it", () => {
    open(runningChat());
    expect(dock()).toBeNull();
    unmountChat(mounted);

    open(runningChat(plan([])));
    expect(dock()).toBeNull();
    expect(feedPlans()).toHaveLength(0);
  });

  it("follows the turn: appears with the plan, tracks the step, leaves when the turn ends and the plan stays folded in the feed", async () => {
    mounted = mountChat({}, { chat: chatState() });
    const { store, sources } = mounted;
    await act(async () => {
      await store.getState().openChat("c1");
    });
    const stream = sources.latest("/chats/c1/events");
    let seq = 0;
    const emit = async (payloads: ChatEventPayload[]) => {
      await act(async () => {
        stream.open();
        for (const payload of payloads) stream.emit("chat", chatEvent((seq += 1), payload));
      });
    };

    await emit([
      {
        type: "turn.started",
        turn: turn(),
        promptMessage: userMessage(),
        assistantMessage: assistantMessage(),
      },
    ]);
    expect(dock()).toBeNull();

    await emit([
      { type: "plan.updated", turnId: "t1", plan: plan(["running", "pending", "pending"]) },
    ]);
    expect(dockStep()).toBe("Step 1 of 3 · Cut the intro");

    await emit([
      { type: "plan.updated", turnId: "t1", plan: plan(["done", "running", "pending"]) },
    ]);
    expect(dockStep()).toBe("Step 2 of 3 · Add captions");
    expect(feedPlans()).toHaveLength(0);

    await emit([
      { type: "plan.updated", turnId: "t1", plan: plan(["done", "done", "done"]) },
      { type: "turn.completed", turn: turn({ status: "completed", endedAt: 9000 }) },
    ]);
    expect(dock()).toBeNull();
    expect(feedPlans()).toHaveLength(1);
    const folded = feedPlans()[0];
    expect(folded?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
    expect(folded?.textContent).toContain("3 of 3");
    expect(stepStatuses(folded)).toEqual([]);
  });
});

describe("the open or folded choice", () => {
  it("is kept per turn in the store and survives the dock leaving the screen", async () => {
    const run = agentRun({ id: "r1", agent: "editor" });
    const base = runningChat(plan(["running", "pending"]));
    const chat: ChatState = {
      ...base,
      runs: [run],
      messages: [...base.messages, taskMessage(run, "Cut the intro"), runReply(run)],
    };
    const { store } = open(chat);

    await click(toggle());
    expect(store.getState().planOpen).toEqual({ t1: true });

    // A subagent's thread has no dock; back in Main the plan is still open.
    await act(async () => store.getState().selectThread("editor"));
    expect(document.body.querySelector('[role="log"]')?.getAttribute("data-thread")).toBe("editor");
    expect(dock()).toBeNull();
    await act(async () => store.getState().selectThread("main"));
    expect(stepStatuses(dock())).toEqual(["running", "pending"]);
  });

  it("goes with the plan from the dock into the feed, and is the user's to change there", async () => {
    const { store } = open(runningChat(plan(["running", "pending"])));
    await click(toggle());

    const ended = chatState({
      chat: summary({ status: "completed" }),
      messages: [userMessage(), assistantMessage({ status: "complete" })],
      turns: [turn({ status: "completed", endedAt: 9000, plan: plan(["done", "done"]) })],
      lastSeq: 3,
    });
    await act(async () => store.setState({ chat: ended }));
    expect(dock()).toBeNull();
    const inFeed = feedPlans()[0];
    expect(inFeed?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    expect(stepStatuses(inFeed)).toEqual(["done", "done"]);

    await click(inFeed?.querySelector("button"));
    expect(store.getState().planOpen).toEqual({ t1: false });
    expect(stepStatuses(feedPlans()[0])).toEqual([]);
  });
});

describe("the plan dock of a proposal waiting for the user", () => {
  it("pins the proposal with its buttons and leaves it out of the feed", async () => {
    const { client } = open(finishedChat([proposal("t1", 1)]));
    expect(dock()?.getAttribute("data-turn-id")).toBe("t1");
    expect(toggle()?.textContent).toContain("2 steps");
    expect(feedPlans()).toHaveLength(0);
    expect(dock()?.contains(buttonWithText(document.body, "Carry out"))).toBe(true);
    expect(dock()?.contains(buttonWithText(document.body, "Change"))).toBe(true);

    await click(buttonWithText(document.body, "Carry out"));
    expect(client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ executePlan: { turnId: "t1" } }),
    );
  });

  it("hands the plan back to the feed, without buttons, once a later turn carried it out", () => {
    open(
      finishedChat([
        proposal("t1", 1),
        turn({
          id: "t2",
          promptMessageId: "m3",
          assistantMessageId: "m4",
          status: "completed",
          executedPlanTurnId: "t1",
        }),
      ]),
    );
    expect(dock()).toBeNull();
    expect(feedPlans()).toHaveLength(1);
    expect(buttonWithText(document.body, "Carry out")).toBeNull();
  });

  it("pins the newest of several waiting proposals; an older one keeps its own buttons in the feed", () => {
    open(finishedChat([proposal("t1", 1), proposal("t2", 3)]));
    expect(dock()?.getAttribute("data-turn-id")).toBe("t2");
    expect(feedPlans()).toHaveLength(1);
    expect(buttonWithText(dock() ?? document.body, "Carry out")?.textContent).toBe("Carry out");
    expect(buttonWithText(feedPlans()[0] ?? document.body, "Carry out")?.textContent).toBe(
      "Carry out anyway",
    );
  });

  it("keeps the waiting proposal pinned, buttons disabled, while a turn that has no plan yet runs", () => {
    open(
      chatState({
        ...finishedChat([proposal("t1", 1)]),
        chat: summary({ status: "working" }),
        turns: [
          proposal("t1", 1),
          turn({ id: "t2", promptMessageId: "m3", assistantMessageId: "m4" }),
        ],
        messages: [
          userMessage("m1", "Make a teaser", "t1"),
          assistantMessage({ id: "m2", turnId: "t1", status: "complete" }),
          userMessage("m3", "Make it shorter", "t2"),
          assistantMessage({ id: "m4", turnId: "t2" }),
        ],
      }),
      { activeTurn: { ...ACTIVE, turnId: "t2" } },
    );
    expect(dock()?.getAttribute("data-turn-id")).toBe("t1");
    expect(buttonWithText(document.body, "Carry out")?.disabled).toBe(true);
    expect(feedPlans()).toHaveLength(0);
  });

  it("gives way to the running turn's own plan, and the older proposal returns to the feed", () => {
    open(
      chatState({
        chat: summary({ status: "working" }),
        turns: [
          proposal("t1", 1),
          turn({
            id: "t2",
            promptMessageId: "m3",
            assistantMessageId: "m4",
            plan: plan(["running", "pending"]),
          }),
        ],
        messages: [
          userMessage("m1", "Make a teaser", "t1"),
          assistantMessage({ id: "m2", turnId: "t1", status: "complete" }),
          userMessage("m3", "Make it shorter", "t2"),
          assistantMessage({ id: "m4", turnId: "t2" }),
        ],
      }),
      { activeTurn: { ...ACTIVE, turnId: "t2" } },
    );
    expect(dock()?.getAttribute("data-turn-id")).toBe("t2");
    expect(dockStep()).toBe("Step 1 of 2 · Cut the intro");
    expect(feedPlans()).toHaveLength(1);
  });
});

describe("what the dock does not pin", () => {
  it("leaves the plan of a turn that ended in the feed", () => {
    open(
      finishedChat([turn({ status: "completed", endedAt: 9000, plan: plan(["done", "done"]) })]),
    );
    expect(dock()).toBeNull();
    expect(feedPlans()).toHaveLength(1);
  });

  it.each(["completed", "failed", "aborted"] as const)(
    "lets a proposal go once a later turn %s: it stays in the feed with its buttons",
    (status) => {
      open(
        finishedChat([
          proposal("t1", 1),
          turn({
            id: "t2",
            promptMessageId: "m3",
            assistantMessageId: "m4",
            status,
            endedAt: 9500,
          }),
        ]),
      );
      expect(dock()).toBeNull();
      expect(feedPlans()).toHaveLength(1);
      expect(feedPlans()[0]?.contains(buttonWithText(document.body, "Carry out anyway"))).toBe(
        true,
      );
    },
  );

  it("does not bring a proposal back when a later turn with a plan of its own ends", async () => {
    const t2 = { id: "t2", promptMessageId: "m3", assistantMessageId: "m4" };
    const { store } = open(
      chatState({
        chat: summary({ status: "working" }),
        turns: [proposal("t1", 1), turn({ ...t2, plan: plan(["running", "pending"]) })],
        messages: [
          userMessage("m1", "Make a teaser", "t1"),
          assistantMessage({ id: "m2", turnId: "t1", status: "complete" }),
          userMessage("m3", "Make it shorter", "t2"),
          assistantMessage({ id: "m4", turnId: "t2" }),
        ],
      }),
      { activeTurn: { ...ACTIVE, turnId: "t2" } },
    );
    expect(dock()?.getAttribute("data-turn-id")).toBe("t2");

    await act(async () =>
      store.setState({
        activeTurn: null,
        chat: finishedChat([
          proposal("t1", 1),
          turn({ ...t2, status: "completed", endedAt: 9500, plan: plan(["done", "done"]) }),
        ]),
      }),
    );
    // The turn ended, so the dock is gone — the old proposal does not take its place, it stays in the feed.
    expect(dock()).toBeNull();
    expect(feedPlans()).toHaveLength(2);
    expect(feedPlans()[0]?.contains(buttonWithText(document.body, "Carry out anyway"))).toBe(true);
  });
});

describe("the announcement for assistive tech", () => {
  it("says which plan step the Director is on, since nothing else announces it", () => {
    open(runningChat(plan(["done", "running", "pending"])));
    const announced = document.body.querySelector('div[role="status"][aria-live="polite"]');
    expect(announced?.textContent).toBe("Step 2 of 3 · Add captions");
    expect(statusSentence(runningChat(plan(["done", "running", "pending"])))).toBe(
      "Step 2 of 3 · Add captions",
    );
  });

  it("prefers the activity in progress to the plan step, and says the agent is working with neither", () => {
    const base = runningChat(plan(["running", "pending"]));
    const withActivity: ChatState = {
      ...base,
      messages: [
        userMessage(),
        assistantMessage({
          parts: [
            {
              type: "activity",
              id: "a1",
              activity: {
                id: "a1",
                category: "edit",
                status: "running",
                label: "Editing scenes/intro.html",
                count: 1,
                targets: ["scenes/intro.html"],
                startedAt: 5000,
              },
            },
          ],
        }),
      ],
    };
    expect(statusSentence(withActivity)).toBe("Editing scenes/intro.html");
    expect(statusSentence(runningChat(plan(["done", "pending"])))).toBe("The agent is working");
    expect(statusSentence(runningChat())).toBe("The agent is working");
  });
});
