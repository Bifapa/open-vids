/* The Projects page's Design systems section (home_page/design.js + design-sheets.js): shown only in beta builds,
   cards with the honest caveats, rename / delete / view / create flows and the New Project picker. The page scripts are
   browser globals; they run in a happy-dom window with a fake home server (fetch) behind them. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Window } from "happy-dom";

const root = new URL("../../../", import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, root), "utf8"));
const page = (name) =>
  readFileSync(new URL(`../src-tauri/src/home_page/${name}`, import.meta.url), "utf8");

const index = readJson("locales/index.json");
const catalog = Object.fromEntries(index.map((l) => [l.code, readJson(`locales/${l.code}.json`)]));

const SYSTEMS = () => [
  {
    id: "plain",
    name: "Plain",
    version: 3,
    source: { kind: "scratch" },
    updatedAt: 3000,
    palette: ["#101010", "#fafafa", "oklch(70% 0.15 40)"],
    displayFont: "Inter",
    unknownLicenses: [],
    nonPortableFonts: [],
  },
  {
    id: "risky",
    name: '<img src=x onerror="boom()">',
    version: 1,
    source: { kind: "website", ref: "harbor.example" },
    updatedAt: 2000,
    palette: ["#000", "red;background:url(https://evil.example/x)", "#0af"],
    displayFont: "Playfair Display",
    unknownLicenses: ["font:Playfair Display", "logo"],
    nonPortableFonts: ["Helvetica Neue"],
  },
  {
    id: "third",
    name: "Third",
    version: 2,
    source: { kind: "video", ref: "clip.mp4" },
    updatedAt: 1000,
    palette: [],
    displayFont: null,
    unknownLicenses: [],
    nonPortableFonts: [],
  },
];
const DETAIL = {
  risky: {
    fonts: [
      {
        family: "Playfair Display",
        role: "display",
        source: "file",
        portable: true,
        licenseName: null,
        guess: false,
      },
      {
        family: "Helvetica Neue",
        role: "body",
        source: "system",
        portable: false,
        licenseName: null,
        guess: true,
      },
    ],
    transitions: 2,
    versions: 1,
  },
};
const PROJECTS = [
  { id: "a", name: "Alpha", path: "/p/a", ts: 2, missing: false },
  { id: "b", name: "Beta", path: "/p/b", ts: 3, missing: false },
  { id: "gone", name: "Gone", path: "/p/gone", ts: 9, missing: true },
];

/* A page with the scripts loaded and a fake home server; `server` says how the library answers. */
function load({ beta = true, systems = SYSTEMS(), projects = PROJECTS, listFails = false } = {}) {
  const win = new Window({ url: "http://localhost/" });
  const requests = [];
  const store = { systems, listFails };
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  win.fetch = async (path, init = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, body });
    const m = /^\/api\/design-systems(?:\/([^/]+))?$/.exec(path);
    if (!m) return reply(404, { error: { code: "not_found", message: "not found" } });
    const id = m[1];
    if (!id) {
      return store.listFails
        ? reply(503, { error: { code: "unavailable", message: "permission denied" } })
        : reply(200, { systems: store.systems });
    }
    const s = store.systems.find((x) => x.id === id);
    if (!s) return reply(404, { error: { code: "not_found", message: "missing" } });
    if (method === "PATCH") {
      s.name = body.name;
      return reply(200, s);
    }
    if (method === "DELETE") {
      store.systems = store.systems.filter((x) => x.id !== id);
      return reply(200, { ok: true });
    }
    return reply(200, { ...s, ...(DETAIL[id] || { fonts: [], transitions: 0, versions: 1 }) });
  };
  win.OV_BOOT = { betaFeatures: beta };
  win.document.body.innerHTML =
    '<div class="window" id="win"><main class="main" id="main"><section id="recent"></section></main><div id="layer"></div></div>';
  for (const name of ["shared.js", "i18n.js"]) win.eval(page(name));
  win.OVI18N.init("en", { index, messages: catalog });
  for (const name of ["sheets.js", "design.js", "design-sheets.js"]) win.eval(page(name));
  const opened = [];
  win.OVDesign.mount({
    recent: win.document.getElementById("recent"),
    main: win.document.getElementById("main"),
    projects: () => projects,
    open: (p, extra) => opened.push({ id: p.id, extra }),
  });
  return { win, doc: win.document, requests, opened, store };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const key = (win, el, k, init = {}) =>
  el.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
  );
const card = (doc, id) => doc.querySelector(`[data-ds][data-id="${id}"]`);

