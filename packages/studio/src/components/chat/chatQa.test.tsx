// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, expect, it } from "vitest";
import type { ChatEventPayload, QaReport, TurnQaState } from "@hyperframes/agent-protocol";
import {
  assistantMessage,
  chatEvent,
  chatState,
  qaIssue,
  qaPass,
  qaReport,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import { usePlayerStore } from "../../player/store/playerStore";
import { click, mountChat, unmountChat, type Mounted } from "./chatTestHarness";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
  usePlayerStore.getState().clearSeekRequest();
});

/** A finished turn whose QA ended as `qa` says. */
function finishedChat(qa: TurnQaState) {
  return chatState({
    messages: [userMessage(), assistantMessage({ status: "complete" })],
    turns: [
      turn({
        status: "completed",
        endedAt: 9000,
        checkpoint: { status: "ready", entryIds: ["e1"], createdAt: 3000 },
        qa,
      }),
    ],
  });
}

function mountQa(qa: TurnQaState, qaReports: Record<string, QaReport> = {}) {
  const chat = finishedChat(qa);
  mounted = mountChat({ view: "chat", chatId: "c1", chat }, { chat, qaReports });
  return mounted;
}

const card = () => document.body.querySelector('[data-testid="render-qa"]');
const status = () => card()?.querySelector('[data-testid="render-qa-status"]')?.textContent;
const passRow = (pass: number) => card()?.querySelector(`[data-qa-pass="${pass}"]`);
const counts = (pass: number) =>
  [...(passRow(pass)?.querySelectorAll("[data-qa-count]") ?? [])].map((chip) => chip.textContent);

async function expand(pass: number) {
  await click(passRow(pass)?.querySelector("button"));
  await act(async () => {});
}

// Pass 1 saw a black gap and a caption collision; the correction fixed the gap, left the caption and
// introduced wrong B-roll that Vision caught.
const blackGap = qaIssue({ id: "p1-1", status: "fixed" });
const caption = qaIssue({
  id: "p1-2",
  kind: "caption_collision",
  severity: "warning",
  source: "layout",
  check: "layout.content_overlap",
  start: 64.25,
  end: 66,
  owner: "motion",
  status: "persisting",
  message: "The caption covers the lower third.",
  suggestion: "Move the lower third up.",
});
const wrongBroll = qaIssue({
  id: "p2-1",
  kind: "incorrect_broll",
  severity: "warning",
  source: "vision",
  check: "vision",
  start: 20,
  end: 24.5,
  owner: "research",
  firstSeenPass: 2,
  message: "The B-roll shows a beach while the speaker talks about mountains.",
  suggestion: "Find mountain footage.",
});
const secondReport = qaReport({
  id: "qa-2",
  pass: 2,
  issues: [wrongBroll, caption],
  resolved: [blackGap],
  previousReportId: "qa-1",
});

const twoPasses: TurnQaState = {
  status: "issues_remain",
  preset: "balanced",
  passLimit: 2,
  reason: "The pass limit was reached.",
  passes: [
    qaPass({
      pass: 1,
      phase: "corrected",
      reportId: "qa-1",
      counts: {
        issues: 2,
        errors: 1,
        warnings: 1,
        fixable: 2,
        new: 2,
        persisting: 0,
        reappeared: 0,
        fixed: 0,
      },
    }),
    qaPass({
      pass: 2,
      phase: "done",
      reportId: "qa-2",
      renderPath: "renders/qa-t1-2.mp4",
      counts: secondReport.counts,
    }),
  ],
};

it("shows a two-pass turn with fixed and new issues, and opens the second pass's report", async () => {
  const { client } = mountQa(twoPasses, { "qa-2": secondReport });

  expect(card()?.getAttribute("data-qa-status")).toBe("issues_remain");
  expect(status()).toBe("Issues remain");
  expect(card()?.textContent).toContain("Balanced · up to 2 passes");
  expect(card()?.querySelector('[data-testid="render-qa-reason"]')?.textContent).toBe(
    "The pass limit was reached.",
  );
  expect(passRow(1)?.textContent).toContain("Corrected");
  expect(counts(1)).toEqual(["2 open issues", "2 new"]);
  expect(counts(2)).toEqual(["2 open issues", "1 fixed", "1 new", "1 persisting"]);
  const render = passRow(2)?.querySelector<HTMLAnchorElement>('[data-testid="qa-pass-render"]');
  expect(render?.getAttribute("href")).toBe("/api/projects/p1/renders/file/qa-t1-2.mp4");

  expect(client.getQaReport).not.toHaveBeenCalled();
  await expand(2);
  expect(client.getQaReport).toHaveBeenCalledWith("qa-2");

  const report = passRow(2)?.querySelector('[data-testid="qa-report"]');
  const groups = [...(report?.querySelectorAll("[data-issue-group]") ?? [])].map((group) => [
    group.getAttribute("data-issue-group"),
    [...group.querySelectorAll("[data-issue-id]")].map((issue) =>
      issue.getAttribute("data-issue-id"),
    ),
  ]);
  expect(groups).toEqual([
    ["new", ["p2-1"]],
    ["persisting", ["p1-2"]],
    ["fixed", ["p1-1"]],
  ]);

  const vision = report?.querySelector('[data-issue-id="p2-1"]')?.textContent ?? "";
  expect(vision).toContain("Wrong B-roll");
  expect(vision).toContain("Warning");
  expect(vision).toContain("00:20.0–00:24.5");
  expect(vision).toContain("Vision");
  expect(vision).not.toContain("deterministic");
  expect(vision).toContain("→ Research");
  expect(vision).toContain("Suggestion: Find mountain footage.");

  const layout = report?.querySelector('[data-issue-id="p1-2"]')?.textContent ?? "";
  expect(layout).toContain("Caption collision");
  expect(layout).toContain("01:04.3–01:06.0");
  expect(layout).toContain("Layout check (deterministic)");
  expect(layout).toContain("→ Motion Designer");
  expect(report?.querySelector('[data-testid="qa-report-outdated"]')).toBeNull();

  // A time range seeks the playhead there.
  await click(report?.querySelector('[data-issue-id="p1-2"] [data-testid="qa-issue-time"]'));
  expect(usePlayerStore.getState().requestedSeekTime).toBe(64.25);
});

