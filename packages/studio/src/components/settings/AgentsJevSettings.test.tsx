// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSettings, TestJevResponse } from "@hyperframes/agent-protocol";
import type { AgentStore } from "../../agent/agentStore";
import { SETTINGS, providerInfo } from "../../agent/agentTestHarness";
import { cleanupMounted } from "../ui/mountHost.testHelpers";
import { openSettings } from "./settingsStore";
import {
  buttonNamed,
  click,
  labelled,
  mountSettings,
  radio,
  resetDialog,
  resetPreferences,
  settle,
} from "./settingsDialog.testHelpers";

let store: AgentStore | undefined;

beforeEach(() => resetPreferences());

afterEach(() => {
  store?.getState().dispose();
  store = undefined;
  resetDialog();
  cleanupMounted();
  vi.unstubAllGlobals();
});

const JEV: AgentSettings["jev"] = {
  ...SETTINGS.jev,
  enabled: true,
  provider: "anthropic",
  modelId: "sonnet",
};

async function mountSection(
  section: "agents" | "jev",
  settings: AgentSettings,
  providers = [providerInfo({ id: "anthropic" }), providerInfo({ id: "ollama", keyless: true })],
) {
  const mounted = mountSettings(settings, (created) => (store = created));
  mounted.client.listProviders.mockImplementation(async () => ({ providers, syncedAt: null }));
  mounted.client.listProviderModels.mockImplementation(async () => ({
    models: [
      {
        provider: "anthropic",
        modelId: "sonnet",
        name: "Sonnet",
        reasoning: true,
        efforts: ["low", "high"],
      },
    ],
  }));
  await act(async () => openSettings(section));
  await settle();
  return mounted;
}

/** A key to whatever has focus, as the open list of a Select receives it. */
async function press(key: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

const text = (element: Element | null | undefined) => element?.textContent ?? "";

function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("offers Off beside Default in an agent's thinking effort, and saves it as off", async () => {
  const { client } = await mountSection("agents", SETTINGS);

  const trigger = labelled("Editor thinking effort");
  expect(trigger?.textContent).toBe("Default (Low)");
  await click(trigger);
  const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map((option) => option.textContent?.replace("✓", ""))).toEqual([
    "Default (Low)",
    "Off",
    "Low",
    "High",
  ]);
  // Default is highlighted when the list opens; Off is the row under it.
  await press("ArrowDown");
  await press("Enter");
  expect(client.updateSettings).toHaveBeenLastCalledWith({
    specialists: { editor: { ...SETTINGS.specialists.editor, thinking: "off" } },
  });
});

it("resets every model, effort and on-switch to the defaults, and only offers it when something differs", async () => {
  const { client } = await mountSection("agents", SETTINGS);
  const reset = () => buttonNamed("Reset to defaults");
  // Defaults except that three specialists are off in new chats: that differs.
  expect(reset()?.disabled).toBe(false);
  await click(reset());
  const specialists = Object.fromEntries(
    Object.entries(SETTINGS.specialists).map(([id, value]) => [
      id,
      { ...value, model: null, thinking: null, enabledByDefault: true },
    ]),
  );
  expect(client.updateSettings).toHaveBeenLastCalledWith({
    director: { model: null, thinking: null },
    specialists,
  });
  await settle();
  expect(reset()?.disabled).toBe(true);
});

it("offers Off for the Jev worker too", async () => {
  await mountSection("jev", { ...SETTINGS, jev: JEV });
  await click(labelled("Jev thinking"));
  expect(
    [...document.body.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent?.replace("✓", ""),
    ),
  ).toEqual(["Default", "Off", "Low", "High"]);
});

it("shows Jev's connection, a saved key with Test and Remove, and never the key itself", async () => {
  const { client } = await mountSection("jev", {
    ...SETTINGS,
    jev: { ...JEV, credentials: "api-key" },
  });

  // No key yet: the field, with where it is kept.
  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Jev API key"]');
  expect(input?.type).toBe("password");
  expect(input?.autocomplete).toBe("off");
  expect(text(document.body)).toContain("not shared with OMP");

  await click(buttonNamed("Save"));
  expect(text(document.body.querySelector('[role="alert"]'))).toBe("Paste an API key first.");
  type(input, "sk ant");
  await click(buttonNamed("Save"));
  expect(text(document.body.querySelector('[role="alert"]'))).toBe(
    "An API key can't contain spaces.",
  );
  expect(client.setJevApiKey).not.toHaveBeenCalled();

  client.setJevApiKey.mockImplementation(async () => ({
    ...SETTINGS,
    jev: { ...JEV, credentials: "api-key", apiKeyConfigured: true },
  }));
  type(input, "sk-ant-abc");
  await click(buttonNamed("Save"));
  expect(client.setJevApiKey).toHaveBeenCalledWith({ apiKey: "sk-ant-abc" });
  // Saved: the field is gone, a row with Test and Remove stands in, and no trace of the key is left.
  expect(document.body.querySelector('input[aria-label="Jev API key"]')).toBeNull();
  expect(buttonNamed("Test")).toBeDefined();
  expect(buttonNamed("Remove")).toBeDefined();
  expect(document.body.innerHTML).not.toContain("sk-ant-abc");
});

it("tests Jev with a busy state and says how it went", async () => {
  const { client } = await mountSection("jev", { ...SETTINGS, jev: JEV });
  let finish: (response: TestJevResponse) => void = () => {};
  client.testJev.mockImplementation(
    () => new Promise<TestJevResponse>((resolve) => (finish = resolve)),
  );

  await click(buttonNamed("Test"));
  expect(text(document.body)).toContain("Testing…");
  expect(buttonNamed("Test")?.disabled).toBe(true);

  await act(async () =>
    finish({
      ok: true,
      model: { provider: "anthropic", modelId: "sonnet" },
      reply: "Hi.",
      elapsedMs: 1200,
    }),
  );
  await settle();
  expect(text(document.body)).toContain("Replied in 1.2s");

  await click(buttonNamed("Test"));
  await act(async () => finish({ ok: false, message: "Jev is off." }));
  await settle();
  expect(text(document.body)).toContain("Failed");
  expect(text(document.body.querySelector('[role="alert"]'))).toBe("Jev is off.");
});

it("needs no credential for a local provider, and uses the prototype's words for the others", async () => {
  await mountSection("jev", { ...SETTINGS, jev: { ...JEV, provider: "ollama", modelId: "llama" } });
  expect(text(document.body)).toContain("Local providers don't need one.");
  expect(text(document.body)).toContain("Not needed");
  expect(
    document.body.querySelector('[role="radiogroup"][aria-label="Jev credentials"]'),
  ).toBeNull();
  unmountAndRemount();

  await mountSection("jev", { ...SETTINGS, jev: JEV });
  expect(
    radio(
      "Jev credentials",
      "Use the Anthropic connectionSame credential and limits as your agents",
    )?.getAttribute("aria-checked"),
  ).toBe("true");
  expect(text(document.body)).toContain("Separate API key for Jev");
  expect(text(document.body)).toContain("A fast worker for short, high-volume jobs.");
});

function unmountAndRemount() {
  store?.getState().dispose();
  store = undefined;
  cleanupMounted();
  resetDialog();
}
