import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { SegmentedControl } from "../ui/SegmentedControl";
import { useAppPreferences, type AppDensity, type AppTheme } from "./appPreferences";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsUnavailable } from "./settingsLayout";

const THEME_TILES: { value: AppTheme; label: string }[] = [
  { value: "system", label: "Match system" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

const DENSITY_OPTIONS: { value: AppDensity; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "default", label: "Default" },
];

/**
 * The prototype says "panels, lists and the inspector". Studio sizes only these from the density tokens (see
 * `theme-compact.css`): Settings rows, sidebar items (the media library, Settings), the player bar and the
 * two-line list rows built on `row-lg`. Panels' own rows and the inspector keep their sizes, so the hint says so.
 */
const DENSITY_HINTS: Record<AppDensity, string> = {
  compact: "Tighter rows, sidebar items and the player bar",
  default: "Comfortable rows, sidebar items and the player bar",
};

/**
 * Theme (Match system, Dark or Light) and Density (Compact or Default). Both apply at once (the boot code follows
 * the store) and save.
 */
export function AppearanceSection() {
  const preferences = useAppPreferences((state) => state.preferences);
  const loadFailed = useAppPreferences((state) => state.loadFailed);
  const error = useAppPreferences((state) => state.error);
  const load = useAppPreferences((state) => state.load);
  const update = useAppPreferences((state) => state.update);

  if (!preferences) {
    return (
      <SettingsPage title="Appearance">
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

  return (
    <SettingsPage title="Appearance">
      <SettingsGroup label="Interface">
        <SettingsRow label="Theme">
          <div role="group" aria-label="Theme" className="flex gap-2.5">
            {THEME_TILES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={preferences.theme === value}
                data-theme-choice={value}
                className="hf-theme-tile"
                onClick={() => {
                  if (preferences.theme !== value) void update({ theme: value });
                }}
              >
                {value === "system" ? (
                  <i className="hf-theme-swatch hf-swatch-dark" aria-hidden>
                    <span className="hf-swatch-light" />
                  </i>
                ) : (
                  <i
                    className={cn(
                      "hf-theme-swatch",
                      value === "light" ? "hf-swatch-light" : "hf-swatch-dark",
                    )}
                    aria-hidden
                  />
                )}
                {label}
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label="Density" hint={DENSITY_HINTS[preferences.density]}>
          <SegmentedControl
            label="Interface density"
            value={preferences.density}
            options={DENSITY_OPTIONS}
            onChange={(density) => void update({ density })}
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
