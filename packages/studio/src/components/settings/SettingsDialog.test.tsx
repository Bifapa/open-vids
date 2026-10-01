// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EXECUTION_BUDGETS } from "@hyperframes/agent-protocol";
import type { AgentStore } from "../../agent/agentStore";
import { cleanupMounted } from "../ui/mountHost.testHelpers";
import { useAppPreferences } from "./appPreferences";
import { openSettings, useSettingsDialog } from "./settingsStore";
import {
  PREFERENCES,
  buttonNamed,
  click,
  mountSettings,
  radio,
  resetDialog,
  resetPreferences,
  settle,
  stubPreferencesFetch,
} from "./settingsDialog.testHelpers";

let store: AgentStore | undefined;

beforeEach(() => {
  resetPreferences();
});

afterEach(() => {
  store?.getState().dispose();
  store = undefined;
  resetDialog();
  cleanupMounted();
  vi.unstubAllGlobals();
});

const mount = () => mountSettings(undefined, (created) => (store = created));

it("opens on the asked section and walks sections with the arrow keys", async () => {
  mount();
  await act(async () => openSettings("execution"));
  await settle();
  const dialog = document.body.querySelector('[data-testid="settings-dialog"]');
  expect(
    dialog?.querySelector("[data-settings-section]")?.getAttribute("data-settings-section"),
  ).toBe("execution");
  const current = dialog?.querySelector<HTMLButtonElement>('[aria-current="true"]');
  expect(current?.textContent).toBe("Execution");

  await act(async () => {
    current?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  // Execution is last: Down wraps to General.
  expect(useSettingsDialog.getState().section).toBe("general");
});

it("edits the global default execution quality, custom budget included", async () => {
  const { client, agentStore } = mount();
  await act(async () => openSettings("execution"));
  await settle();

  expect(radio("Default execution quality", "Balanced")?.getAttribute("aria-checked")).toBe("true");
  expect(
    document.body.querySelector('[data-testid="default-quality-detail"]')?.textContent,
  ).toContain("render QA passes");

  await click(radio("Default execution quality", "Custom"));
  expect(client.updateSettings).toHaveBeenLastCalledWith({
    executionQuality: { preset: "custom", custom: EXECUTION_BUDGETS.balanced },
  });

  // Custom shows the whole budget; every change saves a clamped budget.
  const more = document.body.querySelector<HTMLButtonElement>(
    '[role="group"][aria-label="Autonomous QA passes"] button[aria-label="More"]',
  );
  await click(more);
  expect(client.updateSettings).toHaveBeenLastCalledWith({
    executionQuality: {
      preset: "custom",
      custom: { ...EXECUTION_BUDGETS.balanced, qaPasses: EXECUTION_BUDGETS.balanced.qaPasses + 1 },
    },
  });
  expect(agentStore.getState().settings?.executionQuality.custom.qaPasses).toBe(
    EXECUTION_BUDGETS.balanced.qaPasses + 1,
  );

  // Back to a fixed preset keeps the custom budget for the next time Custom is chosen.
  await click(radio("Default execution quality", "Fast"));
  expect(client.updateSettings).toHaveBeenLastCalledWith({
    executionQuality: {
      preset: "fast",
      custom: { ...EXECUTION_BUDGETS.balanced, qaPasses: EXECUTION_BUDGETS.balanced.qaPasses + 1 },
    },
  });
});

it("applies a theme at once, saves it, and puts the old one back when the save fails", async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const patch: unknown = JSON.parse(String(init?.body ?? "{}"));
    return Response.json({ ...PREFERENCES, ...(typeof patch === "object" ? patch : {}) });
  });
  vi.stubGlobal("fetch", fetchMock);
  mount();
  await act(async () => openSettings("appearance"));
  await settle();

  const tile = (value: string) =>
    document.body.querySelector<HTMLButtonElement>(`[data-theme-choice="${value}"]`);
  expect(tile("dark")?.getAttribute("aria-pressed")).toBe("true");

  await click(tile("light"));
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/app/preferences",
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ theme: "light" }) }),
  );
  expect(useAppPreferences.getState().preferences?.theme).toBe("light");
  expect(tile("light")?.getAttribute("aria-pressed")).toBe("true");

  fetchMock.mockImplementationOnce(async () =>
    Response.json({ error: { code: "invalid_request", message: "Disk full" } }, { status: 500 }),
  );
  await click(tile("system"));
  expect(useAppPreferences.getState().preferences?.theme).toBe("light");
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe("Disk full");
});

it("saves new-project defaults as a partial update", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ ...PREFERENCES, newProject: { ...PREFERENCES.newProject, openIn: "story" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  mount();
  await act(async () => openSettings("general"));
  await settle();

  expect(document.body.textContent).toContain("Changes apply to projects you create next");
  await click(radio("Open new projects in", "Story"));
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/app/preferences",
    expect.objectContaining({ body: JSON.stringify({ newProject: { openIn: "story" } }) }),
  );
  expect(useAppPreferences.getState().preferences?.newProject.openIn).toBe("story");
});

