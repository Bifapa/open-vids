import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentIntake } from "@hyperframes/agent-protocol";
import { intakeTurnRequest } from "./agentComposerSlice";
import { consumeIntake } from "./agentIntake";
import { createAgentStore, type AgentStore } from "./agentStore";
import { createFakeClient, createSourceLog } from "./agentTestHarness";

const INTAKE: AgentIntake = {
  version: 1,
  prompt: "Cut a 60s teaser from the interview",
  intent: "plan",
  model: { provider: "anthropic", modelId: "sonnet" },
  thinking: "high",
  agents: ["editor", "vision"],
  files: [
    { path: "assets/interview.mov", name: "interview.mov", size: 1000, kind: "video" },
    { path: "assets/brand.otf", name: "brand.otf", size: 10, kind: "font" },
  ],
  createdAt: "2026-10-01T00:00:00.000Z",
};

let store: AgentStore | undefined;

afterEach(() => {
  store?.getState().dispose();
  store = undefined;
});

describe("intake turn", () => {
  it("references every imported file by its project path, typed by kind", () => {
    expect(intakeTurnRequest(INTAKE)).toEqual({
      prompt: "Cut a 60s teaser from the interview",
      intent: "plan",
      mode: "normal",
      references: [
        {
          kind: "video",
          id: "intake-1",
          label: "interview.mov",
          source: { type: "project-path", path: "assets/interview.mov" },
        },
        { kind: "asset", id: "intake-2", label: "brand.otf", path: "assets/brand.otf" },
      ],
    });
  });

  it("lets the files be the brief when there is no prompt, and starts nothing when there is neither", () => {
    expect(intakeTurnRequest({ ...INTAKE, prompt: "  " })?.prompt).toBe(
      "Start this project from the imported files.",
    );
    expect(intakeTurnRequest({ ...INTAKE, prompt: "", files: [] })).toBeNull();
  });
});

describe("consumeIntake", () => {
  it("starts the intake's chat once: settings applied, first turn started, chat revealed", async () => {
    const client = createFakeClient({ intake: INTAKE });
    store = createAgentStore({ client, openEventSource: createSourceLog().open });
    await store.getState().init();
    const reveal = vi.fn();

    await consumeIntake(store, client, reveal);

    expect(client.createChat).toHaveBeenCalledWith({ model: INTAKE.model, thinking: "high" });
    expect(client.updateChat).toHaveBeenCalledWith("new", {
      enabledAgents: ["editor", "vision"],
      intent: "plan",
    });
    expect(client.startTurn).toHaveBeenCalledWith("new", intakeTurnRequest(INTAKE));
    expect(store.getState().chatId).toBe("new");
    expect(reveal).toHaveBeenCalledTimes(1);

    // A reload claims again; the server hands the intake out once, so nothing runs twice.
    await consumeIntake(store, client, reveal);
    expect(client.createChat).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledTimes(1);
  });

  it("leaves the intake unclaimed while the agent is unavailable", async () => {
    const client = createFakeClient({ intake: INTAKE });
    client.listChats.mockRejectedValue(new Error("down"));
    store = createAgentStore({ client, openEventSource: createSourceLog().open });
    await store.getState().init();

    await consumeIntake(store, client, vi.fn());

    expect(client.claimIntake).not.toHaveBeenCalled();
  });

  it("keeps the prompt in the new chat's box when the first turn cannot start", async () => {
    const client = createFakeClient({ intake: INTAKE });
    client.startTurn.mockRejectedValue(new Error("boom"));
    store = createAgentStore({ client, openEventSource: createSourceLog().open });
    await store.getState().init();

    await consumeIntake(store, client, vi.fn());

    expect(store.getState().drafts.new).toBe(INTAKE.prompt);
    expect(store.getState().notice).not.toBeNull();
  });
});
