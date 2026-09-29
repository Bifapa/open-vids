import { describe, expect, it } from "vitest";
import type { Activity, ActivityPart, AgentRunStatus } from "@hyperframes/agent-protocol";
import {
  activeThread,
  agentCrumbs,
  agentThread,
  mainThreadMessages,
  runCurrentStep,
} from "./agentSelectors";
import {
  agentRun,
  assistantMessage,
  chatState,
  runReply,
  taskMessage,
  userMessage,
} from "./agentTestHarness";

function activity(id: string, label: string, status: Activity["status"]): ActivityPart {
  return {
    type: "activity",
    id,
    activity: { id, category: "edit", status, label, count: 1, targets: [], startedAt: 1 },
  };
}

describe("agent crumbs", () => {
  it("names each agent once, in the order it first worked, Jev included, live while any run is", () => {
    expect(agentCrumbs([])).toEqual([]);
    expect(
      agentCrumbs([
        agentRun({ id: "r1", agent: "editor", status: "completed" }),
        agentRun({ id: "r2", agent: "vision", status: "queued" }),
        agentRun({ id: "r3", agent: "jev", parentRunId: "r1", status: "failed" }),
        agentRun({ id: "r4", agent: "editor", status: "running" }),
        agentRun({ id: "r5", agent: "vision", status: "completed" }),
      ]),
    ).toEqual([
      { agent: "editor", live: true },
      { agent: "vision", live: true },
      { agent: "jev", live: false },
    ]);
  });
});

describe("threads", () => {
  const editor = agentRun({ id: "r1", agent: "editor" });
  const nestedJev = agentRun({ id: "r2", agent: "jev", parentRunId: "r1" });
  const directJev = agentRun({ id: "r3", agent: "jev" });
  const state = chatState({
    runs: [editor, nestedJev, directJev],
    messages: [
      userMessage(),
      assistantMessage({
        parts: [
          { type: "delegation", id: "r1", runId: "r1" },
          { type: "delegation", id: "r3", runId: "r3" },
        ],
      }),
      taskMessage(editor, "Trim the intro to 3s"),
      runReply(editor, { parts: [{ type: "delegation", id: "r2", runId: "r2" }] }),
      { ...taskMessage(nestedJev, "Rename the clip ids"), from: "editor" },
      runReply(nestedJev),
      taskMessage(directJev, "List the audio assets"),
      runReply(directJev),
      taskMessage(editor, "Keep the logo on screen", true),
    ],
  });
  const threadIds = (agent: "editor" | "jev") =>
    agentThread(state, agent).map(({ run, messages }) => [run.id, messages.map((m) => m.id)]);

  it("keeps Main to the user's prompts and the Director's replies", () => {
    expect(mainThreadMessages(state).map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  it("gives an agent every run it did, each with its own task, follow-ups and reply in order", () => {
    expect(threadIds("editor")).toEqual([["r1", ["r1-task", "r1-reply", "r1-follow-up"]]]);
    expect(threadIds("jev")).toEqual([
      ["r2", ["r2-task", "r2-reply"]],
      ["r3", ["r3-task", "r3-reply"]],
    ]);
  });

  it("files a run's reply under the run even when it arrives without a runId", () => {
    const { runId: _dropped, ...orphan } = runReply(editor);
    const loose = chatState({
      runs: [editor],
      messages: [userMessage(), assistantMessage(), taskMessage(editor, "Trim"), orphan],
    });
    expect(mainThreadMessages(loose).map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(agentThread(loose, "editor")[0]?.messages.map((message) => message.id)).toEqual([
      "r1-task",
      "r1-reply",
    ]);
  });

  it("shows the selected agent's thread only while that agent has a run in the chat", () => {
    expect(activeThread({ c1: "jev" }, state)).toBe("jev");
    expect(activeThread({ c1: "vision" }, state)).toBe("main");
    expect(activeThread({ c2: "editor" }, state)).toBe("main");
    expect(activeThread({ c1: "editor" }, null)).toBe("main");
  });
});

describe("delegation progress", () => {
  const run = agentRun();

  it("is the latest running activity of the run's reply while the run is live", () => {
    const messages = [
      runReply(run, {
        parts: [
          activity("a1", "Reading 3 files", "done"),
          activity("a2", "Editing scenes/intro.html", "running"),
          { type: "text", id: "t", text: "Trimming now." },
        ],
      }),
    ];
    expect(runCurrentStep(messages, run)).toBe("Editing scenes/intro.html");
    expect(runCurrentStep(messages, { ...run, status: "queued" })).toBe(
      "Editing scenes/intro.html",
    );
  });

  it("is nothing between activities, and nothing once the run ended however it ended", () => {
    const idle = [runReply(run, { parts: [activity("a1", "Read 3 files", "done")] })];
    expect(runCurrentStep(idle, run)).toBeNull();
    const busy = [runReply(run, { parts: [activity("a2", "Editing intro", "running")] })];
    const ended: AgentRunStatus[] = ["completed", "failed", "aborted", "cancelled", "interrupted"];
    for (const status of ended) {
      expect(runCurrentStep(busy, { ...run, status })).toBeNull();
    }
  });
});
