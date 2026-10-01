import { useAppPreferences } from "../components/settings/appPreferences";
import { i18n, showLanguage } from "./instance";
import { LANGUAGE_CODES, SYSTEM_LANGUAGE } from "./languages";
import { resolveLanguage } from "./resolveLanguage";

export { Trans, useTranslation } from "react-i18next";
export {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatList,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
} from "./format";
export { isTranslationKey, i18n, showLanguage, type TranslationKey } from "./instance";
export { LANGUAGES, LANGUAGE_CODES, type Language } from "./languages";
export { resolveLanguage } from "./resolveLanguage";

/** The query parameter the desktop sets when it opens Studio: the raw `language` preference, for the first paint. */
export const OPENVIDS_LANGUAGE_PARAM = "openvidsLanguage";

/** `t(key, options)` outside components (stores, menus); components use `useTranslation()` to re-render on change. */
export const { t } = i18n;

function show(preference: string): Promise<void> {
  return showLanguage(resolveLanguage(preference, navigator.languages, LANGUAGE_CODES));
}

/**
 * Studio's language, set once at boot: the desktop's `openvidsLanguage` parameter right away (absent means
 * `system`), then the `language` field of the app preferences once they are read, and every change after that,
 * live and without a reload. `<html lang>` follows the active language. The preferences are read by
 * `startAppTheme()`, so this does not load them a second time. Returns a function that stops following.
 */
export function startI18n(search: string = window.location.search): () => void {
  const root = document.documentElement;
  const syncLang = (language: string) => {
    if (root.lang !== language) root.lang = language;
  };
  syncLang(i18n.language);
  i18n.on("languageChanged", syncLang);

  const fromParam = new URLSearchParams(search).get(OPENVIDS_LANGUAGE_PARAM);
  const preferences = useAppPreferences.getState().preferences;
  void show(preferences?.language ?? fromParam ?? SYSTEM_LANGUAGE);

  const unsubscribe = useAppPreferences.subscribe((state, previous) => {
    const language = state.preferences?.language;
    if (language !== undefined && language !== previous.preferences?.language) void show(language);
  });
  return () => {
    unsubscribe();
    i18n.off("languageChanged", syncLang);
  };
}
