import { useAppPreferences, type AppTheme } from "./appPreferences";

/** URL parameter the desktop sets when it opens a project: the theme it resolved, for the first paint. */
export const OPENVIDS_THEME_PARAM = "openvidsTheme";

export type ResolvedTheme = "dark" | "light";

const SYSTEM_LIGHT_QUERY = "(prefers-color-scheme: light)";

/** `system` follows the OS; dark and light are themselves. */
export function resolveTheme(theme: AppTheme, systemPrefersLight: boolean): ResolvedTheme {
  if (theme === "system") return systemPrefersLight ? "light" : "dark";
  return theme;
}

/** Dark is the default `:root`; the light tokens hang off `:root[data-theme="light"]`. */
export function applyResolvedTheme(theme: ResolvedTheme, root: HTMLElement): void {
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
}

function themeFromParam(search: string): ResolvedTheme | null {
  const raw = new URLSearchParams(search).get(OPENVIDS_THEME_PARAM);
  return raw === "dark" || raw === "light" ? raw : null;
}

/**
 * Studio's theme, applied once at boot before the first render: the desktop's `openvidsTheme` parameter right
 * away, then the app preferences file, and for `system` the OS appearance, followed live.
 */
export function startAppTheme(): void {
  const root = document.documentElement;
  const fromParam = themeFromParam(window.location.search);
  if (fromParam) applyResolvedTheme(fromParam, root);

  const media = window.matchMedia(SYSTEM_LIGHT_QUERY);
  const apply = () => {
    const theme = useAppPreferences.getState().preferences?.theme;
    if (theme) applyResolvedTheme(resolveTheme(theme, media.matches), root);
  };
  media.addEventListener("change", apply);
  useAppPreferences.subscribe((state, previous) => {
    if (state.preferences?.theme !== previous.preferences?.theme) apply();
  });
  void useAppPreferences.getState().load();
}
