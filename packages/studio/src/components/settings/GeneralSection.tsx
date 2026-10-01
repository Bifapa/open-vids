import { useRef, useState } from "react";
import { FolderSimple } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Select, type SelectOption } from "../ui/Select";
import { Toggle } from "../ui/Toggle";
import { LANGUAGES, useTranslation } from "../../i18n";
import {
  APP_LANGUAGES,
  NEW_PROJECT_FPS,
  useAppPreferences,
  type AppPreferencesPatch,
  type LaunchMode,
  type NewProjectPreferences,
  type NewProjectWorkspace,
} from "./appPreferences";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsUnavailable } from "./settingsLayout";

const WORKSPACE_OPTIONS: { value: NewProjectWorkspace; label: string }[] = [
  { value: "media", label: "Media" },
  { value: "story", label: "Story" },
  { value: "edit", label: "Edit" },
];

const FORMATS: { width: number; height: number; label: string }[] = [
  { width: 1920, height: 1080, label: "1920 × 1080 · 16:9" },
  { width: 3840, height: 2160, label: "3840 × 2160 · 16:9" },
  { width: 1080, height: 1920, label: "1080 × 1920 · 9:16" },
  { width: 1080, height: 1080, label: "1080 × 1080 · 1:1" },
];

const FPS_OPTIONS: SelectOption[] = NEW_PROJECT_FPS.map((fps) => ({
  value: String(fps),
  label: `${fps} fps`,
}));

const LAUNCH_OPTIONS: { value: LaunchMode; label: string }[] = [
  { value: "last", label: "Reopen last project" },
  { value: "projects", label: "Show Projects" },
];

/** A format the file holds that is not one of the presets is still shown, as itself. */
function formatOptions({ width, height }: NewProjectPreferences): SelectOption[] {
  const options = FORMATS.map((format) => ({
    value: `${format.width}x${format.height}`,
    label: format.label,
  }));
  const current = `${width}x${height}`;
  if (!options.some((option) => option.value === current)) {
    options.push({ value: current, label: `${width} × ${height}` });
  }
  return options;
}

function LocationField({
  location,
  onCommit,
}: {
  location: string;
  onCommit: (location: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  // Set synchronously by the commit that runs on blur, read by the wrapper's blur right after it.
  const rejected = useRef(false);

  if (editing) {
    return (
      <div
        className="flex min-w-0 flex-col items-end gap-1"
        onBlur={() => {
          if (!rejected.current) {
            setInvalid(false);
            setEditing(false);
          }
          rejected.current = false;
        }}
      >
        <Input
          size="md"
          autoFocus
          aria-label="New project location"
          value={location}
          invalid={invalid}
          spellCheck={false}
          className="w-64 font-mono text-num"
          onCommit={(next) => {
            const path = next.trim();
            rejected.current = !path.startsWith("/") && !path.startsWith("~");
            setInvalid(rejected.current);
            if (rejected.current) return;
            setEditing(false);
            onCommit(path);
          }}
        />
        {invalid && (
          <p role="alert" className="m-0 text-xs text-error">
            Use a full folder path, like ~/Movies/OpenVids.
          </p>
        )}
      </div>
    );
  }
  return (
    <>
      <span
        title={location}
        className="flex h-ctl min-w-0 max-w-60 items-center gap-1.5 rounded-md border border-border bg-bg-0 px-2.5 font-mono text-num text-fg-2"
      >
        <FolderSimple aria-hidden className="size-icon-sm shrink-0 text-fg-3" />
        <span className="truncate">{location}</span>
      </span>
      <Button onClick={() => setEditing(true)}>Change…</Button>
    </>
  );
}

/** App-wide defaults from the preferences file the Projects page shares. */
export function GeneralSection() {
  const { t } = useTranslation();
  const preferences = useAppPreferences((state) => state.preferences);
  const loadFailed = useAppPreferences((state) => state.loadFailed);
  const error = useAppPreferences((state) => state.error);
  const load = useAppPreferences((state) => state.load);
  const update = useAppPreferences((state) => state.update);

  if (!preferences) {
    return (
      <SettingsPage title="General">
        <SettingsUnavailable
          message={loadFailed ? "Preferences are unavailable right now." : "Loading preferences…"}
          action={
            loadFailed ? (
              <Button size="sm" onClick={() => void load()}>
                Try again
              </Button>
            ) : undefined
          }
        />
      </SettingsPage>
    );
  }

  const { newProject } = preferences;
  const save = (patch: AppPreferencesPatch) => void update(patch);
  const saveProject = (patch: Partial<NewProjectPreferences>) => save({ newProject: patch });

  return (
    <SettingsPage title="General">
      <SettingsGroup label="New projects" note="Changes apply to projects you create next">
        <SettingsRow label="Location">
          <LocationField
            location={newProject.location}
            onCommit={(location) => saveProject({ location })}
          />
        </SettingsRow>
        <SettingsRow label="Open in">
          <SegmentedControl
            label="Open new projects in"
            value={newProject.openIn}
            options={WORKSPACE_OPTIONS}
            onChange={(openIn) => saveProject({ openIn })}
          />
        </SettingsRow>
        <SettingsRow label="Format">
          <Select
            size="md"
            label="Default format"
            className="min-w-[150px]"
            value={`${newProject.width}x${newProject.height}`}
            options={formatOptions(newProject)}
            onCommit={(next) => {
              const [width, height] = next.split("x").map(Number);
              if (width && height) saveProject({ width, height });
            }}
          />
        </SettingsRow>
        <SettingsRow label="Frame rate">
          <Select
            size="md"
            label="Default frame rate"
            className="min-w-[150px]"
            value={String(newProject.fps)}
            options={FPS_OPTIONS}
            onCommit={(next) => {
              const fps = NEW_PROJECT_FPS.find((choice) => String(choice) === next);
              if (fps) saveProject({ fps });
            }}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup label="App">
        <SettingsRow label={t("settings.language.label")}>
          <Select
            size="md"
            label={t("settings.language.label")}
            className="min-w-[150px]"
            value={preferences.language}
            options={[
              { value: "system", label: t("settings.language.system") },
              ...LANGUAGES.map(({ code, name }) => ({ value: code, label: name })),
            ]}
            onCommit={(next) => {
              const language = APP_LANGUAGES.find((code) => code === next);
              if (language) save({ language });
            }}
          />
        </SettingsRow>
        <SettingsRow label="On launch">
          <Select
            size="md"
            label="On launch"
            className="min-w-[150px]"
            value={preferences.onLaunch}
            options={LAUNCH_OPTIONS}
            onCommit={(next) => {
              const onLaunch = LAUNCH_OPTIONS.find((option) => option.value === next)?.value;
              if (onLaunch) save({ onLaunch });
            }}
          />
        </SettingsRow>
        <SettingsRow label="Confirm before moving projects to Trash">
          <Toggle
            label="Confirm before moving projects to Trash"
            checked={preferences.confirmTrash}
            onCommit={(confirmTrash) => save({ confirmTrash })}
          />
        </SettingsRow>
        <SettingsRow label="Check for updates automatically">
          <Toggle
            label="Check for updates automatically"
            checked={preferences.updates.autoCheck}
            onCommit={(autoCheck) => save({ updates: { autoCheck } })}
          />
        </SettingsRow>
      </SettingsGroup>
      {error && (
        <p role="alert" className="mx-0.5 mt-2 text-xs text-error">
          {error}
        </p>
      )}
    </SettingsPage>
  );
}
