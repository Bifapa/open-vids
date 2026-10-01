/* The home page i18n (src-tauri/src/home_page/i18n.js) against the shared locale catalog (repo-root locales/):
   every parity case in cases.json must produce the string Studio's i18next-icu produces, plus fallback,
   language resolution and the page wiring. The script is a browser global; it runs here in a node:vm context. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("../../../", import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, root), "utf8"));
const script = readFileSync(new URL("../src-tauri/src/home_page/i18n.js", import.meta.url), "utf8");

const shared = readJson("locales/cases.json");
/* The catalog ships English only; the shared cases carry a Russian fixture (plurals with few/many) that the
   tests serve as a second language, so resolution, loading and switching are exercised end to end. */
const shipped = readJson("locales/index.json");
const index = shipped.concat(Object.keys(shared.fixtures).map((code) => ({ code, name: code })));
const catalog = Object.assign(
  Object.fromEntries(shipped.map((l) => [l.code, readJson(`locales/${l.code}.json`)])),
  shared.fixtures,
);
const cases = shared.cases;

/* Values made inside the vm context have that realm's prototypes: compare plain data through JSON. */
const plain = (v) => JSON.parse(JSON.stringify(v));

function load({ language = "en", languages = [language], messages = catalog } = {}) {
  const listeners = [];
  const els = [];
  const fetched = [];
  const doc = {
    readyState: "complete",
    documentElement: { lang: "" },
    addEventListener() {},
    querySelectorAll(sel) {
      return els.filter((e) => e.matches(sel));
    },
  };
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  }
  const sandbox = {
    document: doc,
    navigator: { language, languages },
    CustomEvent,
    console,
    fetch: async (url) => {
      fetched.push(url);
      const m = /^\/locales\/(.+)\.json$/.exec(url);
      const body = m && m[1] === "index" ? index : m && messages[m[1]];
      return { ok: !!body, status: body ? 200 : 404, json: async () => body };
    },
  };
  sandbox.window = sandbox;
  sandbox.dispatchEvent = (e) => listeners.push(e);
  vm.runInNewContext(script, sandbox);
  return { i18n: sandbox.OVI18N, events: listeners, doc, els, fetched };
}

test("every locales/cases.json case formats to the expected string", () => {
  const { i18n } = load();
  assert.ok(cases.length >= 20);
  for (const c of cases) {
    const message = catalog[c.locale][c.key];
    assert.equal(
      i18n.format(message, c.params, c.locale),
      c.expected,
      `${c.locale} ${c.key} ${JSON.stringify(c.params)}`,
    );
  }
});

test("every shipped locale has exactly the keys of en", () => {
  const en = Object.keys(catalog.en).sort();
  for (const l of shipped) assert.deepEqual(Object.keys(catalog[l.code]).sort(), en, l.code);
});

test("format: parameters, nesting, exact matches, quoting, malformed input", () => {
  const { i18n } = load();
  const f = i18n.format;
  assert.equal(f("Hi {name}", { name: "Ann" }, "en"), "Hi Ann");
  assert.equal(f("Hi {name}", {}, "en"), "Hi {name}");
  assert.equal(f("{n, plural, =0 {none} one {# item} other {# items}}", { n: 0 }, "en"), "none");
  assert.equal(
    f("{n, plural, =0 {none} one {# item} other {# items}}", { n: "1" }, "en"),
    "1 item",
  );
  assert.equal(
    f("{n, plural, one {# of {total}} other {# of {total}}}", { n: 2, total: 9 }, "en"),
    "2 of 9",
  );
  assert.equal(
    f("{a, plural, one {{b, plural, one {x} other {y}}} other {z}}", { a: 1, b: 3 }, "en"),
    "y",
  );
  /* A form the locale has no branch for falls to other. */
  assert.equal(f("{n, plural, one {one} other {many}}", { n: 5 }, "ru"), "many");
  assert.equal(f("{n, plural, one {one} other {many}}", { n: "x" }, "en"), "many");
  assert.equal(f("it''s '{'literal'}' don't", {}, "en"), "it's {literal} don't");
  assert.equal(f("{n, plural, other {'#' is #}}", { n: 4 }, "en"), "# is 4");
  for (const bad of [
    "{oops",
    "a } b",
    "{n, plural, one {x}}",
    "{n, select, a {x} other {y}}",
    "{n, plural, other {x}",
  ])
    assert.equal(f(bad, { n: 1 }, "en"), bad);
});

test("resolveLanguage: preference, then navigator languages, then en", () => {
  const { i18n } = load();
  const codes = index.map((l) => l.code);
  const r = (pref, langs) => i18n.resolveLanguage(pref, langs, codes);
  assert.equal(r("ru", ["en-US"]), "ru");
  assert.equal(r("system", ["ru-RU"]), "ru");
  assert.equal(r("system", ["de", "ru-RU"]), "ru");
  assert.equal(r("system", ["de-DE", "fr"]), "en");
  assert.equal(r("system", ["RU"]), "ru");
  assert.equal(r("system", ["en-GB", "ru"]), "en");
  assert.equal(r("xx", ["ru"]), "ru");
  assert.equal(r(undefined, []), "en");
  assert.equal(r("RU", ["en"]), "ru");
});

