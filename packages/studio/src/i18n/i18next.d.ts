import type en from "../../../../locales/en.json";

/**
 * Makes `t("…")` check its key against `locales/en.json`, the source of truth. The catalog is flat (dotted keys
 * are plain keys, not paths), so i18next's key and namespace separators are off.
 */
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
    keySeparator: false;
    nsSeparator: false;
    returnNull: false;
  }
}
