import { describe, expect, it } from "vitest";
import {
  TITLE_MAX_CHARS,
  extractProjectTitle,
  projectTitleInstruction,
  projectTitleUserMessage,
  sanitizeProjectTitle,
} from "./title.js";

describe("project title sanitizing", () => {
  it("keeps a plain title as it is", () => {
    expect(sanitizeProjectTitle("Interview Teaser")).toBe("Interview Teaser");
    expect(sanitizeProjectTitle("Тизер интервью")).toBe("Тизер интервью");
  });

  it("strips wrapping quotes, brackets and a leading label", () => {
    expect(sanitizeProjectTitle('"Interview Teaser"')).toBe("Interview Teaser");
    expect(sanitizeProjectTitle("«Тизер интервью»")).toBe("Тизер интервью");
    expect(sanitizeProjectTitle('«"Тизер интервью"»')).toBe("Тизер интервью");
    expect(sanitizeProjectTitle("Title: Interview Teaser")).toBe("Interview Teaser");
    expect(sanitizeProjectTitle("Заголовок: Тизер интервью")).toBe("Тизер интервью");
    expect(sanitizeProjectTitle("Here is the title: Product Launch")).toBe("Product Launch");
  });

  it("drops emoji, trailing punctuation and control characters", () => {
    expect(sanitizeProjectTitle("Product Launch 🚀")).toBe("Product Launch");
    expect(sanitizeProjectTitle("Тизер интервью.")).toBe("Тизер интервью");
    expect(sanitizeProjectTitle("Interview teaser!!!")).toBe("Interview teaser");
    expect(sanitizeProjectTitle("Line\u0000one\nTwo")).toBe("Line one Two");
    expect(sanitizeProjectTitle("Family\u200dEmoji")).toBe("FamilyEmoji");
  });

  it("replaces characters a folder name may not carry", () => {
    expect(sanitizeProjectTitle("Interview: teaser")).toBe("Interview teaser");
    expect(sanitizeProjectTitle("a/b\\c")).toBe("a b c");
    expect(sanitizeProjectTitle("Día/de la Madre")).toBe("Día de la Madre");
  });

  it("cuts long titles at a word boundary and never past the limit", () => {
    const long = sanitizeProjectTitle(
      "A very long project title that would never fit into a folder name comfortably",
    );
    expect([...long].length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(long.endsWith(" ")).toBe(false);
    expect(long).toBe("A very long project title that would");
    // A single unbroken word is cut, not dropped.
    expect([...sanitizeProjectTitle("A".repeat(80))].length).toBe(TITLE_MAX_CHARS);
    // Non-BMP characters count as one.
    expect([...sanitizeProjectTitle("🎬".repeat(80) + "Teaser")].length).toBeLessThanOrEqual(
      TITLE_MAX_CHARS,
    );
  });

  it("returns nothing usable as an empty title", () => {
    expect(sanitizeProjectTitle("")).toBe("");
    expect(sanitizeProjectTitle("   ")).toBe("");
    expect(sanitizeProjectTitle("!!!")).toBe("");
    expect(sanitizeProjectTitle("🎬🎬🎬")).toBe("");
    expect(sanitizeProjectTitle("...")).toBe("");
  });

  it("reads the <title> marker out of a completion, and tolerates a missing one", () => {
    expect(extractProjectTitle("<title>Interview Teaser</title>")).toBe("Interview Teaser");
    expect(extractProjectTitle("Here you go: <title>Тизер интервью</title>")).toBe(
      "Тизер интервью",
    );
    expect(extractProjectTitle("Interview Teaser")).toBe("Interview Teaser");
    expect(extractProjectTitle("<title>unclosed")).toBe("unclosed");
  });
});

describe("project title instruction", () => {
  it("names the language and its capitalization rule", () => {
    expect(projectTitleInstruction("ru")).toContain("Write the title in ru.");
    expect(projectTitleInstruction("ru")).toContain("capitalize only the first word");
    expect(projectTitleInstruction("en")).toContain("Title Case");
    expect(projectTitleInstruction("pt-BR")).toContain("Write the title in pt-BR.");
    expect(projectTitleInstruction(null)).toContain("language of the description");
  });

  it("carries the description and file names into the user turn", () => {
    expect(projectTitleUserMessage("Cut a teaser", ["a.mov", "b.mp3"])).toBe(
      "Description: Cut a teaser\nAttached files: a.mov, b.mp3",
    );
    expect(projectTitleUserMessage("  ", [])).toBe("Description: ");
    expect(projectTitleUserMessage("x", ["  "])).toBe("Description: x");
  });
});
