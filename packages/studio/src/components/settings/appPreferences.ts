import { isRecord, readErrorParams } from "@hyperframes/agent-protocol";
import { create } from "zustand";
import { describeServerError } from "../../agent/agentErrors";
import { i18n } from "../../i18n/instance";
import { LANGUAGE_CODES, SYSTEM_LANGUAGE } from "../../i18n/languages";

/**
 * The app preferences file the desktop's Projects home and Studio share (`~/.openvids/app/preferences.json`),
 * read and written through the Studio server's `GET/PUT /api/app/preferences`. The server deep-merges a PUT into
 * the stored document and answers with the effective preferences.
 */

export const APP_THEMES = ["system", "dark", "light"] as const;
export const NEW_PROJECT_WORKSPACES = ["media", "story", "edit"] as const;
export const LAUNCH_MODES = ["projects", "last"] as const;
export const NEW_PROJECT_FPS = [24, 25, 30, 60] as const;
export const APP_DENSITIES = ["default", "compact"] as const;
/** `system` follows the OS; the rest come from the shared locale catalog (`locales/index.json`). */
export const APP_LANGUAGES: readonly string[] = [SYSTEM_LANGUAGE, ...LANGUAGE_CODES];

export type AppTheme = (typeof APP_THEMES)[number];
export type NewProjectWorkspace = (typeof NEW_PROJECT_WORKSPACES)[number];
export type LaunchMode = (typeof LAUNCH_MODES)[number];
export type NewProjectFps = (typeof NEW_PROJECT_FPS)[number];
export type AppDensity = (typeof APP_DENSITIES)[number];

export interface NewProjectPreferences {
  location: string;
  openIn: NewProjectWorkspace;
  width: number;
  height: number;
  fps: NewProjectFps;
}

export interface UpdatePreferences {
  /** Stored only: the updater does not exist yet. */
  autoCheck: boolean;
}

/** Anonymous usage statistics; only the desktop shell sends them. */
export interface TelemetryPreferences {
  enabled: boolean;
}

export interface AppPreferences {
  version: 1;
  theme: AppTheme;
  newProject: NewProjectPreferences;
  confirmTrash: boolean;
  onLaunch: LaunchMode;
  density: AppDensity;
  /** `system` or a language code from the locale catalog; the server validates it, so Studio takes any string. */
  language: string;
  updates: UpdatePreferences;
  telemetry: TelemetryPreferences;
}

export interface AppPreferencesPatch {
  theme?: AppTheme;
  newProject?: Partial<NewProjectPreferences>;
  confirmTrash?: boolean;
  onLaunch?: LaunchMode;
  density?: AppDensity;
  language?: string;
  updates?: Partial<UpdatePreferences>;
  telemetry?: Partial<TelemetryPreferences>;
}

export const DEFAULT_DENSITY: AppDensity = "default";
export const DEFAULT_LANGUAGE = SYSTEM_LANGUAGE;
export const DEFAULT_UPDATES: UpdatePreferences = { autoCheck: true };
export const DEFAULT_TELEMETRY: TelemetryPreferences = { enabled: true };

const oneOf =
  <T extends string | number>(choices: readonly T[]) =>
  (value: unknown): value is T =>
    choices.some((choice) => choice === value);

export const isAppTheme = oneOf(APP_THEMES);
const isWorkspace = oneOf(NEW_PROJECT_WORKSPACES);
const isLaunchMode = oneOf(LAUNCH_MODES);
const isFps = oneOf(NEW_PROJECT_FPS);
export const isAppDensity = oneOf(APP_DENSITIES);

function isNewProjectPreferences(value: unknown): value is NewProjectPreferences {
  return (
    isRecord(value) &&
    typeof value.location === "string" &&
    isWorkspace(value.openIn) &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    isFps(value.fps)
  );
}

/** The keys every version of the file has. `density`, `language`, `updates` and `telemetry` came later and are filled in when missing. */
function hasCoreFields(value: unknown): value is Omit<
  AppPreferences,
  "density" | "language" | "updates" | "telemetry"
