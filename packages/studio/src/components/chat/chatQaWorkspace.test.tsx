// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, expect, it } from "vitest";
import type {
  QaAcceptedIssue,
  QaPassState,
  QaReport,
  TurnQaState,
} from "@hyperframes/agent-protocol";
import { AgentApiError } from "../../agent/agentClient";
import {
  assistantMessage,
  chatState,
  qaIssue,
  qaPass,
  qaReport,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import { click, mountChat, unmountChat, type Mounted } from "./chatTestHarness";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
});

function mountQa(
  qa: TurnQaState,
  options: { reports?: Record<string, QaReport>; accepted?: QaAcceptedIssue[] } = {},
) {
  const chat = chatState({
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
  mounted = mountChat(
    { view: "chat", chatId: "c1", chat },
    { chat, qaReports: options.reports ?? {}, qaAccepted: options.accepted ?? [] },
  );
  return mounted;
}

function qaState(passes: QaPassState[], extra: Partial<TurnQaState> = {}): TurnQaState {
  return {
    status: "passed",
    preset: "balanced",
    passLimit: 2,
    reason: null,
    passes,
    ...extra,
  };
}

const card = () => document.body.querySelector('[data-testid="render-qa"]');
const passRow = (pass: number) => card()?.querySelector(`[data-qa-pass="${pass}"]`);
const text = (element: Element | null | undefined) => element?.textContent ?? "";
const byTestId = (root: ParentNode | null | undefined, id: string) =>
  root?.querySelector(`[data-testid="${id}"]`) ?? null;

async function expand(pass: number) {
  await click(passRow(pass)?.querySelector("button"));
  await act(async () => {});
}

async function settle() {
  await act(async () => {});
}

it("shows how far a rendering pass is and how long it has been running", () => {
  mountQa(
    qaState(
      [
        qaPass({
          phase: "rendering",
          reportId: null,
          renderPath: null,
          endedAt: undefined,
          startedAt: Date.now() - 65_000,
          progress: { percent: 42.4, stage: "Encoding" },
        }),
      ],
      { status: "running" },
    ),
  );

  const row = passRow(1);
  expect(text(byTestId(row, "qa-pass-phase"))).toBe("Rendering…");
  const meter = byTestId(row, "qa-pass-progress");
  expect(meter?.getAttribute("aria-valuenow")).toBe("42");
  expect(meter?.getAttribute("aria-label")).toBe("Render progress: 42%");
  expect(meter?.getAttribute("title")).toBe("Encoding");
  expect(text(byTestId(row, "qa-pass-elapsed"))).toMatch(/^01:0[5-9]$/);
});

it("shows no progress meter once the render is over, and the time the pass took", () => {
  mountQa(
    qaState([
      qaPass({
        phase: "done",
        progress: { percent: 100, stage: null },
        startedAt: 0,
        endedAt: 83_000,
      }),
    ]),
  );

  expect(byTestId(passRow(1), "qa-pass-progress")).toBeNull();
  expect(text(byTestId(passRow(1), "qa-pass-elapsed"))).toBe("01:23");
});

it("links only the renders that survive the session, and says the others were removed", () => {
  mountQa(
    qaState(
      [
        qaPass({
          pass: 1,
          phase: "corrected",
          renderPath: "renders/qa-t1-1.mp4",
          renderKept: false,
        }),
        qaPass({ pass: 2, phase: "done", renderPath: "renders/qa-t1-2.mp4", renderKept: true }),
      ],
      { status: "passed" },
    ),
  );

  expect(byTestId(passRow(1), "qa-pass-render")).toBeNull();
  expect(text(byTestId(passRow(1), "qa-pass-render-removed"))).toContain("removed");
  expect(byTestId(passRow(2), "qa-pass-render")?.getAttribute("href")).toBe(
    "/api/projects/p1/renders/file/qa-t1-2.mp4",
  );
  expect(byTestId(passRow(2), "qa-pass-render-removed")).toBeNull();
});

it("links every pass's render while the session runs, and only the last one for a turn stored before the flag", () => {
  const passes = [
    qaPass({ pass: 1, phase: "corrected", renderPath: "renders/qa-t1-1.mp4" }),
    qaPass({ pass: 2, phase: "done", renderPath: "renders/qa-t1-2.mp4" }),
  ];
  mountQa(qaState(passes, { status: "running" }));
  expect(byTestId(passRow(1), "qa-pass-render")).not.toBeNull();
  expect(byTestId(passRow(2), "qa-pass-render")).not.toBeNull();
  unmountChat(mounted);

  mountQa(qaState(passes, { status: "issues_remain" }));
  expect(byTestId(passRow(1), "qa-pass-render")).toBeNull();
  expect(byTestId(passRow(2), "qa-pass-render")).not.toBeNull();
});

it("labels a pass that checked only the timeline and says why, in the card and in the report", async () => {
  const note = {
    code: "too_long" as const,
    message: "The composition is 25 minutes long.",
    params: { minutes: 25 },
  };
  const report = qaReport({
    id: "qa-1",
    issues: [],
    scope: "timeline",
    scopeNote: note,
    vision: { status: "skipped", reason: null, frames: 0, rounds: 0, model: null },
  });
  mountQa(
    qaState([qaPass({ phase: "done", scope: "timeline", scopeNote: note, vision: "skipped" })], {
      scope: "timeline",
    }),
    { reports: { "qa-1": report } },
  );

  expect(text(byTestId(card(), "render-qa-scope"))).toBe(
    "Timeline checks only — The composition is 25 min long — too long to render unasked, so only the timeline was checked.",
  );
  expect(text(byTestId(passRow(1), "qa-pass-scope"))).toContain("Timeline checks only");
  // The scope line explains why Vision did not look: no second "Vision skipped" chip.
  expect(byTestId(passRow(1), "qa-pass-vision")).toBeNull();

  await expand(1);
  expect(text(byTestId(passRow(1), "qa-report-scope"))).toContain("Timeline checks only");
});

it("shows no scope line for a full check", () => {
  mountQa(qaState([qaPass({ scope: "full" })], { scope: "full" }));
  expect(byTestId(card(), "render-qa-scope")).toBeNull();
  expect(byTestId(passRow(1), "qa-pass-scope")).toBeNull();
});

it("says when the Director did the visual review because Vision is off", async () => {
  const report = qaReport({
    id: "qa-1",
    issues: [],
    vision: {
      status: "ran",
      reason: null,
      frames: 6,
      rounds: 1,
      model: "x/y",
      reviewer: "director",
    },
  });
  mountQa(qaState([qaPass({})]), { reports: { "qa-1": report } });
  await expand(1);
  expect(text(byTestId(passRow(1), "qa-report-reviewer"))).toContain("Director");
});

const fade = qaIssue({
  id: "p1-1",
  kind: "black_frames",
  message: "The picture is black for 1.2 s.",
});
const carriedOver = qaIssue({
  id: "p1-2",
  kind: "visual_mismatch",
  source: "vision",
  check: "vision",
  start: 30,
  end: 32,
  fixable: false,
  message: "The logo looks too small.",
  notRechecked: true,
});
const reportWithFade = () => qaReport({ id: "qa-1", issues: [fade, carriedOver] });
const accept = () =>
  document.body.querySelector('[data-issue-id="p1-1"] [data-testid="qa-issue-accept"]');
const issue = (id: string) => document.body.querySelector(`[data-issue-id="${id}"]`);

it("marks an issue intentional and offers to undo it", async () => {
  const { client } = mountQa(qaState([qaPass({})]), { reports: { "qa-1": reportWithFade() } });
  await expand(1);
  expect(text(accept())).toBe("Mark intentional");

  await click(accept());
  await settle();

  expect(client.acceptQaIssue).toHaveBeenCalledWith("qa-1", "p1-1");
  expect(issue("p1-1")?.getAttribute("data-issue-accepted")).toBe("true");
  expect(text(byTestId(issue("p1-1"), "qa-issue-accepted"))).toBe("Marked intentional");
  expect(byTestId(issue("p1-2"), "qa-issue-accepted")).toBeNull();

  await click(byTestId(issue("p1-1"), "qa-issue-unaccept"));
  await settle();

  expect(client.removeQaAccepted).toHaveBeenCalledTimes(1);
  expect(issue("p1-1")?.getAttribute("data-issue-accepted")).toBeNull();
  expect(text(accept())).toBe("Mark intentional");
});

it("keeps the issue open and says so when the choice could not be saved", async () => {
  const { client } = mountQa(qaState([qaPass({})]), { reports: { "qa-1": reportWithFade() } });
  client.acceptQaIssue.mockRejectedValueOnce(new AgentApiError("network", "offline"));
  await expand(1);

  await click(accept());
  await settle();

  expect(issue("p1-1")?.getAttribute("data-issue-accepted")).toBeNull();
  expect(document.body.querySelector('[data-testid="qa-report"] [role="alert"]')?.textContent).toBe(
    "Can't reach Studio right now.",
  );
  expect(text(accept())).toBe("Mark intentional");
});

it("labels an issue carried over from a pass that was not re-checked", async () => {
  mountQa(qaState([qaPass({})]), { reports: { "qa-1": reportWithFade() } });
  await expand(1);

  expect(text(byTestId(issue("p1-2"), "qa-issue-not-rechecked"))).toBe("Not re-checked");
  expect(byTestId(issue("p1-1"), "qa-issue-not-rechecked")).toBeNull();
});

const leftOut: QaAcceptedIssue = {
  id: "acc-1a2b3c4d",
  composition: "index.html",
  kind: "audio_gap",
  check: "audio.gap",
  subject: null,
  start: 40,
  end: 43,
  message: "A 3 s silence between the clips.",
  acceptedAt: 1000,
};

it("counts the issues left out as intentional and lets the user have QA check one again", async () => {
  const report = qaReport({ id: "qa-1", issues: [], suppressed: 1 });
  const { client } = mountQa(qaState([qaPass({ suppressed: 1 })]), {
    reports: { "qa-1": report },
    accepted: [leftOut, { ...leftOut, id: "acc-0000000f", composition: "other.html" }],
  });

  expect(text(passRow(1)?.querySelector("[data-qa-suppressed]"))).toBe("1 marked intentional");

  await expand(1);
  const panel = byTestId(passRow(1), "qa-suppressed");
  expect(text(panel)).toContain("1 issue left out of this pass");
  expect(panel?.querySelector("[data-accepted-id]")).toBeNull();

  const review = [...(panel?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Review",
  );
  await click(review);
  await settle();
  // Only this composition's entries are listed.
  expect(
    [...(panel?.querySelectorAll("[data-accepted-id]") ?? [])].map((item) =>
      item.getAttribute("data-accepted-id"),
    ),
  ).toEqual(["acc-1a2b3c4d"]);
  expect(text(panel)).toContain("A 3 s silence between the clips.");

  const toggle = (label: string) =>
    [...(panel?.querySelectorAll("button") ?? [])].find((button) => button.textContent === label);
  await click(toggle("Hide"));
  expect(panel?.querySelector("[data-accepted-id]")).toBeNull();
  await click(toggle("Review"));
  expect(panel?.querySelector("[data-accepted-id]")).not.toBeNull();

  await click(byTestId(panel, "qa-accepted-remove"));
  await settle();
  expect(client.removeQaAccepted).toHaveBeenCalledWith("acc-1a2b3c4d");
  expect(panel?.querySelector("[data-accepted-id]")).toBeNull();
  expect(text(panel)).toContain("Nothing is marked intentional in this composition.");
});
