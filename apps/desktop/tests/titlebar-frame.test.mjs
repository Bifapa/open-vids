/* The Projects titlebar (index.html + home.js + home.css): on the Windows custom frame,
   the three caption buttons must be unhidden and hit-testable, the menu bar
   must follow the frame, the big wordmark must leave the layout, the mark
   must fit its button, the centred row must keep its DOM order; on every
   frame, the update pill beside Settings (shown per update phase, opens
   Settings on General).
   Runs the real page scripts in happy-dom with the boot object Rust injects
   (serve_page in home_routes.rs); /api is stubbed. Geometry (centring, gaps,
   pairwise non-overlap at 826/1100/1600/2400 px) is asserted headless-Chrome
   side in titlebar-geometry.test.mjs; this file asserts DOM/computed facts. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";

const home = new URL("../src-tauri/src/home_page/", import.meta.url);
const read = (name) => readFileSync(new URL(name, home), "utf8");
const catalogs = Object.fromEntries(
  ["en", "ru"].map((code) => [
    code,
    JSON.parse(readFileSync(new URL(`../../../locales/${code}.json`, import.meta.url), "utf8")),
  ]),
);
const sources = {
  html: read("index.html"),
  shared: read("shared.js"),
  i18n: read("i18n.js"),
  sheets: read("sheets.js"),
  design: read("design.js"),
  designSheets: read("design-sheets.js"),
  composer: read("composer.js"),
  tabs: read("tabs.js"),
  home: read("home.js"),
};

/* Minimal page: the real header markup + the real stylesheets, scripts run in
   order. fetch answers the boot-time calls home.js makes (recents, agents,
   update status, locales); anything else resolves empty. `update` is the body
   of GET /api/update/status (settable later through the returned `status`);
   `language` switches from empty messages to the real catalog in that language. */