> & {
  density?: unknown;
  language?: unknown;
  updates?: unknown;
  telemetry?: unknown;
} {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isAppTheme(value.theme) &&
    isNewProjectPreferences(value.newProject) &&
    typeof value.confirmTrash === "boolean" &&
    isLaunchMode(value.onLaunch)
  );
}

/**
 * The preferences in a document, or null when it is not one. A document written before density, the update choice
 * and the usage statistics choice existed reads as Default density, automatic update checks and statistics on,
 * which is what the server answers too.
 */
export function parseAppPreferences(value: unknown): AppPreferences | null {
  if (!hasCoreFields(value)) return null;
  const { density, language, updates, telemetry } = value;
  return {
    version: 1,
    theme: value.theme,
    newProject: value.newProject,
    confirmTrash: value.confirmTrash,
    onLaunch: value.onLaunch,
    density: isAppDensity(density) ? density : DEFAULT_DENSITY,
    language: typeof language === "string" && language !== "" ? language : DEFAULT_LANGUAGE,
    updates: {
      autoCheck:
        isRecord(updates) && typeof updates.autoCheck === "boolean"
          ? updates.autoCheck
          : DEFAULT_UPDATES.autoCheck,
    },
    telemetry: {
      enabled:
        isRecord(telemetry) && typeof telemetry.enabled === "boolean"
          ? telemetry.enabled
          : DEFAULT_TELEMETRY.enabled,
    },
  };
}

const PREFERENCES_URL = "/api/app/preferences";

async function requestPreferences(init?: RequestInit): Promise<AppPreferences> {
  let response: Response;
  try {
    response = await fetch(PREFERENCES_URL, init);
  } catch {
    throw new Error(i18n.t("settings.studio.pref.unreachable"));
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const message =
      failure && typeof failure.message === "string"
        ? describeServerError(
            typeof failure.code === "string" ? failure.code : "",
            failure.message,
            readErrorParams(failure.params),
          )
        : i18n.t("settings.studio.pref.saveStatus", { status: response.status });
    throw new Error(message);
  }
  const preferences = parseAppPreferences(body);
  if (!preferences) throw new Error(i18n.t("settings.studio.pref.unexpected"));
  return preferences;
}

export const appPreferencesClient = {
  read: () => requestPreferences(),
  update: (patch: AppPreferencesPatch) =>
    requestPreferences({
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
};

interface AppPreferencesState {
  /** Null until the first read lands. */
  preferences: AppPreferences | null;
  loadFailed: boolean;
  /** The last failed save, shown until the next change. */
  error: string | null;
  saving: number;
  load: () => Promise<void>;
  /** Shows the change at once and saves it; a failed save puts the previous value back. */
  update: (patch: AppPreferencesPatch) => Promise<void>;
}

export const useAppPreferences = create<AppPreferencesState>((set, get) => ({
  preferences: null,
  loadFailed: false,
  error: null,
  saving: 0,
  load: async () => {
    try {
      set({ preferences: await appPreferencesClient.read(), loadFailed: false });
    } catch {
      set({ loadFailed: true });
    }
  },
  update: async (patch) => {
    const before = get().preferences;
    if (before) {
      set({
        preferences: {
          ...before,
          ...patch,
          newProject: { ...before.newProject, ...patch.newProject },
          updates: { ...before.updates, ...patch.updates },
          telemetry: { ...before.telemetry, ...patch.telemetry },
        },
      });
    }
    set((state) => ({ saving: state.saving + 1, error: null }));
    try {
      const saved = await appPreferencesClient.update(patch);
      set((state) => ({ preferences: saved, saving: state.saving - 1 }));
    } catch (error) {
      set((state) => ({
        preferences: before,
        saving: state.saving - 1,
        error: error instanceof Error ? error.message : i18n.t("settings.studio.pref.saveFailed"),
      }));
    }
  },
}));
