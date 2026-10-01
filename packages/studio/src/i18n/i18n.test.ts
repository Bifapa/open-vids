// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cases from "../../../../locales/cases.json";
import ru from "../../../../locales/ru.json";
import { parseAppPreferences, useAppPreferences } from "../components/settings/appPreferences";
import { i18n, isTranslationKey, showLanguage, startI18n, t } from ".";

const BASE = {
  version: 1,
  theme: "dark",
  newProject: { location: "~/Movies", openIn: "media", width: 1920, height: 1080, fps: 24 },
  confirmTrash: true,
  onLaunch: "projects",
};

function setPreferences(language: string): void {
  useAppPreferences.setState({ preferences: parseAppPreferences({ ...BASE, language }) });
}

beforeEach(async () => {
  useAppPreferences.setState({ preferences: null });
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("catalog parity", () => {
  it("renders every shared case exactly as the Projects page does", () => {
    i18n.addResourceBundle("ru", "translation", ru);
    for (const { locale, key, params, expected } of cases) {
      expect(isTranslationKey(key), key).toBe(true);
      if (!isTranslationKey(key)) continue;
      expect(t(key, { ...params, lng: locale }), `${locale} ${key}`).toBe(expected);
    }
  });
});

describe("fallback", () => {
  it("shows the English string for a key the current language lacks", async () => {
    i18n.addResourceBundle("zz", "translation", { "settings.language.label": "Zz" });
    await i18n.changeLanguage("zz");
    expect(t("settings.language.label")).toBe("Zz");
    expect(t("settings.language.system")).toBe("System");
  });

  it("shows the key itself when no language has it", () => {
    expect(Reflect.apply(t, i18n, ["no.such.key"])).toBe("no.such.key");
  });
});

describe("showLanguage", () => {
  it("loads the language on demand and switches to it", async () => {
    await showLanguage("ru");
    expect(i18n.language).toBe("ru");
    expect(t("settings.language.label")).toBe("Язык");
  });

  it("keeps the current language when the file cannot be loaded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await showLanguage("qq");
    expect(i18n.language).toBe("en");
  });
});

describe("startI18n", () => {
  it("starts from the desktop's openvidsLanguage parameter, resolved against the OS", async () => {
    vi.stubGlobal("navigator", { languages: ["ru-RU"] });
    const stop = startI18n("?openvidsLanguage=system");
    await vi.waitFor(() => expect(i18n.language).toBe("ru"));
    expect(document.documentElement.lang).toBe("ru");
    stop();

    await showLanguage("en");
    vi.stubGlobal("navigator", { languages: ["en-US"] });
    const stopExplicit = startI18n("?openvidsLanguage=ru");
    await vi.waitFor(() => expect(i18n.language).toBe("ru"));
    stopExplicit();
  });

  it("follows the language preference live, and leaves <html lang> in step", async () => {
    vi.stubGlobal("navigator", { languages: ["en-US"] });
    const stop = startI18n("");
    expect(i18n.language).toBe("en");

    setPreferences("system");
    await Promise.resolve();
    expect(i18n.language).toBe("en");

    setPreferences("ru");
    await vi.waitFor(() => expect(i18n.language).toBe("ru"));
    expect(document.documentElement.lang).toBe("ru");

    setPreferences("en");
    await vi.waitFor(() => expect(i18n.language).toBe("en"));
    expect(document.documentElement.lang).toBe("en");

    stop();
    setPreferences("ru");
    await Promise.resolve();
    expect(i18n.language).toBe("en");
  });
});
