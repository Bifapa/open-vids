// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentModelCatalog } from "@hyperframes/agent-protocol";
import {
  CATALOG,
  assistantMessage,
  chatState,
  providerInfo,
  summary,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import { useSettingsDialog } from "../settings/settingsStore";
import {
  buttonWithText,
  byLabel,
  click,
  mountChat,
  unmountChat,
  type Mounted,
} from "./chatTestHarness";

const NO_MODELS: AgentModelCatalog = { models: [], defaultModel: null, defaultThinking: null };
const NO_MODEL_ERROR =
  "No authenticated OMP model is available. Sign in with OMP or configure a provider API key.";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
  act(() => useSettingsDialog.setState({ open: false, section: "general", providerToOpen: null }));
});

async function settle() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

const textarea = (host: HTMLElement) => host.querySelector<HTMLTextAreaElement>("textarea");
const draft = (models: AgentModelCatalog | null, extra = {}) =>
  mountChat({ view: "chat", chatId: null, chat: null, models, ...extra });

describe("no usable model", () => {
  it("replaces the starting prompts with a calm Connect a model state, and nothing can be sent", () => {
    mounted = draft(NO_MODELS);
    const state = mounted.host.querySelector('[data-testid="no-model-state"]');
    expect(state?.textContent).toContain("Connect a model to use the agents");
    expect(state?.textContent).toContain("The manual editor works without a model.");
    expect(mounted.host.textContent).not.toContain("Tighten the pacing");
    // Not an error: no alert, no raw runtime text.
    expect(mounted.host.querySelector('[role="alert"]')).toBeNull();

    expect(textarea(mounted.host)?.disabled).toBe(true);
    expect(textarea(mounted.host)?.placeholder).toBe("Connect a model to write to the agents");
    expect(byLabel<HTMLButtonElement>(mounted.host, "Send message")?.disabled).toBe(true);
  });

  it("opens Settings on Models & Providers from the action", async () => {
    mounted = draft(NO_MODELS);
    expect(useSettingsDialog.getState().open).toBe(false);
    await click(buttonWithText(mounted.host, "Connect a model"));
    expect(useSettingsDialog.getState().open).toBe(true);
    expect(useSettingsDialog.getState().section).toBe("providers");
  });

  it("says it above the composer of an existing chat too", () => {
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: chatState({
        chat: summary({ status: "completed" }),
        messages: [userMessage(), assistantMessage({ status: "complete" })],
        turns: [turn({ status: "completed" })],
      }),
      models: NO_MODELS,
    });
    const note = mounted.host.querySelector('[data-testid="composer-no-model"]');
    expect(note?.textContent).toContain("Connect a model to use the agents");
    expect(note?.textContent).toContain("The manual editor works without a model.");
    expect(buttonWithText(note as HTMLElement, "Connect a model")).not.toBeNull();
    expect(textarea(mounted.host)?.disabled).toBe(true);
  });

  it("clears without a reload once a connection brings a model into the catalog", async () => {
    mounted = draft(NO_MODELS);
    const { client, store } = mounted;
    // Connecting a provider (a key or a sign-in) makes the store read the providers and the catalog again.
    client.refreshProviders.mockResolvedValue({
      providers: [providerInfo({ id: "anthropic" })],
      syncedAt: 1,
    });
    client.listModels.mockResolvedValue(CATALOG);

    await act(async () => {
      await store.getState().refreshProviders();
    });
    await settle();

    expect(mounted.host.querySelector('[data-testid="no-model-state"]')).toBeNull();
    expect(mounted.host.textContent).toContain("Tighten the pacing");
    expect(textarea(mounted.host)?.disabled).toBe(false);
    expect(textarea(mounted.host)?.placeholder).toBe("Describe an edit…");
  });

  it("keeps the unavailable state for an agent that is unreachable, and the usual chat while models load or fail", () => {
    mounted = draft(NO_MODELS, { availability: "unavailable", unavailableMessage: null });
    expect(mounted.host.textContent).toContain("Agent unavailable");
    expect(mounted.host.textContent).not.toContain("Connect a model");
    unmountChat(mounted);

    // The catalog could not be read (or is still loading): that is not "no model".
    mounted = draft(null, { modelsFailed: true });
    expect(mounted.host.querySelector('[data-testid="no-model-state"]')).toBeNull();
    expect(mounted.host.textContent).toContain("Tighten the pacing");
    expect(textarea(mounted.host)?.disabled).toBe(false);
  });

  it("puts the same action next to a turn that failed with the runtime's no-model error", async () => {
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: chatState({
        chat: summary({ status: "failed" }),
        messages: [userMessage(), assistantMessage({ status: "complete" })],
        turns: [
          turn({ status: "failed", error: { code: "agent_failed", message: NO_MODEL_ERROR } }),
        ],
      }),
    });
    const alert = mounted.host.querySelector('[data-testid="turn-footer"] [role="alert"]');
    expect(alert?.textContent).toContain("Connect a model to use the agents");
    expect(mounted.host.textContent).not.toContain("No authenticated OMP model");
    await click(buttonWithText(alert as HTMLElement, "Connect a model"));
    expect(useSettingsDialog.getState().section).toBe("providers");
  });
});
