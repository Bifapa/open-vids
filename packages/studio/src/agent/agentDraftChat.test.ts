import { afterEach, describe, expect, it } from "vitest";
import { EXECUTION_BUDGETS } from "@hyperframes/agent-protocol";
import { draftChatSummary, draftCreation } from "./agentDraftChat";
import { createAgentStore, type AgentStore } from "./agentStore";
import { SETTINGS, createFakeClient, createSourceLog, type FakeClient } from "./agentTestHarness";

let store: AgentStore | undefined;

afterEach(() => {
  store?.getState().dispose();
  store = undefined;
});

/** A project with no chats: the panel opens on the new-chat draft. */
async function draftStore(): Promise<{ store: AgentStore; client: FakeClient }> {
  const client = createFakeClient({ settings: SETTINGS });
  store = createAgentStore({ client, openEventSource: createSourceLog().open });
  await store.getState().init();
  expect(store.getState().view).toBe("chat");
  expect(store.getState().chatId).toBeNull();
  return { store, client };
}

describe("new-chat draft choices", () => {
  it("holds the chips' choices locally and creates the chat with them before its first turn", async () => {
    const { store, client } = await draftStore();
    const state = store.getState();
    const override = {
      model: { provider: "anthropic", modelId: "sonnet" },
      thinking: "low" as const,
      allowedModels: [],
    };

    await state.setModel({ provider: "anthropic", modelId: "sonnet" });
    await state.setThinking("high");
    expect((await state.setEnabledAgents(["vision", "editor"])).ok).toBe(true);
    expect((await state.setAgentOverride("editor", override)).ok).toBe(true);
    expect((await state.setIntent("ask")).ok).toBe(true);
    const quality = { preset: "fast" as const, custom: EXECUTION_BUDGETS.balanced };
    expect((await state.setExecutionQuality(quality)).ok).toBe(true);
    // Nothing exists on the server yet.
    expect(client.updateChat).not.toHaveBeenCalled();
    expect(client.createChat).not.toHaveBeenCalled();

    // The chips read the draft as a chat would look.
    const shown = draftChatSummary(store.getState().draftChoices, SETTINGS);
    expect(shown.mainAgentModel).toEqual({ provider: "anthropic", modelId: "sonnet" });
    expect(shown.intent).toBe("ask");
    expect(shown.enabledAgents).toEqual(["editor", "vision"]);

    store.getState().setDraft("Trim the intro");
    expect(await store.getState().send({ mode: "normal" })).toBe(true);

    expect(client.createChat).toHaveBeenCalledWith({
      model: { provider: "anthropic", modelId: "sonnet" },
      thinking: "high",
    });
    expect(client.updateChat).toHaveBeenCalledWith("new", {
      enabledAgents: ["editor", "vision"],
      agentOverrides: { editor: override },
      intent: "ask",
      executionQuality: quality,
    });
    expect(client.startTurn).toHaveBeenCalledWith(
      "new",
      expect.objectContaining({ prompt: "Trim the intro", mode: "normal" }),
    );
    // The first turn starts only once the chat carries the choices.
    const updatedAt = client.updateChat.mock.invocationCallOrder[0] ?? Infinity;
    const startedAt = client.startTurn.mock.invocationCallOrder[0] ?? -Infinity;
    expect(updatedAt).toBeLessThan(startedAt);
    expect(store.getState().draftChoices).toEqual({});
    expect(store.getState().chatId).toBe("new");
  });

  it("creates a chat with no intent of its own when nothing was chosen (the runtime starts in Edit)", async () => {
    const { store, client } = await draftStore();
    store.getState().setDraft("Hello");
    await store.getState().send();
    expect(client.createChat).toHaveBeenCalledWith({});
    // No settings decide the mode any more: with no choice the chat carries no intent, and Edit applies.
    expect(client.updateChat).not.toHaveBeenCalled();
    expect(client.startTurn).toHaveBeenCalledWith(
      "new",
      expect.not.objectContaining({ intent: expect.anything() }),
    );
  });

  it("sends the mode chosen in the draft, and falls back to Edit with no settings", async () => {
    const { store, client } = await draftStore();
    await store.getState().setIntent("ask");
    expect(draftChatSummary(store.getState().draftChoices, SETTINGS).intent).toBe("ask");
    store.getState().setDraft("What is in the intro?");
    await store.getState().send();
    expect(client.updateChat).toHaveBeenCalledWith("new", { intent: "ask" });

    // No settings (the runtime could not provide them): the draft shows Edit and sends no intent of its own.
    expect(draftChatSummary({}, null).intent).toBe("edit");
    expect(draftCreation({}).update).toBeNull();
  });

  it("starts where a new chat would, and resets the effort a newly chosen model cannot take", async () => {
    const { store } = await draftStore();
    const fresh = draftChatSummary(store.getState().draftChoices, SETTINGS);
    expect(fresh.intent).toBe("edit");
    expect(fresh.mainAgentModel).toBeNull();
    expect(fresh.executionQuality).toBeNull();

    await store.getState().setThinking("high");
    await store.getState().setModel({ provider: "openai", modelId: "mini" });
    expect(store.getState().draftChoices).toEqual({
      model: { provider: "openai", modelId: "mini" },
      thinking: null,
    });

    // A new draft starts over.
    store.getState().startDraft();
    expect(store.getState().draftChoices).toEqual({});
  });
});