it("follows a live QA session from qa.updated events", async () => {
  const chat = chatState({
    messages: [userMessage(), assistantMessage()],
    turns: [turn()],
  });
  mounted = mountChat({}, { chat });
  const { store, sources } = mounted;
  await act(async () => {
    await store.getState().openChat("c1");
  });
  const stream = sources.latest("/chats/c1/events");
  let seq = 0;
  const emit = async (payload: ChatEventPayload) => {
    await act(async () => {
      stream.open();
      stream.emit("chat", chatEvent((seq += 1), payload));
    });
  };
  const running = (phase: "rendering" | "reviewing"): TurnQaState => ({
    status: "running",
    preset: "fast",
    passLimit: 1,
    reason: null,
    passes: [qaPass({ phase, reportId: null, renderPath: null, endedAt: undefined })],
  });

  expect(card()).toBeNull();
  await emit({ type: "qa.updated", turnId: "t1", qa: running("rendering") });
  expect(status()).toBe("Checking");
  expect(card()?.textContent).toContain("Fast · up to 1 pass");
  expect(passRow(1)?.getAttribute("data-qa-phase")).toBe("rendering");
  expect(passRow(1)?.querySelector('[data-testid="qa-pass-phase"]')?.textContent).toBe(
    "Rendering…",
  );
  // No report yet: the pass cannot open.
  expect(passRow(1)?.querySelector("button")?.disabled).toBe(true);

  await emit({ type: "qa.updated", turnId: "t1", qa: running("reviewing") });
  expect(passRow(1)?.querySelector('[data-testid="qa-pass-phase"]')?.textContent).toBe(
    "Vision review…",
  );

  await emit({
    type: "qa.updated",
    turnId: "t1",
    qa: {
      status: "passed",
      preset: "fast",
      passLimit: 1,
      reason: null,
      passes: [
        qaPass({
          vision: "unavailable",
          counts: qaReport({ issues: [] }).counts,
        }),
      ],
    },
  });
  expect(status()).toBe("Passed");
  expect(counts(1)).toEqual(["0 open issues"]);
  expect(passRow(1)?.querySelector('[data-testid="qa-pass-vision"]')?.textContent).toBe(
    "Vision unavailable",
  );
  expect(passRow(1)?.querySelector("button")?.disabled).toBe(false);
});

it("marks an open report outdated once the project changed, and re-reads it after a revert", async () => {
  const reports: Record<string, QaReport> = { "qa-2": secondReport };
  const { store } = mountQa(twoPasses, reports);
  await expand(2);
  expect(document.body.querySelector('[data-testid="qa-report-outdated"]')).toBeNull();

  // The revert changes the project: the server now derives current = false.
  reports["qa-2"] = { ...secondReport, current: false };
  await act(async () => {
    const chat = store.getState().chat;
    if (!chat) throw new Error("no chat");
    store.setState({
      chat: {
        ...chat,
        turns: chat.turns.map((item) => ({
          ...item,
          checkpoint: { status: "reverted", entryIds: ["e1"], createdAt: 3000 },
        })),
      },
    });
  });
  await act(async () => {});
  expect(document.body.querySelector('[data-testid="qa-report-outdated"]')?.textContent).toContain(
    "the project changed since this render",
  );
});

it("explains a skipped QA and shows no passes", () => {
  mountQa({
    status: "skipped",
    preset: "balanced",
    passLimit: 2,
    passes: [],
    reason: "The video is longer than 3 minutes; render it yourself to check it.",
  });
  expect(status()).toBe("Skipped");
  expect(card()?.querySelector('[data-testid="render-qa-reason"]')?.textContent).toBe(
    "The video is longer than 3 minutes; render it yourself to check it.",
  );
  expect(card()?.querySelector("[data-qa-pass]")).toBeNull();
});

it("shows a failed pass's error and a stopped session", () => {
  mountQa({
    status: "failed",
    preset: "best",
    passLimit: 3,
    reason: null,
    passes: [
      qaPass({
        phase: "failed",
        reportId: null,
        renderPath: null,
        error: "The render failed: ffmpeg exited with code 1.",
      }),
    ],
  });
  expect(status()).toBe("Failed");
  expect(passRow(1)?.textContent).toContain("The render failed: ffmpeg exited with code 1.");
  unmountChat(mounted);

  mountQa({
    status: "aborted",
    preset: "custom",
    passLimit: 1,
    reason: null,
    passes: [qaPass({ phase: "aborted", reportId: null, renderPath: null })],
  });
  expect(status()).toBe("Stopped");
  expect(card()?.textContent).toContain("Custom · up to 1 pass");
});

it("says so when a pass's report is gone", async () => {
  mountQa(twoPasses);
  await expand(2);
  expect(passRow(2)?.querySelector('[role="alert"]')?.textContent).toContain(
    "This report is no longer stored.",
  );
});