function loadDocument({ frame, width, update = {}, language }) {
  const win = new Window({
    url: "http://127.0.0.1:1/",
    settings: { viewport: { width, height: 800 }, disableIframePageLoading: true },
  });
  const doc = win.document;
  const status = { body: update };
  const boot = {
    frame,
    intro: false,
    prefs: {
      theme: "dark",
      density: "default",
      language: language || "en",
      newProject: { location: "~/Videos/OpenVids", width: 1920, height: 1080, fps: 24 },
    },
    locales: language
      ? {
          index: [
            { code: "en", name: "English" },
            { code: "ru", name: "Русский" },
          ],
          messages: catalogs,
        }
      : { index: [], messages: { en: {} } },
    version: "0.0.0-test",
  };
  doc.write(
    sources.html
      .replace("__OPENVids_TOKEN__", "test-token")
      .replace('"__OV_BOOT__"', () => JSON.stringify(boot).replace(/</g, "\\u003c")),
  );
  doc.close();
  win.fetch = (url) => {
    const path = String(url);
    // Behavioural responses the real routes would give an empty workspace:
    // an empty recents list, an empty model catalog, no pending open, and
    // the default locations (so initStartLocation resolves synchronously).
    const bodies = {
      "/api/recents": { recents: [] },
      "/api/agent/models": { models: [] },
      "/api/agent/settings": { director: {} },
      "/api/update/status": status.body,
      "/api/open-state": { phase: "idle", opens: [] },
      "/api/tabs": { active: "home", limit: 6, tabs: [] },
      "/api/locations": { default: "/tmp", locations: [] },
    };
    const body = bodies[path] !== undefined ? bodies[path] : {};
    return Promise.resolve(
      new win.Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  win.OV_BOOT = boot;
  try {
    Object.defineProperty(win.document, "visibilityState", { value: "hidden", configurable: true });
  } catch {}
  const realSetTimeout = win.setTimeout.bind(win);
  /* happy-dom has no layout and the page polls on timers; neutralize only the
     long re-polls (badge refresh, late maximize poll) by dropping them, never
     delaying zero-delay work (a far-future stub would keep node --test alive). */
  win.setTimeout = (fn, ms, ...rest) => (Number(ms) > 100 ? 0 : realSetTimeout(fn, ms, ...rest));
  win.OV_TOKEN = "test-token";
  win.eval(sources.shared);
  win.eval(sources.i18n);
  // index.html's inline boot script does not run here: seed the catalog the way it does.
  if (language) win.eval("OVI18N.init(OV_BOOT.prefs.language, OV_BOOT.locales)");
  win.eval(sources.sheets);
  win.eval(sources.design);
  win.eval(sources.designSheets);
  win.eval(sources.composer);
  win.eval(sources.tabs);
  win.eval(sources.home);
  win.dispatchEvent(new win.Event("DOMContentLoaded"));
  win.innerWidth = width;
  win.dispatchEvent(new win.Event("resize"));
  return { win, doc, status };
}

function captionState(doc, id) {
  const el = doc.querySelector(`#${id}`);
  assert.ok(el, `#${id} exists`);
  // Behaviour, not source text: the real cascade ([hidden] -> display:none
  // from home.css/ov.css), not a reimplementation of the rule.
  const displayed = doc.defaultView
    ? doc.defaultView.getComputedStyle(el).display !== "none"
    : !el.hidden;
  return { unhidden: !el.hidden, displayed };
}

for (const width of [826, 1100, 1600, 2400]) {
  test(`custom frame at ${width}px: caption strip, wordmark, mark, row order, gear`, () => {
    const { win, doc } = loadDocument({ frame: "custom", width });
    try {
      const view = doc.defaultView;
      const shown = (el) => !!el && !el.hidden && view.getComputedStyle(el).display !== "none";
      for (const id of ["winMin", "winMax", "winClose"]) {
        const el = doc.querySelector(`#${id}`);
        assert.equal(!el.hidden, true, `#${id} keeps [hidden]`);
        assert.equal(shown(el), true, `#${id} is display:none in the cascade`);
      }
      assert.equal(doc.querySelector("#winControls").hidden, false);
      const brand = doc.querySelector("#brandWordmark");
      assert.ok(brand, "#brandWordmark exists");
      assert.equal(brand.hidden, true, "wordmark not hidden on custom frame");
      assert.equal(shown(brand), false, "wordmark still displayed on custom frame");
      const mark = doc.querySelector("#appMenuBtn svg");
      assert.ok(mark, "mark svg missing");
      assert.equal(mark.classList.contains("app-mark"), true, "mark svg lacks .app-mark");
      const mid = [...doc.querySelector("#tb-mid").children].map((el) => el.id || el.className);
      assert.deepEqual(mid, ["tb-new", "tb-search-center", "tb-tools"]);
      assert.ok(doc.querySelector("#tb-new #openBtn"), "openBtn not in #tb-new");
      assert.ok(doc.querySelector("#tb-new #newBtn"), "newBtn not in #tb-new");
      assert.ok(doc.querySelector("#tb-tools .seg"), "view toggle not in #tb-tools");
      assert.ok(doc.querySelector("#tb-tools #settingsBtn"), "gear not in #tb-tools");
      assert.equal(doc.querySelector("#tb-mid #winControls"), null, "caption inside #tb-mid");
      assert.ok(doc.querySelector(".titlebar > #winControls"), "caption not a header child");
      const use = doc.querySelector("#settingsBtn svg use");
      assert.ok(use, "gear <use> missing");
      assert.equal(use.getAttribute("href"), "#i-settings");
    } finally {
      win.happyDOM.abort();
    }
  });
}
for (const width of [826, 1100, 1600]) {
  test(`custom frame at ${width}px: min/max/close are unhidden and the menu bar follows the frame`, () => {
    const { win, doc } = loadDocument({ frame: "custom", width });
    try {
      assert.equal(doc.documentElement.classList.contains("custom-frame"), true);
      for (const id of ["winMin", "winMax", "winClose"]) {
        const st = captionState(doc, id);
        assert.equal(st.unhidden, true, `#${id} keeps [hidden] (the regression)`);
        assert.equal(st.displayed, true, `#${id} is display:none in the cascade`);
      }
      const group = doc.querySelector("#winControls");
      assert.equal(group.hidden, false);
      const bar = doc.querySelector("#menuBar");
      assert.ok(bar, "#menuBar exists");
      // Behaviour, not source text: the five labels are real buttons with
      // menu semantics, and opening File shows its dropdown in #layer.
      const labels = [...bar.querySelectorAll(".menubar-item")];
      assert.deepEqual(
        labels.map((el) => el.dataset.menu),
        ["file", "edit", "view", "window", "help"],
      );
      for (const el of labels) assert.equal(el.getAttribute("aria-haspopup"), "menu");
      // Behaviour, not source text: clicking File really opens its dropdown
      // in #layer through the shared .menu component (evaluated in-page, so
      // happy-dom's synthetic-click limits do not apply). Below 1100px the
      // labels hide into the mark's compact menu, so only assert there.
      if (!bar.hidden) {
        const opened = win.eval(
          "(() => { document.querySelector('#menuBar .menubar-item[data-menu=file]').click(); return !!document.querySelector('#layer .menu'); })()",
        );
        assert.equal(opened, true, "File dropdown opens in #layer");
      }
    } finally {
      win.happyDOM.abort();
    }
  });
}

test("overlay frame: caption buttons and menu bar stay hidden (macOS unchanged)", () => {
  const { win, doc } = loadDocument({ frame: "overlay", width: 1600 });
  try {
    assert.equal(doc.documentElement.classList.contains("custom-frame"), false);
    assert.equal(doc.querySelector("#winControls").hidden, true, "group shown on macOS");
    assert.equal(doc.querySelector("#menuBar").hidden, true);
    assert.equal(doc.querySelector("#appMenuBtn").hidden, true);
  } finally {
    win.happyDOM.abort();
  }
});

/* ---- The update pill beside Settings (home.js paintUpdate) ---- */

/* The page reads GET /api/update/status through promises: wait for the effect, never for a fixed time. */
async function waitFor(check, what) {
  const until = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < until, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const pillOf = (doc) => doc.querySelector("#updateBtn");
const pillText = (doc) => pillOf(doc).querySelector(".upd-text").textContent;

const PILL_PHASES = [
  [
    "available",
    { phase: "available", version: "0.5.0", notes: "x", date: "2026-10-05" },
    { en: "Update to 0.5.0", ru: "Обновить до 0.5.0" },
  ],
  [
    "downloading with a total",
    { phase: "downloading", version: "0.5.0", downloaded: 250, total: 1000 },
    { en: "Downloading 25%", ru: "Загрузка 25%" },
  ],
  [
    "downloading without a total",
    { phase: "downloading", version: "0.5.0", downloaded: 250, total: null },
    { en: "Downloading…", ru: "Загрузка…" },
  ],
  [
    "ready",
    { phase: "ready", version: "0.5.0", restarting: false },
    { en: "Restart to Update", ru: "Перезапустить для обновления" },
  ],
];

for (const frame of ["custom", "overlay"]) {
  for (const language of ["en", "ru"]) {
    test(`update pill (${frame} frame, ${language}): a label, name and tooltip per waiting phase`, async () => {
      for (const [name, update, text] of PILL_PHASES) {
        const { win, doc } = loadDocument({ frame, width: 1600, update, language });
        try {
          await waitFor(() => !pillOf(doc).hidden, `the pill for ${name}`);
          const pill = pillOf(doc);
          assert.equal(pillText(doc), text[language], `${name}: label`);
          assert.equal(pill.getAttribute("aria-label"), text[language], `${name}: accessible name`);
          assert.ok(pill.dataset.tip.startsWith(text[language]), `${name}: tooltip`);
          assert.equal(pill.dataset.phase, update.phase);
          assert.equal(
            doc.querySelector("#settingsBtn").classList.contains("has-update"),
            true,
            `${name}: the gear keeps its dot`,
          );
        } finally {
          win.happyDOM.abort();
        }
      }
    });
  }
}

test("update pill: a real, tabbable button between the view toggle and the gear", async () => {
  const { win, doc } = loadDocument({
    frame: "custom",
    width: 1600,
    update: PILL_PHASES[0][1],
    language: "en",
  });
  try {
    await waitFor(() => !pillOf(doc).hidden, "the pill");
    const pill = pillOf(doc);
    assert.equal(pill.tagName, "BUTTON");
    assert.equal(pill.getAttribute("type"), "button");
    assert.equal(pill.hasAttribute("tabindex"), false, "the pill stays in Tab order");
    assert.equal(pill.getAttribute("aria-haspopup"), "dialog");
    assert.deepEqual(
      [...doc.querySelector("#tb-tools").children].map((el) => el.id || el.className),
      ["seg", "updateBtn", "settingsBtn", "reportBtn"],
    );
  } finally {
    win.happyDOM.abort();
  }
});

for (const [phase, update] of [
  ["no phase", {}],
  ["idle", { phase: "idle" }],
  ["checking", { phase: "checking" }],
  ["upToDate", { phase: "upToDate" }],
  ["failed", { phase: "failed", code: "update_install_failed", error: "boom" }],
]) {
  test(`update pill: hidden in the ${phase} phase, also after one was waiting`, async () => {
    const { win, doc, status } = loadDocument({
      frame: "custom",
      width: 1600,
      update: PILL_PHASES[0][1],
      language: "en",
    });
    try {
      await waitFor(() => !pillOf(doc).hidden, "the pill");
      // The next poll is the one Settings triggers when it closes (closeSettings → loadUpdateBadge).
      status.body = update;
      pillOf(doc).click();
      const frameEl = doc.querySelector("iframe.ov-settings-frame");
      assert.ok(frameEl, "the pill opened Settings");
      win.dispatchEvent(
        new win.MessageEvent("message", {
          data: { type: "ov-settings-close" },
          source: frameEl.contentWindow,
        }),
      );
      await waitFor(() => pillOf(doc).hidden, `the pill to hide in ${phase}`);
      assert.equal(doc.querySelector("#settingsBtn").classList.contains("has-update"), false);
    } finally {
      win.happyDOM.abort();
    }
  });
}

test("update pill: a click opens Settings on General and both buttons announce it", async () => {
  const { win, doc } = loadDocument({
    frame: "overlay",
    width: 1600,
    update: PILL_PHASES[0][1],
    language: "en",
  });
  try {
    await waitFor(() => !pillOf(doc).hidden, "the pill");
    assert.equal(doc.querySelector("iframe.ov-settings-frame"), null);
    pillOf(doc).click();
    const frameEl = doc.querySelector("iframe.ov-settings-frame");
    assert.ok(frameEl, "no Settings frame after the click");
    assert.match(frameEl.getAttribute("src"), /^\/settings\?embed=1&.*&section=general$/);
    assert.equal(pillOf(doc).getAttribute("aria-expanded"), "true");
    assert.equal(doc.querySelector("#settingsBtn").getAttribute("aria-expanded"), "true");
    win.dispatchEvent(
      new win.MessageEvent("message", {
        data: { type: "ov-settings-close" },
        source: frameEl.contentWindow,
      }),
    );
    assert.equal(doc.querySelector("iframe.ov-settings-frame"), null);
    assert.equal(pillOf(doc).getAttribute("aria-expanded"), "false");
    assert.equal(doc.querySelector("#settingsBtn").getAttribute("aria-expanded"), "false");
  } finally {
    win.happyDOM.abort();
  }
});
