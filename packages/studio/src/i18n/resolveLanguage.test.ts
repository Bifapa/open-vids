import { describe, expect, it } from "vitest";
import { resolveLanguage } from "./resolveLanguage";

const CODES = ["en", "ru"];

describe("resolveLanguage", () => {
  it("takes an exact navigator match, ignoring case", () => {
    expect(resolveLanguage("system", ["RU"], CODES)).toBe("ru");
    expect(resolveLanguage("system", ["en"], CODES)).toBe("en");
  });

  it("falls back to the base language of a regional tag", () => {
    expect(resolveLanguage("system", ["ru-RU"], CODES)).toBe("ru");
    expect(resolveLanguage("system", ["en-GB"], CODES)).toBe("en");
  });

  it("walks the navigator languages in order and takes the first supported one", () => {
    expect(resolveLanguage("system", ["de-DE", "ru-RU", "en-US"], CODES)).toBe("ru");
    expect(resolveLanguage("system", ["fr", "en-US", "ru"], CODES)).toBe("en");
  });

  it("answers English when nothing is supported or the OS offers nothing", () => {
    expect(resolveLanguage("system", ["de-DE"], CODES)).toBe("en");
    expect(resolveLanguage("system", [], CODES)).toBe("en");
  });

  it("lets an explicit supported code win over the OS", () => {
    expect(resolveLanguage("ru", ["en-US"], CODES)).toBe("ru");
    expect(resolveLanguage("en", ["ru-RU"], CODES)).toBe("en");
  });

  it("treats an explicit code that is not supported like system", () => {
    expect(resolveLanguage("de", ["ru-RU"], CODES)).toBe("ru");
    expect(resolveLanguage("de", ["fr"], CODES)).toBe("en");
  });
});
