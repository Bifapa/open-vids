import i18n from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import en from "../../../../locales/en.json";
import { SOURCE_LANGUAGE } from "./languages";
import { loadCatalog } from "./resources";

/**
 * The one i18next instance. English is bundled, so every `t()` works from the first render; other languages
 * are added by `showLanguage` once their file has loaded. Messages are ICU MessageFormat (plurals, `{name}`),
 * and the catalog is flat, so the key and namespace separators are off.
 */
void i18n
  .use(ICU)
  .use(initReactI18next)
  .init({
    lng: SOURCE_LANGUAGE,
    fallbackLng: SOURCE_LANGUAGE,
    keySeparator: false,
    nsSeparator: false,
    resources: { [SOURCE_LANGUAGE]: { translation: en } },
    interpolation: { escapeValue: false },
    returnNull: false,
    // Resources are inline, so there is nothing to wait for: `t()` must answer synchronously right after import.
    initAsync: false,
    react: { useSuspense: false },
  });

/** A key that exists in `locales/en.json`. */
export type TranslationKey = keyof typeof en;

export function isTranslationKey(key: string): key is TranslationKey {
  return Object.hasOwn(en, key);
}

let latestRequest = 0;

/**
 * Switches the app to `code`: loads its messages when they are not in yet, then changes language. Nothing
 * changes until the messages are there, so the screen never shows keys; of two overlapping calls only the
 * last one lands. A language that fails to load leaves the current one.
 */
export async function showLanguage(code: string): Promise<void> {
  const request = ++latestRequest;
  if (!i18n.hasResourceBundle(code, "translation")) {
    try {
      i18n.addResourceBundle(code, "translation", await loadCatalog(code));
    } catch (error) {
      console.warn(`[i18n] Language "${code}" is unavailable.`, error);
      return;
    }
  }
  if (request !== latestRequest || i18n.language === code) return;
  await i18n.changeLanguage(code);
}

export { i18n };
