// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, expect, it } from "vitest";
import type { ChatEventPayload, ExecutionPlan } from "@hyperframes/agent-protocol";
import {
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

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
});

const plan = (first: "running" | "done", second: "pending" | "failed"): ExecutionPlan => ({
  steps: [
    { id: "s1", title: "Trim the intro", status: first, agent: "editor" },
    { id: "s2", title: "Check the title card", status: second, agent: "vision" },
  ],
  updatedAt: 1,
});

it("folds a delegated turn: Main keeps the plan and one row per delegation, a crumb opens that agent's work", async () => {
  mounted = mountChat(
    {},
    { chat: chatState({ chat: summary({ enabledAgents: ["editor", "vision"] }) }) },
  );
  const { host, store, sources } = mounted;
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

  const editor = agentRun({ id: "r1", agent: "editor", title: "Tighten the intro" });
  const vision = agentRun({
    id: "r2",
    agent: "vision",
    title: "Check legibility",
    status: "queued",
  });
  await emit([
    {
      type: "turn.started",
      turn: turn(),
      promptMessage: userMessage(),
      assistantMessage: assistantMessage(),
    },
    { type: "plan.updated", turnId: "t1", plan: plan("running", "pending") },
    {
      type: "agent.started",
      run: editor,
      parentMessageId: "m2",
      taskMessage: taskMessage(editor, "Cut the intro to three seconds."),
      assistantMessage: runReply(editor),
    },
    {
      type: "agent.started",
      run: vision,
      parentMessageId: "m2",
      taskMessage: taskMessage(vision, "Check the title card is legible."),
      assistantMessage: runReply(vision),
    },
    {
      type: "activity.updated",
      messageId: "r1-reply",
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
    { type: "assistant.text.delta", messageId: "r1-reply", partId: "x1", delta: "Cut to 3.0s." },
    { type: "agent.updated", run: { ...vision, status: "running" } },
  ]);

  const log = () => host.querySelector('[role="log"]');
  const rows = () => [...host.querySelectorAll('[data-testid="delegation-row"]')];
  const rowStatuses = () =>
    rows().map((row) => row.querySelector("[data-run-status]")?.getAttribute("data-run-status"));

  // Live: one row per delegation with its current step; the plan is open; the specialist's own words stay out.
  expect(rows().map((row) => row.getAttribute("data-run-id"))).toEqual(["r1", "r2"]);
  expect(rowStatuses()).toEqual(["running", "running"]);
  expect(rows()[0]?.querySelector('[data-testid="delegation-step"]')?.textContent).toBe(
    "Editing scenes/intro.html",
  );
  const livePlan = host.querySelector('[data-testid="turn-plan"]');
  expect(
    [...(livePlan?.querySelectorAll("[data-step-status]") ?? [])].map((step) =>
      step.getAttribute("data-step-status"),
    ),
  ).toEqual(["running", "pending"]);
  expect(log()?.textContent).not.toContain("Cut to 3.0s.");
  expect(log()?.textContent).not.toContain("Cut the intro to three seconds.");

  await emit([
    {
      type: "agent.completed",
      run: { ...editor, status: "completed", endedAt: 9000, summary: "The intro now runs 3 s." },
    },
    {
      type: "agent.completed",
      run: {
        ...vision,
        status: "failed",
        endedAt: 9500,
        error: { code: "agent_failed", message: "Frame 12 could not be read." },
      },
    },
    { type: "plan.updated", turnId: "t1", plan: plan("done", "failed") },
    { type: "turn.completed", turn: turn({ status: "completed", endedAt: 9900 }) },
  ]);

  // Finished: the rows carry the outcome, the plan folds to one line but stays attached to the turn.
  expect(rowStatuses()).toEqual(["completed", "failed"]);
  expect(rows()[0]?.querySelector('[data-testid="delegation-outcome"]')?.textContent).toBe(
    "The intro now runs 3 s.",
  );
  expect(rows()[1]?.querySelector('[data-testid="delegation-outcome"]')?.textContent).toBe(
    "Frame 12 could not be read.",
  );
  const donePlan = host.querySelector('[data-testid="turn-plan"]');
  expect(donePlan?.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
  expect(donePlan?.querySelector("[data-step-status]")).toBeNull();

  const nav = host.querySelector('nav[aria-label="Agent threads"]');
  if (!nav) throw new Error("no breadcrumbs");
  expect([...nav.querySelectorAll("button")].map((crumb) => crumb.textContent)).toEqual([
    "Main",
    "Editor",
    "Vision",
  ]);

  // A crumb opens the agent's thread: its task and its reply, nobody else's, no Main rows.
  await click(buttonWithText(nav, "Editor"));
  expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Editor");
  expect(log()?.textContent).toContain("Cut the intro to three seconds.");
  expect(log()?.textContent).toContain("Cut to 3.0s.");
  expect(log()?.textContent).not.toContain("Check the title card is legible.");
  expect(rows()).toHaveLength(0);

  // Main is the clean chat again; a delegation row opens its own agent's thread.
  await click(buttonWithText(nav, "Main"));
  expect(rows()).toHaveLength(2);
  await click(rows()[1]);
  expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Vision");
  expect(log()?.textContent).toContain("Check the title card is legible.");
  expect(log()?.textContent).toContain("Frame 12 could not be read.");
});
