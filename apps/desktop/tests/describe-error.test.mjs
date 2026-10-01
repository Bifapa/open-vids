/* OV.describeError (src-tauri/src/home_page/shared.js): the local server answers a failure as
   { error: "<English sentence>", code, params }; the page shows the translation of `home.error.<code>` and falls
   back to the sentence. shared.js and i18n.js are browser globals; they run here in a node:vm context. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const root = new URL("../../../", import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, root), "utf8"));
const page = (name) =>
  readFileSync(new URL(`../src-tauri/src/home_page/${name}`, import.meta.url), "utf8");

const index = readJson("locales/index.json");
const catalog = Object.fromEntries(index.map((l) => [l.code, readJson(`locales/${l.code}.json`)]));

/* A page in `language` whose fetch answers `reply` ({ status, body }). */
function load(language, reply) {
  const sandbox = {
    console,
    Intl,
    Date,
    Math,
    document: {
      readyState: "complete",
      documentElement: { dataset: {}, lang: "" },
      addEventListener() {},
      querySelectorAll: () => [],
    },
    navigator: { language, languages: [language] },
    CustomEvent: class {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: async () => ({
      ok: reply.status < 400,
      status: reply.status,
      json: async () => reply.body,
    }),
    OV_TOKEN: "t",
  };
  sandbox.window = sandbox;
  sandbox.dispatchEvent = () => {};
  vm.runInNewContext(page("i18n.js"), sandbox);
  vm.runInNewContext(page("shared.js"), sandbox);
  sandbox.OVI18N.init(language, { index, messages: catalog });
  return sandbox.OV;
}

/* The error api() throws for an answer. */
async function failure(OV) {
  try {
    await OV.api("/api/x", {});
  } catch (err) {
    return err;
  }
  throw new Error("api() did not throw");
}

test("a known code is translated into the page language, params filled in", async () => {
  const body = {
    error: "/Users/a/Talk no longer exists — remove it from recents",
    code: "folder_missing_remove",
    params: { path: "/Users/a/Talk" },
  };
  const en = load("en", { status: 410, body });
  const ru = load("ru", { status: 410, body });
  assert.equal(en.describeError(await failure(en)), body.error);
  assert.equal(
    ru.describeError(await failure(ru)),
    "/Users/a/Talk больше не существует — уберите его из недавних",
  );
});

test("api() keeps the server's code and params on the error it throws", async () => {
  const OV = load("en", {
    status: 400,
    body: { error: "give the project a name", code: "create_no_name", params: {} },
  });
  const err = await failure(OV);
  assert.equal(err.message, "give the project a name");
  assert.equal(err.code, "create_no_name");
  assert.equal(err.status, 400);
});

test("an unknown code, no code, or a structured error falls back to the English sentence", async () => {
  const unknown = load("ru", {
    status: 400,
    body: { error: "something new", code: "no_such_failure", params: {} },
  });
  assert.equal(unknown.describeError(await failure(unknown)), "something new");
  const plain = load("ru", { status: 500, body: { error: "boom" } });
  assert.equal(plain.describeError(await failure(plain)), "boom");
  const nested = load("ru", {
    status: 400,
    body: { error: { code: "folder_missing", message: "policy says no" } },
  });
  const err = await failure(nested);
  assert.equal(err.code, undefined);
  assert.equal(nested.describeError(err), "policy says no");
  assert.equal(nested.describeError(null), "");
});

test("a state object (open-state, install job) is described the same way", () => {
  const OV = load("ru", { status: 200, body: {} });
  assert.equal(
    OV.describeError({
      phase: "failed",
      error: "the Studio runtime exited during startup: boom",
      code: "studio_exited",
      params: { detail: "boom" },
    }),
    "Среда выполнения Studio завершилась при запуске: boom",
  );
  /* Brew's own line carries no code: it is shown as it is. */
  assert.equal(
    OV.describeError({ phase: "failed", error: "Error: ffmpeg: no bottle available!" }),
    "Error: ffmpeg: no bottle available!",
  );
});

test("a count in params follows the plural rules of the language", () => {
  const params = { minutes: 30 };
  const message = "the install took longer than 30 minutes and was stopped";
  const en = load("en", { status: 200, body: {} });
  const ru = load("ru", { status: 200, body: {} });
  const err = { message, code: "install_timeout", params };
  assert.equal(en.describeError(err), message);
  assert.equal(ru.describeError(err), "Установка шла дольше 30 минут и была остановлена");
  assert.equal(
    ru.describeError({ ...err, params: { minutes: 1 } }),
    "Установка шла дольше 1 минуты и была остановлена",
  );
});
