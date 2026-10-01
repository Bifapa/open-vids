// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  EXECUTION_BUDGETS,
  type AgentSettings,
  type UpdateAgentSettingsRequest,
} from "@hyperframes/agent-protocol";
import { CATALOG, SETTINGS, createFakeClient, createSourceLog } from "../../agent/agentTestHarness";
import { createAgentStore, type AgentStore } from "../../agent/agentStore";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { useAppPreferences, type AppPreferences } from "./appPreferences";
import { SettingsDialog } from "./SettingsDialog";
import { openSettings, useSettingsDialog } from "./settingsStore";

const PREFERENCES: AppPreferences = {
  version: 1,
  theme: "dark",
  newProject: {
    location: "~/Movies/OpenVids",
    openIn: "media",
    width: 1920,
    height: 1080,
    fps: 24,
  },
  confirmTrash: true,
  onLaunch: "projects",
};

let store: AgentStore | undefined;

beforeEach(() => {
  useAppPreferences.setState({
    preferences: PREFERENCES,
    loadFailed: false,
    error: null,
    saving: 0,
  });
});

afterEach(() => {
  store?.getState().dispose();
  store = undefined;
  act(() => useSettingsDialog.setState({ open: false, section: "general", returnFocus: null }));
  cleanupMounted();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

const radio = (group: string, label: string) =>
  [
    ...document.body.querySelectorAll<HTMLButtonElement>(
      `[role="radiogroup"][aria-label="${group}"] [role="radio"]`,
    ),
  ].find((button) => button.textContent?.trim() === label);

function mountSettings(settings: AgentSettings = SETTINGS) {
  let saved = settings;
  const client = createFakeClient({ settings });
  client.updateSettings.mockImplementation(async (request: UpdateAgentSettingsRequest) => {
    if (request.executionQuality) saved = { ...saved, executionQuality: request.executionQuality };
    return saved;
  });
  store = createAgentStore({ client, openEventSource: createSourceLog().open });
  store.setState({ availability: "ready", models: CATALOG, settings });
  mountHost(<SettingsDialog agentStore={store} />);
  return { client, agentStore: store };
}

it("opens on the asked section and walks sections with the arrow keys", async () => {
  mountSettings();
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
  const { client, agentStore } = mountSettings();
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
    '[role="group"][aria-label="Render QA passes"] button[aria-label="More"]',
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
  mountSettings();
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
  mountSettings();
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
