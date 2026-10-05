import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentClient } from "./agentClient";
import type { AgentIntake } from "@hyperframes/agent-protocol";
import { intakeTurnRequest } from "./agentComposerSlice";
import { consumeIntake } from "./agentIntake";
import { NEW_CHAT_DRAFT } from "./agentDraftChat";
import { createAgentStore, type AgentStore } from "./agentStore";
import { createFakeClient, createSourceLog } from "./agentTestHarness";

const INTAKE: AgentIntake = {
  version: 1,
  prompt: "Cut a 60s teaser from the interview",
  intent: "ask",
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
      intent: "ask",
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

  it("carries the Auto format to the runtime as a canvas hint", () => {
    expect(intakeTurnRequest({ ...INTAKE, format: "auto" })?.canvas).toBe("auto");
    expect(intakeTurnRequest(INTAKE)?.canvas).toBeUndefined();
  });
});

describe("consumeIntake", () => {
  it("starts the intake's chat once: settings applied, first turn started, chat revealed", async () => {
    const client = createFakeClient({ intake: INTAKE });
    store = createAgentStore({ client, openEventSource: createSourceLog().open });
    await store.getState().init();
    const reveal = vi.fn();

    await consumeIntake(store, client, { projectId: "once", reveal });

    expect(client.createChat).toHaveBeenCalledWith({ model: INTAKE.model, thinking: "high" });
    expect(client.updateChat).toHaveBeenCalledWith("new", {
      enabledAgents: ["editor", "vision"],
      intent: "ask",
    });
    expect(client.startTurn).toHaveBeenCalledWith("new", {
      ...intakeTurnRequest(INTAKE),
      userLanguage: "en",
    });
    expect(store.getState().chatId).toBe("new");
    expect(reveal).toHaveBeenCalledTimes(1);

    // A reload claims again; the server hands the intake out once, so nothing runs twice.
    await consumeIntake(store, client, { projectId: "once", reveal });
    expect(client.createChat).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledTimes(1);
  });

  it("leaves the intake unclaimed while the agent is unavailable", async () => {
    const client = createFakeClient({ intake: INTAKE });
    client.listChats.mockRejectedValue(new Error("down"));
    store = createAgentStore({ client, openEventSource: createSourceLog().open });
    await store.getState().init();

    await consumeIntake(store, client, { projectId: "down", reveal: vi.fn() });

    expect(client.claimIntake).not.toHaveBeenCalled();
  });

  it("keeps the prompt in the new chat's box when the first turn cannot start", async () => {
    const client = createFakeClient({ intake: INTAKE });
    client.startTurn.mockRejectedValue(new Error("boom"));
    store = createAgentStore({ client, openEventSource: createSourceLog().open });
    await store.getState().init();

    await consumeIntake(store, client, { projectId: "no-turn", reveal: vi.fn() });

    expect(store.getState().drafts.new).toBe(INTAKE.prompt);
    expect(store.getState().notice).not.toBeNull();
  });

  it("keeps the prompt, the files and the choices in the new-chat draft when no chat can be created", async () => {
    const client = createFakeClient({ intake: INTAKE });
    client.createChat.mockRejectedValue(new Error("boom"));
    store = createAgentStore({ client, openEventSource: createSourceLog().open });
    await store.getState().init();
    store.getState().closeChat();

    await consumeIntake(store, client, { projectId: "no-chat", reveal: vi.fn() });

    const state = store.getState();
    expect(state.view).toBe("chat");
    expect(state.chatId).toBeNull();
    expect(state.drafts[NEW_CHAT_DRAFT]).toBe(INTAKE.prompt);
    expect(state.attachments[NEW_CHAT_DRAFT]?.map((file) => file.path)).toEqual([
      "assets/interview.mov",
      "assets/brand.otf",
    ]);
    expect(state.draftChoices).toEqual({
      model: INTAKE.model,
      thinking: "high",
      enabledAgents: ["editor", "vision"],
      intent: "ask",
    });
    expect(state.notice).not.toBeNull();
    expect(state.pending).toBeNull();
  });

  it("still starts a claimed intake when the agent drops out between the check and the claim", async () => {
    const client = createFakeClient({ intake: INTAKE });
    store = createAgentStore({ client, openEventSource: createSourceLog().open });
    await store.getState().init();
    const claim = client.claimIntake.getMockImplementation();
    client.claimIntake.mockImplementation(async () => {
      store?.setState({ availability: "unavailable" });
      return claim ? claim() : null;
    });

    await consumeIntake(store, client, { projectId: "flip", reveal: vi.fn() });

    expect(client.createChat).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledTimes(1);
  });

  it("hands an intake whose project view went away to the project's next store", async () => {
    const client = createFakeClient({ intake: INTAKE });
    store = createAgentStore({ client, openEventSource: createSourceLog().open });
    await store.getState().init();
    let cancelled = false;
    client.claimIntake.mockImplementationOnce(async () => {
      cancelled = true;
      return INTAKE;
    });

    await consumeIntake(store, client, {
      projectId: "strand",
      isCancelled: () => cancelled,
      reveal: vi.fn(),
    });
    expect(client.createChat).not.toHaveBeenCalled();

    const next = createAgentStore({ client, openEventSource: createSourceLog().open });
    await next.getState().init();
    await consumeIntake(next, client, { projectId: "strand", reveal: vi.fn() });
    next.getState().dispose();

    expect(client.claimIntake).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledWith("new", {
      ...intakeTurnRequest(INTAKE),
      userLanguage: "en",
    });
  });

  describe("a start cut short after its chat was made", () => {
    async function retryInNextStore(client: AgentClient, projectId: string) {
      const next = createAgentStore({ client, openEventSource: createSourceLog().open });
      await next.getState().init();
      await consumeIntake(next, client, { projectId, reveal: vi.fn() });
      next.getState().dispose();
    }

    it("reuses that chat instead of making an empty second one", async () => {
      const client = createFakeClient({ intake: INTAKE });
      store = createAgentStore({ client, openEventSource: createSourceLog().open });
      await store.getState().init();
      const first = store;
      let gone = false;
      const update = client.updateChat.getMockImplementation();
      client.updateChat.mockImplementationOnce(async (chatId, request) => {
        gone = true;
        first.getState().dispose();
        return update ? update(chatId, request) : Promise.reject(new Error("no update"));
      });

      await consumeIntake(store, client, {
        projectId: "strand-chat",
        isCancelled: () => gone,
        reveal: vi.fn(),
      });
      expect(client.createChat).toHaveBeenCalledTimes(1);
      expect(client.startTurn).not.toHaveBeenCalled();

      await retryInNextStore(client, "strand-chat");

      expect(client.createChat).toHaveBeenCalledTimes(1);
      expect(client.updateChat).toHaveBeenCalledTimes(2);
      expect(client.startTurn).toHaveBeenCalledTimes(1);
      expect(client.startTurn).toHaveBeenCalledWith("new", {
        ...intakeTurnRequest(INTAKE),
        userLanguage: "en",
      });
    });

    it("reuses that chat when the turn failed to start after the store was gone", async () => {
      const client = createFakeClient({ intake: INTAKE });
      store = createAgentStore({ client, openEventSource: createSourceLog().open });
      await store.getState().init();
      const first = store;
      let gone = false;
      client.startTurn.mockImplementationOnce(async () => {
        gone = true;
        first.getState().dispose();
        throw new Error("boom");
      });

      await consumeIntake(store, client, {
        projectId: "strand-turn",
        isCancelled: () => gone,
        reveal: vi.fn(),
      });
      await retryInNextStore(client, "strand-turn");

      expect(client.createChat).toHaveBeenCalledTimes(1);
      expect(client.startTurn).toHaveBeenCalledTimes(2);
    });
  });
});
