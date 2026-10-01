import { useTranslation, type TranslationKey } from "../../i18n";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { SegmentedControl } from "../ui/SegmentedControl";
import { useAppPreferences, type AppDensity, type AppTheme } from "./appPreferences";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsUnavailable } from "./settingsLayout";

const THEME_TILES: { value: AppTheme; label: TranslationKey }[] = [
  { value: "system", label: "settings.appearance.theme.system" },
  { value: "dark", label: "settings.appearance.theme.dark" },
  { value: "light", label: "settings.appearance.theme.light" },
];

const DENSITY_OPTIONS: { value: AppDensity; label: TranslationKey }[] = [
  { value: "compact", label: "settings.appearance.density.compact" },
  { value: "default", label: "settings.appearance.density.default" },
];

/**
 * The prototype says "panels, lists and the inspector". Studio sizes only these from the density tokens (see
 * `theme-compact.css`): Settings rows, sidebar items (the media library, Settings), the player bar and the
 * two-line list rows built on `row-lg`. Panels' own rows and the inspector keep their sizes, so the hint says so.
 */
const DENSITY_HINTS: Record<AppDensity, TranslationKey> = {
  compact: "settings.studio.ap.hintCompact",
  default: "settings.studio.ap.hintDefault",
};

/**
 * Theme (Match system, Dark or Light) and Density (Compact or Default). Both apply at once (the boot code follows
 * the store) and save.
 */
export function AppearanceSection() {
  const { t } = useTranslation();
  const preferences = useAppPreferences((state) => state.preferences);
  const loadFailed = useAppPreferences((state) => state.loadFailed);
  const error = useAppPreferences((state) => state.error);
  const load = useAppPreferences((state) => state.load);
  const update = useAppPreferences((state) => state.update);

  if (!preferences) {
    return (
      <SettingsPage title={t("settings.section.appearance")}>
        <SettingsUnavailable
          message={
            loadFailed
              ? t("settings.studio.general.unavailable")
              : t("settings.loading.preferences")
          }
          action={
            loadFailed ? (
              <Button size="sm" onClick={() => void load()}>
                {t("common.tryAgain")}
              </Button>
            ) : undefined
          }
        />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title={t("settings.section.appearance")}>
      <SettingsGroup label={t("settings.appearance.group.interface")}>
        <SettingsRow label={t("settings.appearance.theme")}>
          <div role="group" aria-label={t("settings.appearance.theme")} className="flex gap-2.5">
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
                {t(label)}
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          label={t("settings.appearance.density")}
          hint={t(DENSITY_HINTS[preferences.density])}
        >
          <SegmentedControl
            label={t("settings.appearance.density.aria")}
            value={preferences.density}
            options={DENSITY_OPTIONS.map(({ value, label }) => ({ value, label: t(label) }))}
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
