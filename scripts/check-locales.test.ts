import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkLocaleCatalog, extractIcuArguments } from "./check-locales.ts";

const INDEX = [
  { code: "en", name: "English" },
  { code: "ru", name: "Русский" },
];

const EN = {
  plain: "Language",
  projects: "{count, plural, one {# project} other {# projects}}",
  fps: "{fps} fps",
};

const RU = {
  plain: "Язык",
  projects: "{count, plural, one {# проект} few {# проекта} many {# проектов} other {# проекта}}",
  fps: "{fps} к/с",
};

function catalog(index: unknown, locales: Record<string, unknown>) {
  return checkLocaleCatalog(index, locales);
}

describe("locale catalog checker", () => {
  it("accepts the current en/ru catalog without failures", () => {
    assert.deepEqual(catalog(INDEX, { en: EN, ru: RU }), { failures: [], warnings: [] });
  });

  it("reports a missing key as a warning, not a failure", () => {
    const { plain: _omitted, ...partial } = RU;
    assert.equal(typeof _omitted, "string");
    const result = catalog(INDEX, { en: EN, ru: partial });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.warnings, ['ru.json: missing key "plain" (English fallback is used)']);
  });

  it("fails on an extra key that is not in en.json", () => {
    const result = catalog(INDEX, { en: EN, ru: { ...RU, bonus: "Бонус" } });
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.failures, ['ru.json: extra key "bonus" (not in en.json)']);
  });

  it("fails when a message does not parse", () => {
    const result = catalog(INDEX, { en: EN, ru: { ...RU, plain: "{oops" } });
    assert.ok(
      result.failures.some((failure) => failure.startsWith('ru.json: key "plain" does not parse:')),
      `expected a parse failure, got ${JSON.stringify(result.failures)}`,
    );
  });

  it("fails when a locale names different arguments than en", () => {
    const result = catalog(INDEX, { en: EN, ru: { ...RU, fps: "{speed} к/с" } });
    assert.deepEqual(result.failures, [
      'ru.json: key "fps" names different arguments (en: {fps}, ru: {speed})',
    ]);
  });

  it("fails when a locale file is not a flat object of strings", () => {
    const nested = catalog(INDEX, { en: EN, ru: { ...RU, plain: { text: "Язык" } } });
    assert.deepEqual(nested.failures, ['ru.json: key "plain" must be a string message']);
    const listed = catalog(INDEX, { en: EN });
    assert.deepEqual(listed.failures, ["ru.json: file not found (locales/ru.json)"]);
  });

  it("validates the index: array shape, unique codes, en listed", () => {
    assert.deepEqual(catalog({ code: "en" }, { en: EN }).failures, [
      "index.json: expected an array of {code, name}",
    ]);
    assert.deepEqual(catalog([{ code: "", name: "" }], { en: EN }).failures, [
      "index.json: every entry must be {code, name} with non-empty strings",
      'index.json: "en" must be listed (source of truth)',
    ]);
    assert.deepEqual(
      catalog(
        [
          { code: "en", name: "English" },
          { code: "en", name: "English" },
        ],
        { en: EN },
      ).failures,
      ['index.json: duplicate code "en"'],
    );
    assert.deepEqual(catalog([{ code: "ru", name: "Русский" }], { en: EN, ru: RU }).failures, [
      'index.json: "en" must be listed (source of truth)',
    ]);
  });
});

describe("extractIcuArguments", () => {
  it("collects argument names from plurals and nested options", () => {
    assert.deepEqual(
      [
        ...extractIcuArguments(
          "{count, plural, one {{who} took # apple} other {{who} took # apples}}",
        ),
      ],
      ["count", "who"],
    );
    assert.deepEqual([...extractIcuArguments("{fps} fps")], ["fps"]);
    assert.deepEqual([...extractIcuArguments("No arguments here")], []);
  });

  it("rejects unbalanced braces, unknown formats and bad plural selectors", () => {
    assert.throws(() => extractIcuArguments("{oops"), /argument "oops"/);
    assert.throws(() => extractIcuArguments("oops}"), /Unmatched/);
    assert.throws(() => extractIcuArguments("{count, bogus, other {#}}"), /Unknown format/);
    assert.throws(
      () => extractIcuArguments("{count, plural, one {#} few {#}}"),
      /missing the "other" option/,
    );
  });
});
