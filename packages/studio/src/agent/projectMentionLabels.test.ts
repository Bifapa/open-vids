// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ru from "../../../../locales/ru.json";
import { i18n } from "../i18n";
import { projectChipLabel } from "./projectMentionLabels";

beforeEach(async () => {
  i18n.addResourceBundle("ru", "translation", ru);
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("projectChipLabel", () => {
  it("names the project and its parts in the user's language", async () => {
    expect(projectChipLabel("Promo", ["renders", "music"])).toBe("Promo · renders, music");
    expect(projectChipLabel("Promo", ["audio", "images", "video"])).toBe(
      "Promo · other audio, images, video",
    );
    await i18n.changeLanguage("ru");
    expect(projectChipLabel("Promo", ["renders", "music"])).toBe("Promo · рендеры, музыка");
  });

  it("says everything for All, in both languages", async () => {
    expect(projectChipLabel("Promo", ["all"])).toBe("Promo · everything");
    await i18n.changeLanguage("ru");
    expect(projectChipLabel("Promo", ["all"])).toBe("Promo · всё");
  });

  it("keeps a name with braces or punctuation as it is", () => {
    expect(projectChipLabel("{Intro} · v2", ["story"])).toBe("{Intro} · v2 · story");
  });
});
