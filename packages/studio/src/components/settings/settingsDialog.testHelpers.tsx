import { act } from "react";
import { vi } from "vitest";
import type { AgentSettings, UpdateAgentSettingsRequest } from "@hyperframes/agent-protocol";
import {
  CATALOG,
  SETTINGS,
  createFakeClient,
  createSourceLog,
  type FakeClient,
} from "../../agent/agentTestHarness";
import { createAgentStore, type AgentStore } from "../../agent/agentStore";
import { mountHost } from "../ui/mountHost.testHelpers";
import { useAppPreferences, type AppPreferences } from "./appPreferences";
import { SettingsDialog } from "./SettingsDialog";
import { useSettingsDialog } from "./settingsStore";

export const PREFERENCES: AppPreferences = {
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
  density: "default",
  language: "system",
  updates: { autoCheck: true },
};

export function resetPreferences(): void {
  useAppPreferences.setState({
    preferences: PREFERENCES,
    loadFailed: false,
    error: null,
    saving: 0,
  });
}

export function resetDialog(): void {
  act(() =>
    useSettingsDialog.setState({
      open: false,
      section: "general",
      returnFocus: null,
      providerToOpen: null,
    }),
  );
}

/** Lets the promises a click starts (and the store updates they cause) land. */
export async function settle() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

export async function click(element: Element | null | undefined) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

export const radio = (group: string, label: string) =>
  [
    ...document.body.querySelectorAll<HTMLButtonElement>(
      `[role="radiogroup"][aria-label="${group}"] [role="radio"]`,
    ),
  ].find((button) => button.textContent?.trim() === label);

/** The first button in the dialog whose text is exactly `text`. */
export const buttonNamed = (text: string, within: ParentNode = document.body) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === text,
  );

/** Applies the parts of an update request the tests care about, as the runtime would. */
function applyUpdate(settings: AgentSettings, request: UpdateAgentSettingsRequest): AgentSettings {
  return {
    ...settings,
    ...(request.executionQuality && { executionQuality: request.executionQuality }),
    ...(request.autonomy && { autonomy: { ...settings.autonomy, ...request.autonomy } }),
    ...(request.director && { director: { ...settings.director, ...request.director } }),
    ...(request.specialists && {
      specialists: { ...settings.specialists, ...request.specialists },
    }),
    ...(request.jev && { jev: { ...settings.jev, ...request.jev } }),
  };
}

export interface MountedSettings {
  client: FakeClient;
  agentStore: AgentStore;
}

/** Mounts the Settings dialog on a store whose client answers from, and saves into, `settings`. */
export function mountSettings(
  settings: AgentSettings = SETTINGS,
  onStore?: (store: AgentStore) => void,
): MountedSettings {
  let saved = settings;
  const client = createFakeClient({ settings });
  client.updateSettings.mockImplementation(async (request: UpdateAgentSettingsRequest) => {
    saved = applyUpdate(saved, request);
    return saved;
  });
  client.getSettings.mockImplementation(async () => saved);
  const agentStore = createAgentStore({ client, openEventSource: createSourceLog().open });
  agentStore.setState({ availability: "ready", models: CATALOG, settings });
  onStore?.(agentStore);
  mountHost(<SettingsDialog agentStore={agentStore} />);
  return { client, agentStore };
}

export function stubPreferencesFetch(extra: Partial<AppPreferences> = {}) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const patch: unknown = JSON.parse(String(init?.body ?? "{}"));
    return Response.json({ ...PREFERENCES, ...extra, ...(typeof patch === "object" ? patch : {}) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The control with this accessible name. */
export const labelled = (label: string, within: ParentNode = document.body) =>
  within.querySelector<HTMLElement>(`[aria-label="${label}"]`);
