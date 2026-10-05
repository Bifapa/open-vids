// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ru from "../../../../locales/ru.json";
import { i18n, t } from "../i18n";
import { describeServerError } from "./agentErrors";

beforeEach(async () => {
  i18n.addResourceBundle("ru", "translation", ru);
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("describeServerError", () => {
  it("translates a known code with its params, and back to English when the language changes", async () => {
    const message = 'Invalid value for "theme"';
    expect(describeServerError("invalid_preferences.value", message, { key: "theme" })).toBe(
      message,
    );
    await i18n.changeLanguage("ru");
    expect(describeServerError("invalid_preferences.value", message, { key: "theme" })).toBe(
      "Недопустимое значение для «theme»",
    );
    await i18n.changeLanguage("en");
    expect(describeServerError("invalid_preferences.value", message, { key: "theme" })).toBe(
      message,
    );
  });

  it("keeps the server's own message when no key exists for the code", () => {
    expect(describeServerError("some_unknown_code", "The server said no.")).toBe(
      "The server said no.",
    );
  });

  it("renders the activity and QA catalogs under ru, plurals included", async () => {
    await i18n.changeLanguage("ru");
    expect(t("activity.reading_files", { count: 2 })).toBe("Чтение 2 файлов");
    expect(t("activity.reading_files", { count: 1 })).toBe("Чтение 1 файла");
    expect(t("activity.inspecting_timeline")).toBe("Осмотр таймлайна");
    expect(t("activity.downloading_site_file_host", { host: "linear.app" })).toBe(
      "Скачивание файла с linear.app",
    );
    expect(t("activity.recording_host", { host: "linear.app" })).toBe(
      "Запись страницы · linear.app",
    );
    expect(t("qa.reason.pass_limit")).toBe("Достигнут предел проходов.");
  });

  it("uses all four Russian plural forms for change and clip counts", async () => {
    await i18n.changeLanguage("ru");
    for (const key of [
      "activity.editing_story_changes",
      "activity.editing_timeline",
      "activity.checking_timeline_edit",
    ] as const) {
      const forms = [1, 2, 5, 21].map((count) => t(key, { count }));
      expect(forms[0], key).toMatch(/ 1 изменение$/);
      expect(forms[1], key).toMatch(/ 2 изменения$/);
      expect(forms[2], key).toMatch(/ 5 изменений$/);
      expect(forms[3], key).toMatch(/ 21 изменение$/);
    }
    expect(t("qa.scope.small_change", { count: 1 })).toContain("сдвинут 1 клип,");
    expect(t("qa.scope.small_change", { count: 3 })).toContain("сдвинуто 3 клипа,");
    expect(t("qa.scope.small_change", { count: 7 })).toContain("сдвинуто 7 клипов,");
  });
});
