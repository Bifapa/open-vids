import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";

/**
 * App preferences shared by the desktop's Projects home and Studio: one JSON file,
 * `~/.openvids/app/preferences.json` (directory overridable with `OPENVIDS_APP_DIR`). The desktop
 * (`apps/desktop/src-tauri/src/prefs.rs`) reads and writes the same file under the same rules:
 *
 * - a missing or unreadable file means the defaults;
 * - on read, a known key with an invalid value falls back to its default;
 * - unknown keys (another side's, a newer app's) are kept: an update is a deep merge into the stored document;
 * - writes are atomic (temp file + rename).
 *
 * The file is re-read on every request: the desktop may have changed it since.
 */

export const APP_THEMES = ["system", "dark", "light"] as const;
export const NEW_PROJECT_WORKSPACES = ["media", "story", "edit"] as const;
export const LAUNCH_MODES = ["projects", "last"] as const;
export const NEW_PROJECT_FPS = [24, 25, 30, 60] as const;
export const MAX_FRAME_SIZE = 8192;
const MAX_LOCATION_LENGTH = 1024;
const PREFERENCES_FILE = "preferences.json";

export type AppTheme = (typeof APP_THEMES)[number];
export type NewProjectWorkspace = (typeof NEW_PROJECT_WORKSPACES)[number];
export type LaunchMode = (typeof LAUNCH_MODES)[number];
export type NewProjectFps = (typeof NEW_PROJECT_FPS)[number];

export interface NewProjectPreferences {
  location: string;
  openIn: NewProjectWorkspace;
  width: number;
  height: number;
  fps: NewProjectFps;
}

/** The effective preferences. Unknown keys of the stored document ride along in responses. */
export interface AppPreferences {
  version: 1;
  theme: AppTheme;
  newProject: NewProjectPreferences;
  confirmTrash: boolean;
  onLaunch: LaunchMode;
}

export function defaultAppPreferences(): AppPreferences {
  return {
    version: 1,
    theme: "system",
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
}

export function defaultAppDir(): string {
  return process.env.OPENVIDS_APP_DIR || join(homedir(), ".openvids", "app");
}

/** A PUT body that names a known key with a value outside its contract. */
export class InvalidPreferencesError extends Error {}

const oneOf =
  <T extends string | number>(choices: readonly T[]) =>
  (value: unknown): value is T =>
    choices.some((choice) => choice === value);

const isTheme = oneOf(APP_THEMES);
const isWorkspace = oneOf(NEW_PROJECT_WORKSPACES);
const isLaunchMode = oneOf(LAUNCH_MODES);
const isFps = oneOf(NEW_PROJECT_FPS);
const isFrameSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_FRAME_SIZE;
const isLocation = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= MAX_LOCATION_LENGTH &&
  (value.trim().startsWith("/") || value.trim().startsWith("~"));

type Document = Record<string, unknown>;

/** The stored document with every known key validated (invalid or missing → default), unknown keys kept. */
function normalize(stored: Document): Document & AppPreferences {
  const base = defaultAppPreferences();
  const project = isRecord(stored.newProject) ? stored.newProject : {};
  const newProject: Document & NewProjectPreferences = {
    ...project,
    location: isLocation(project.location) ? project.location.trim() : base.newProject.location,
    openIn: isWorkspace(project.openIn) ? project.openIn : base.newProject.openIn,
    width: isFrameSize(project.width) ? project.width : base.newProject.width,
    height: isFrameSize(project.height) ? project.height : base.newProject.height,
    fps: isFps(project.fps) ? project.fps : base.newProject.fps,
  };
  return {
    ...stored,
    version: 1,
    theme: isTheme(stored.theme) ? stored.theme : base.theme,
    onLaunch: isLaunchMode(stored.onLaunch) ? stored.onLaunch : base.onLaunch,
    confirmTrash:
      typeof stored.confirmTrash === "boolean" ? stored.confirmTrash : base.confirmTrash,
    newProject,
  };
}

const KNOWN_TOP: Record<string, (value: unknown) => boolean> = {
  theme: isTheme,
  onLaunch: isLaunchMode,
  confirmTrash: (value) => typeof value === "boolean",
  version: (value) => value === 1,
};

const KNOWN_NEW_PROJECT: Record<string, (value: unknown) => boolean> = {
  location: isLocation,
  openIn: isWorkspace,
  width: isFrameSize,
  height: isFrameSize,
  fps: isFps,
};

/** Refuses a patch whose known keys carry invalid values; unknown keys pass untouched. */
export function validatePreferencesPatch(patch: unknown): Document {
  if (!isRecord(patch)) throw new InvalidPreferencesError("Preferences must be a JSON object");
  for (const [key, check] of Object.entries(KNOWN_TOP)) {
    if (key in patch && !check(patch[key])) {
      throw new InvalidPreferencesError(`Invalid value for "${key}"`);
    }
  }
  if ("newProject" in patch) {
    const project = patch.newProject;
    if (!isRecord(project)) throw new InvalidPreferencesError(`"newProject" must be an object`);
    for (const [key, check] of Object.entries(KNOWN_NEW_PROJECT)) {
      if (key in project && !check(project[key])) {
        throw new InvalidPreferencesError(`Invalid value for "newProject.${key}"`);
      }
    }
  }
  return patch;
}

/** Deep merge: objects merge key by key, any other value replaces. */
function merge(target: Document, patch: Document): Document {
  const out: Document = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    out[key] = isRecord(existing) && isRecord(value) ? merge(existing, value) : value;
  }
  return out;
}

export class AppPreferencesStore {
  readonly path: string;

  constructor(options: { dir?: string } = {}) {
    this.path = join(options.dir ?? defaultAppDir(), PREFERENCES_FILE);
  }

  private readRaw(): Document {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  read(): Document & AppPreferences {
    return normalize(this.readRaw());
  }

  /** Validates `patch`, deep-merges it into the stored document and writes the effective result atomically. */
  update(patch: unknown): Document & AppPreferences {
    const valid = validatePreferencesPatch(patch);
    const next = normalize(merge(this.readRaw(), valid));
    mkdirSync(dirname(this.path), { recursive: true });
    replaceFileAtomically(this.path, `${JSON.stringify(next, null, 2)}\n`, 0o644);
    return next;
  }
}