test("t: current locale, then en, then the key", async () => {
  const messages = { en: catalog.en, ru: { ...catalog.ru } };
  delete messages.ru["home.recent.title"];
  const { i18n } = load({ languages: ["ru-RU"], messages });
  assert.equal(i18n.t("home.recent.title"), "home.recent.title");
  assert.equal(await i18n.init("system"), "ru");
  assert.equal(i18n.language(), "ru");
  assert.equal(i18n.t("settings.language.label"), catalog.ru["settings.language.label"]);
  assert.equal(i18n.t("home.recent.title"), catalog.en["home.recent.title"]);
  assert.equal(i18n.t("no.such.key"), "no.such.key");
  assert.equal(i18n.t("constructor"), "constructor");
  assert.equal(i18n.t("home.status.projects", { count: 21 }), "21 проект");
  assert.deepEqual(plain(i18n.languages()), index);
});

test("init and setLanguage: html lang, static markup, ov-language event, last call wins", async () => {
  const { i18n, events, doc, els } = load({ languages: ["de"] });
  const attrs = {};
  els.push({
    textContent: "",
    getAttribute: (n) => (n === "data-i18n" ? "home.recent.title" : null),
    setAttribute() {},
    matches: (sel) => sel === "[data-i18n]",
  });
  els.push({
    getAttribute: (n) => (n === "data-i18n-title" ? "settings.language.label" : null),
    setAttribute: (n, v) => (attrs[n] = v),
    matches: (sel) => sel === "[data-i18n-title]",
  });

  assert.equal(await i18n.init("system"), "en");
  assert.equal(doc.documentElement.lang, "en");
  assert.equal(els[0].textContent, "Recent Projects");
  assert.equal(attrs.title, "Language");
  assert.deepEqual(plain(events.map((e) => [e.type, e.detail])), [
    ["ov-language", { language: "en" }],
  ]);

  /* A slow switch superseded by a newer one never becomes active. */
  const first = i18n.setLanguage("ru");
  const second = i18n.setLanguage("en");
  await Promise.all([first, second]);
  assert.equal(i18n.language(), "en");
  assert.equal(i18n.preference(), "en");
  assert.equal(events.length, 2);

  assert.equal(await i18n.setLanguage("ru"), "ru");
  assert.equal(doc.documentElement.lang, "ru");
  assert.equal(els[0].textContent, catalog.ru["home.recent.title"]);
  assert.equal(attrs.title, catalog.ru["settings.language.label"]);
  assert.equal(events.at(-1).detail.language, "ru");
});

test("a catalog that cannot be fetched shows keys and never rejects", async () => {
  const { i18n } = load({ messages: {} });
  assert.equal(await i18n.init("ru"), "ru");
  assert.equal(i18n.t("home.recent.title"), "home.recent.title");
  assert.deepEqual(plain(i18n.languages()), index);
});

test("init with injected locale data translates synchronously and does not fetch it", () => {
  const { i18n, events, doc, els, fetched } = load({ languages: ["ru-RU"] });
  els.push({
    textContent: "",
    getAttribute: () => "home.recent.title",
    setAttribute() {},
    matches: (sel) => sel === "[data-i18n]",
  });
  const boot = { index, messages: { en: catalog.en, ru: catalog.ru } };
  const done = i18n.init("system", boot);
  /* Everything below happens before the returned promise settles. */
  assert.equal(i18n.language(), "ru");
  assert.equal(doc.documentElement.lang, "ru");
  assert.equal(els[0].textContent, catalog.ru["home.recent.title"]);
  assert.equal(i18n.t("home.status.projects", { count: 2 }), "2 проекта");
  assert.deepEqual(plain(i18n.languages()), index);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.language, "ru");
  assert.equal(fetched.length, 0);
  return done.then((code) => {
    assert.equal(code, "ru");
    assert.equal(fetched.length, 0);
  });
});

test("init with injected data fetches only a resolved locale the data lacks", async () => {
  const { i18n, events, fetched } = load({ languages: ["en"] });
  const boot = { index, messages: { en: catalog.en } };
  const done = i18n.init("ru", boot);
  assert.equal(i18n.language(), "en");
  assert.equal(i18n.t("home.recent.title"), catalog.en["home.recent.title"]);
  assert.equal(events.length, 0);
  assert.equal(await done, "ru");
  assert.deepEqual(fetched, ["/locales/ru.json"]);
  assert.equal(events.length, 1);
  assert.equal(i18n.t("home.recent.title"), catalog.ru["home.recent.title"]);
});

test("switching to a locale already in memory takes effect immediately", () => {
  const { i18n, events, fetched } = load();
  i18n.init("en", { index, messages: { en: catalog.en, ru: catalog.ru } });
  const done = i18n.setLanguage("ru");
  assert.equal(i18n.language(), "ru");
  assert.equal(events.at(-1).detail.language, "ru");
  assert.equal(fetched.length, 0);
  return done;
});

test("unusable injected data falls back to fetching", async () => {
  for (const bad of ["__OV_LOCALES__", { index, messages: {} }, { messages: { en: catalog.en } }]) {
    const { i18n, fetched } = load({ languages: ["ru"] });
    assert.equal(await i18n.init("system", bad), "ru");
    assert.deepEqual(fetched.sort(), [
      "/locales/en.json",
      "/locales/index.json",
      "/locales/ru.json",
    ]);
  }
});