test("a stable build draws nothing and never asks the library", async () => {
  const { win, doc, requests } = load({ beta: false });
  await settle();
  assert.equal(doc.getElementById("designs"), null);
  assert.deepEqual(requests, []);
  assert.equal(win.OVDesign.pickerHtml(), "");
  assert.equal(win.OVDesign.bindPicker(doc.body).id(), null);
  assert.equal(win.OVDesign.warning({ designWarning: "x" }), "");
  win.happyDOM.abort();
});

test("cards show source, honest caveats, and only validated markup", async () => {
  const { win, doc } = load();
  await settle();
  const cards = [...doc.querySelectorAll("[data-ds]")];
  assert.deepEqual(
    cards.map((c) => c.dataset.id),
    ["plain", "risky", "third"],
  );
  const label = (id) => card(doc, id).getAttribute("aria-label");
  assert.equal(label("plain"), "Plain, version 3, From a brief");
  assert.match(label("risky"), /License unknown, System font$/);
  assert.equal(card(doc, "plain").querySelectorAll(".badge.warning").length, 0);
  assert.equal(card(doc, "risky").querySelectorAll(".badge.warning").length, 2);
  /* The thumbnail is the token-free file route; the server's HTML in a name is text, never markup. */
  assert.equal(
    card(doc, "plain").querySelector("img").getAttribute("src").split("?")[0],
    "/design-files/plain/thumbnail.svg",
  );
  assert.equal(
    card(doc, "risky").querySelector(".name").textContent,
    '<img src=x onerror="boom()">',
  );
  assert.equal(card(doc, "risky").querySelectorAll("img").length, 1);
  /* A palette entry that is not a plain color is dropped, not written into a style attribute. */
  const swatches = [...card(doc, "risky").querySelectorAll(".ds-sw i")].map((i) =>
    i.getAttribute("style"),
  );
  assert.deepEqual(swatches, ["background:#000", "background:#0af"]);
  win.happyDOM.abort();
});

test("the section steps aside while searching, and with no projects and no systems", async () => {
  const { win, doc, store } = load();
  await settle();
  const section = doc.getElementById("designs");
  assert.equal(section.hidden, false);
  win.OVDesign.sync({ hidden: true, bare: false });
  assert.equal(section.hidden, true);
  win.OVDesign.sync({ hidden: false, bare: true });
  assert.equal(section.hidden, false, "systems still show on a page with no projects");
  store.systems = [];
  win.happyDOM.abort();
  const bare = load({ systems: [] });
  await settle();
  bare.win.OVDesign.sync({ hidden: false, bare: true });
  assert.equal(bare.doc.getElementById("designs").hidden, true);
  bare.win.OVDesign.sync({ hidden: false, bare: false });
  assert.equal(bare.doc.getElementById("designs").hidden, false);
  assert.match(
    bare.doc.querySelector("#designs .empty").textContent,
    /A design system is a saved look/,
  );
  bare.win.happyDOM.abort();
});

test("a library that cannot be read shows the reason and a Retry that reloads", async () => {
  const { win, doc, requests, store } = load({ listFails: true });
  await settle();
  assert.match(doc.querySelector("#designs .empty").textContent, /permission denied/);
  store.listFails = false;
  doc.querySelector("[data-ds-retry]").click();
  await settle();
  assert.equal(doc.querySelectorAll("[data-ds]").length, 3);
  assert.equal(requests.filter((r) => r.path === "/api/design-systems").length, 2);
  win.happyDOM.abort();
});

test("F2 renames inline (PATCH the name); Escape keeps the old one", async () => {
  const { win, doc, requests } = load();
  await settle();
  key(win, card(doc, "plain"), "F2");
  let input = doc.querySelector("[data-ds-rename]");
  assert.equal(input.value, "Plain");
  assert.equal(doc.activeElement, input);
  input.value = "Renamed";
  key(win, input, "Escape");
  assert.equal(doc.querySelector("[data-ds-rename]"), null);
  assert.equal(card(doc, "plain").querySelector(".name").textContent, "Plain");
  key(win, card(doc, "plain"), "F2");
  input = doc.querySelector("[data-ds-rename]");
  input.value = "  Renamed  ";
  key(win, input, "Enter");
  await settle();
  const patch = requests.find((r) => r.method === "PATCH");
  assert.deepEqual([patch.path, patch.body], ["/api/design-systems/plain", { name: "Renamed" }]);
  assert.equal(card(doc, "plain").querySelector(".name").textContent, "Renamed");
  assert.equal(doc.activeElement, card(doc, "plain"), "focus stays on the card");
  win.happyDOM.abort();
});

