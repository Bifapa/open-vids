import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { useAppPreferences, type AppTheme } from "./appPreferences";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsUnavailable } from "./settingsLayout";

const THEME_TILES: { value: AppTheme; label: string }[] = [
  { value: "system", label: "Match system" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/** Theme: Match system, Dark or Light. Applies at once (the boot theme follows the store) and saves. */
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
        <SettingsRow label="Theme" className="py-2">
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
      </SettingsGroup>
      {error && (
        <p role="alert" className="mx-0.5 mt-2 text-xs text-error">
          {error}
        </p>
      )}
    </SettingsPage>
  );
}