it("saves density as its own preference", async () => {
  const fetchMock = stubPreferencesFetch();
  mount();
  await act(async () => openSettings("appearance"));
  await settle();

  expect(radio("Interface density", "Default")?.getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain("Comfortable rows, sidebar items and the player bar");
  await click(radio("Interface density", "Compact"));
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/app/preferences",
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ density: "compact" }) }),
  );
  expect(useAppPreferences.getState().preferences?.density).toBe("compact");
  expect(radio("Interface density", "Compact")?.getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain("Tighter rows, sidebar items and the player bar");
});

it("saves the automatic update check and keeps the frame rates the editor can honour", async () => {
  const fetchMock = stubPreferencesFetch();
  mount();
  await act(async () => openSettings("general"));
  await settle();

  const toggle = document.body.querySelector<HTMLElement>(
    '[role="switch"][aria-label="Check for updates automatically"]',
  );
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  await click(toggle);
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/app/preferences",
    expect.objectContaining({ body: JSON.stringify({ updates: { autoCheck: false } }) }),
  );
  expect(useAppPreferences.getState().preferences?.updates.autoCheck).toBe(false);

  // 23.976 and 29.97 are not offered: Studio's preview and export cannot play them.
  const fps = document.body.querySelector<HTMLElement>('[aria-label="Default frame rate"]');
  expect(fps?.textContent).toBe("24 fps");
  await click(fps);
  expect(
    [...document.body.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent?.replace("✓", ""),
    ),
  ).toEqual(["24 fps", "25 fps", "30 fps", "60 fps"]);
});

it("reads preferences written before density and the update choice existed", async () => {
  const { density: _density, updates: _updates, ...old } = PREFERENCES;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(old)),
  );
  useAppPreferences.setState({ preferences: null });
  await useAppPreferences.getState().load();
  expect(useAppPreferences.getState().preferences).toEqual(PREFERENCES);
});

it("edits the Autonomy group, each setting saved at once with a hint that says what it does", async () => {
  const { client, agentStore } = mount();
  await act(async () => openSettings("execution"));
  await settle();

  // Defaults: Plan, and ask before locked edits and downloads.
  expect(radio("Default chat mode", "Plan")?.getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain("Proposes a plan first");
  expect(document.body.textContent).toContain(
    "Agents stop and ask first. They never change locked sections on their own.",
  );

  await click(radio("Default chat mode", "Ask"));
  expect(client.updateSettings).toHaveBeenLastCalledWith({ autonomy: { defaultIntent: "ask" } });
  expect(agentStore.getState().settings?.autonomy.defaultIntent).toBe("ask");
  expect(document.body.textContent).toContain("Answers only");

  const locked = document.body.querySelector<HTMLElement>(
    '[role="switch"][aria-label="Ask before changing locked or hand-edited sections"]',
  );
  await click(locked);
  expect(client.updateSettings).toHaveBeenLastCalledWith({
    autonomy: { askBeforeLockedEdits: false },
  });
  expect(locked?.getAttribute("aria-checked")).toBe("false");
  // Off never means "change them": the agent leaves the item alone and reports it.
  expect(document.body.textContent).toContain(
    "Agents skip locked or hand-edited items, carry on, and tell you afterwards.",
  );

  const downloads = document.body.querySelector<HTMLElement>(
    '[role="switch"][aria-label="Ask before downloading assets"]',
  );
  expect(document.body.textContent).toContain("Agents list what they found and wait for approval");
  await click(downloads);
  expect(client.updateSettings).toHaveBeenLastCalledWith({
    autonomy: { askBeforeDownloads: false },
  });
  expect(agentStore.getState().settings?.autonomy).toEqual({
    defaultIntent: "ask",
    askBeforeLockedEdits: false,
    askBeforeDownloads: false,
  });
});

it("turns a fixed preset into Custom, started from it, when the QA passes change", async () => {
  const { client } = mount();
  await act(async () => openSettings("execution"));
  await settle();

  const fewer = document.body.querySelector<HTMLButtonElement>(
    '[role="group"][aria-label="Autonomous QA passes"] button[aria-label="Fewer"]',
  );
  await click(fewer);
  expect(client.updateSettings).toHaveBeenLastCalledWith({
    executionQuality: {
      preset: "custom",
      custom: { ...EXECUTION_BUDGETS.balanced, qaPasses: EXECUTION_BUDGETS.balanced.qaPasses - 1 },
    },
  });
  expect(radio("Default execution quality", "Custom")?.getAttribute("aria-checked")).toBe("true");
  expect(buttonNamed("Customize")).toBeUndefined();
});
