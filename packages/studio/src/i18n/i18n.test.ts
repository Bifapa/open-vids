// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import shared from "../../../../locales/cases.json";
import { parseAppPreferences, useAppPreferences } from "../components/settings/appPreferences";
import { i18n, isTranslationKey, showLanguage, startI18n, t } from ".";

// The catalog ships English only; the shared cases carry a Russian fixture (plurals with few/many) that the
// tests register as a language, so the resolution and switching paths are exercised against a second locale.
vi.mock("../../../../locales/index.json", () => ({
  default: [
    { code: "en", name: "English" },
    { code: "ru", name: "Русский" },
  ],
}));

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
  for (const [code, messages] of Object.entries(shared.fixtures)) {
    i18n.addResourceBundle(code, "translation", messages);
  }
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("catalog parity", () => {
  it("renders every shared case exactly as the Projects page does", () => {
    for (const { locale, key, params, expected } of shared.cases) {
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
  it("switches to a language whose messages are in, and leaves <html lang> to startI18n", async () => {
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