test("Delete asks first, says projects keep their copy, and only then deletes", async () => {
  const { win, doc, requests } = load();
  await settle();
  key(win, card(doc, "third"), "Delete");
  const dialog = doc.querySelector('.sheet[role="alertdialog"]');
  assert.match(dialog.textContent, /Delete “Third”\?/);
  assert.match(dialog.textContent, /keep their own copy/);
  assert.equal(doc.activeElement.textContent, "Cancel");
  dialog.querySelector("[data-cancel]").click();
  assert.equal(doc.querySelector(".sheet"), null);
  assert.equal(
    requests.some((r) => r.method === "DELETE"),
    false,
  );
  key(win, card(doc, "third"), "Delete");
  doc.getElementById("dsDelOk").click();
  await settle();
  assert.equal(requests.filter((r) => r.method === "DELETE").length, 1);
  assert.equal(card(doc, "third"), null);
  assert.equal(doc.activeElement, card(doc, "risky"), "focus lands on the neighbouring card");
  win.happyDOM.abort();
});

test("View frames the showcase in a script-less sandbox and lists the fonts with their caveats", async () => {
  const { win, doc } = load();
  await settle();
  card(doc, "risky").click();
  await settle();
  const frame = doc.querySelector(".ds-sheet iframe");
  assert.equal(frame.getAttribute("sandbox"), "", "no allow-* token at all");
  assert.equal(frame.getAttribute("src"), "/design-files/risky/system.html");
  const text = doc.querySelector(".ds-details").textContent;
  assert.match(text, /Playfair Display/);
  assert.match(text, /Not portable/);
  assert.match(text, /Similar/);
  assert.match(text, /License unknown/);
  assert.match(text, /Transitions2/);
  assert.match(text, /Versions1/);
  assert.equal(doc.activeElement.textContent, "Close");
  win.happyDOM.abort();
});

test("Create opens the chosen project in Studio with the chosen source", async () => {
  const { win, doc, opened } = load();
  await settle();
  doc.getElementById("dsCreate").click();
  const radios = [...doc.querySelectorAll('[role="radio"]')];
  assert.deepEqual(
    radios.map((r) => r.dataset.kind),
    ["scratch", "project", "video", "website"],
  );
  key(win, radios[0], "ArrowDown");
  key(win, doc.activeElement, "ArrowDown");
  assert.equal(doc.querySelector('[role="radio"][aria-checked="true"]').dataset.kind, "video");
  const options = [...doc.querySelectorAll("#dsProject option")].map((o) => o.value);
  assert.deepEqual(
    options,
    ["b", "a"],
    "recent first; a project whose folder is gone is not offered",
  );
  doc.getElementById("dsProject").value = "a";
  doc.getElementById("dsGo").click();
  assert.equal(
    JSON.stringify(opened),
    JSON.stringify([{ id: "a", extra: { design: "create", designSource: "video" } }]),
  );
  assert.equal(doc.querySelector(".sheet"), null);
  win.happyDOM.abort();
});

test("Create with no projects explains why and cannot open anything", async () => {
  const { win, doc, opened } = load({ projects: [] });
  await settle();
  doc.getElementById("dsCreate").click();
  assert.equal(doc.getElementById("dsGo").disabled, true);
  assert.match(doc.querySelector(".sheet").textContent, /You have no projects yet/);
  assert.deepEqual(opened, []);
  win.happyDOM.abort();
});

test("the New Project picker defaults to None, offers the systems, and reports the choice", async () => {
  const { win, doc } = load();
  await settle();
  const host = doc.createElement("div");
  host.innerHTML = win.OVDesign.pickerHtml();
  doc.body.append(host);
  const picker = win.OVDesign.bindPicker(host);
  assert.equal(picker.id(), null);
  assert.equal(host.querySelector("#npDs").textContent.trim(), "None");
  host.querySelector("#npDs").click();
  const items = [...doc.querySelectorAll(".menu-item")];
  assert.equal(items.length, 4);
  items[2].click();
  assert.equal(picker.id(), "risky");
  assert.equal(host.querySelector("#npDs").textContent.trim(), '<img src=x onerror="boom()">');
  win.happyDOM.abort();
  const empty = load({ systems: [] });
  await settle();
  assert.equal(empty.win.OVDesign.pickerHtml(), "", "no row while the library is empty");
  empty.win.happyDOM.abort();
});

test("designWarning becomes one line, whether the server sent text or an object", () => {
  const { win } = load();
  assert.equal(win.OVDesign.warning({ opening: true }), "");
  assert.equal(
    win.OVDesign.warning({ designWarning: "font could not be copied" }),
    "The design system wasn’t applied: font could not be copied",
  );
  assert.equal(
    win.OVDesign.warning({ designWarning: { message: "gone" } }),
    "The design system wasn’t applied: gone",
  );
  win.happyDOM.abort();
});
