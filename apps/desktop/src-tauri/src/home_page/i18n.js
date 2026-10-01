/* OpenVids home: i18n for the Projects page and the Settings window. The catalog is the repo's locales/ folder
   (GET /locales/index.json, GET /locales/<code>.json): flat dot keys, ICU MessageFormat. Studio reads the same files
   through i18next-icu, and both must pass locales/cases.json verbatim (tests/i18n.test.mjs runs this file on them).
   Supported ICU subset: {name}, {name, plural, =N {…} zero|one|two|few|many|other {…}} with nested braces, `#`
   inside a plural branch, and ' quoting of { } # (a lone ' is literal, '' is one '). Anything else is malformed and
   the raw message is shown. Global: window.OVI18N. */
(function () {
  "use strict";

  /* ---- ICU subset: parse to a small tree (cached per message), then evaluate ---- */
  const MAX_DEPTH = 8;

  function parseNodes(s, start, depth, inPlural) {
    if (depth > MAX_DEPTH) throw new Error("nested too deep");
    const nodes = [];
    let text = "",
      i = start;
    const flush = function () {
      if (text) nodes.push({ text: text });
      text = "";
    };
    while (i < s.length) {
      const ch = s[i];
      if (ch === "'") {
        const nx = s[i + 1];
        if (nx === "'") {
          text += "'";
          i += 2;
        } else if (nx === "{" || nx === "}" || (inPlural && nx === "#")) {
          /* Quoted run: literal up to the next lone ' ('' inside it is one '). */
          i++;
          while (i < s.length) {
            if (s[i] === "'") {
              if (s[i + 1] === "'") {
                text += "'";
                i += 2;
                continue;
              }
              i++;
              break;
            }
            text += s[i++];
          }
        } else {
          text += "'";
          i++;
        }
      } else if (ch === "{") {
        flush();
        const arg = parseArgument(s, i + 1, depth);
        nodes.push(arg.node);
        i = arg.end;
      } else if (ch === "}") {
        if (depth === 0) throw new Error("unbalanced }");
        flush();
        return { nodes: nodes, end: i };
      } else if (ch === "#" && inPlural) {
        flush();
        nodes.push({ pound: true });
        i++;
      } else {
        text += ch;
        i++;
      }
    }
    if (depth > 0) throw new Error("unterminated {");
    flush();
    return { nodes: nodes, end: i };
  }

  function skipSpace(s, i) {
    while (i < s.length && /\s/.test(s[i])) i++;
    return i;
  }

  /* `i` is just after the opening {; returns the node and the index just after the matching }. */
  function parseArgument(s, i, depth) {
    const nameEnd = s.slice(i).search(/[,}]/);
    if (nameEnd < 0) throw new Error("unterminated {");
    const name = s.slice(i, i + nameEnd).trim();
    if (!name) throw new Error("empty argument name");
    i += nameEnd;
    if (s[i] === "}") return { node: { arg: name }, end: i + 1 };
    const typeEnd = s.indexOf(",", i + 1);
    if (typeEnd < 0 || s.slice(i + 1, typeEnd).trim() !== "plural")
      throw new Error("unsupported type");
    i = skipSpace(s, typeEnd + 1);
    const branches = {};
    while (s[i] !== "}") {
      if (i >= s.length) throw new Error("unterminated plural");
      const sel = s.slice(i).match(/^(=\d+|[a-z]+)/);
      if (!sel) throw new Error("bad selector");
      i = skipSpace(s, i + sel[0].length);
      if (s[i] !== "{") throw new Error("expected {");
      const body = parseNodes(s, i + 1, depth + 1, true);
      branches[sel[0]] = body.nodes;
      i = skipSpace(s, body.end + 1);
    }
    if (!branches.other) throw new Error("plural without other");
    return { node: { plural: name, branches: branches }, end: i + 1 };
  }

  const trees = new Map();
  const numberFormats = new Map();
  const pluralRules = new Map();
  function numberFormat(locale) {
    let f = numberFormats.get(locale);
    if (!f) numberFormats.set(locale, (f = new Intl.NumberFormat(locale)));
    return f;
  }
  function pluralRule(locale) {
    let r = pluralRules.get(locale);
    if (!r) pluralRules.set(locale, (r = new Intl.PluralRules(locale)));
    return r;
  }

  function evaluate(nodes, params, locale, count) {
    let out = "";
    for (const n of nodes) {
      if (n.text !== undefined) out += n.text;
      else if (n.pound) out += numberFormat(locale).format(count);
      else if (n.arg !== undefined) {
        out += params && params[n.arg] != null ? String(params[n.arg]) : "{" + n.arg + "}";
      } else {
        const raw = params ? params[n.plural] : undefined;
        if (raw == null) {
          out += "{" + n.plural + "}";
          continue;
        }
        const num = Number(raw);
        const form =
          n.branches["=" + num] !== undefined
            ? "=" + num
            : Number.isFinite(num) && n.branches[pluralRule(locale).select(num)] !== undefined
              ? pluralRule(locale).select(num)
              : "other";
        out += evaluate(n.branches[form], params, locale, num);
      }
    }
    return out;
  }

  /* An unparseable message (or an unusable locale) is returned as written. */
  function format(message, params, locale) {
    try {
      let tree = trees.get(message);
      if (!tree) {
        tree = parseNodes(message, 0, 0, false).nodes;
        trees.set(message, tree);
      }
      return evaluate(tree, params, locale, 0);
    } catch {
      return message;
    }
  }

  /* ---- Language choice: the preference ("system" or a code), navigator.languages, the supported codes ---- */
  function resolveLanguage(preference, navigatorLanguages, codes) {
    const find = function (wanted) {
      const w = String(wanted).toLowerCase();
      return codes.find(function (c) {
        return c.toLowerCase() === w;
      });
    };
    const direct = typeof preference === "string" ? find(preference) : undefined;
    if (direct) return direct;
    const langs = navigatorLanguages || [];
    for (const lang of langs) {
      const exact = find(lang);
      if (exact) return exact;
      const base = find(String(lang).split("-")[0]);
      if (base) return base;
    }
    return "en";
  }

  /* ---- State: the catalog index, loaded messages, the active language. Pure of the DOM (fetchJson is injected). ---- */
  function isCatalogEntry(e) {
    return !!e && typeof e.code === "string" && typeof e.name === "string";
  }
  function isMessages(m) {
    return !!m && typeof m === "object" && !Array.isArray(m);
  }

  function createI18n(env) {
    let index = [],
      preference = "system",
      active = "en",
      ready = false,
      settled = -1,
      seq = 0;
    const messages = {},
      pending = new Map();

    function load(code) {
      if (messages[code]) return Promise.resolve();
      let p = pending.get(code);
      if (!p) {
        p = env
          .fetchJson("/locales/" + encodeURIComponent(code) + ".json")
          .then(function (m) {
            if (isMessages(m)) messages[code] = m;
          })
          .catch(function () {})
          .finally(function () {
            pending.delete(code);
          });
        pending.set(code, p);
      }
      return p;
    }
    function lookup(code, key) {
      const m = messages[code];
      return m && Object.hasOwn(m, key) && typeof m[key] === "string" ? m[key] : undefined;
    }

    /* Resolve `pref`, load en and that locale, make it active; resolves false when a newer call superseded this
       one. When both locales are already in memory it takes effect before returning (isSettled()). */
    function select(pref) {
      const mine = ++seq;
      preference = typeof pref === "string" && pref ? pref : "system";
      const codes = index.map(function (e) {
        return e.code;
      });
      const next = resolveLanguage(preference, env.navigatorLanguages(), codes);
      const missing = ["en", next].filter(function (c) {
        return !messages[c];
      });
      if (!missing.length) {
        active = next;
        settled = mine;
        return Promise.resolve(true);
      }
      return Promise.all(missing.map(load)).then(function () {
        if (mine !== seq) return false;
        active = next;
        settled = mine;
        return true;
      });
    }

    /* Locale data the server injected into the page: { index: [{code,name}], messages: { en, <code>… } }. */
    function seed(boot) {
      if (!boot || !Array.isArray(boot.index) || !isMessages(boot.messages)) return false;
      if (!isMessages(boot.messages.en)) return false;
      index = boot.index.filter(isCatalogEntry);
      for (const code of Object.keys(boot.messages)) {
        if (isMessages(boot.messages[code])) messages[code] = boot.messages[code];
      }
      return true;
    }
    return {
      /* With the injected `boot` data it needs no fetch for the index, en or a preloaded locale, and takes effect
         before returning (isSettled()). Without it, or for a locale the data lacks, it fetches. The promise
         resolves to the active code and never rejects. */
      init: function (pref, boot) {
        const done = function () {
          ready = true;
          return active;
        };
        if (seed(boot)) {
          const p = select(pref).then(done);
          if (settled === seq) ready = true;
          return p;
        }
        return env
          .fetchJson("/locales/index.json")
          .then(function (list) {
            index = Array.isArray(list) ? list.filter(isCatalogEntry) : [];
          })
          .catch(function () {
            index = [];
          })
          .then(function () {
            return select(pref);
          })
          .then(done);
      },
      isSettled: function () {
        return settled === seq;
      },
      setLanguage: select,
      t: function (key, params) {
        const own = lookup(active, key);
        if (own !== undefined) return format(own, params, active);
        const en = lookup("en", key);
        return en !== undefined ? format(en, params, "en") : key;
      },
      languages: function () {
        return index.slice();
      },
      language: function () {
        return active;
      },
      preference: function () {
        return preference;
      },
      isReady: function () {
        return ready;
      },
    };
  }

  /* ---- Page wiring: fetch, <html lang>, static markup, the ov-language event ---- */
  function defaultFetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  const core = createI18n({
    fetchJson: defaultFetchJson,
    navigatorLanguages: function () {
      return typeof navigator !== "undefined" && navigator.languages ? navigator.languages : [];
    },
  });

  function paramsOf(el) {
    const raw = el.getAttribute("data-i18n-params");
    if (!raw) return undefined;
    try {
      const p = JSON.parse(raw);
      return p && typeof p === "object" ? p : undefined;
    } catch {
      return undefined;
    }
  }

  /* Static markup: data-i18n sets textContent; data-i18n-title / -placeholder / -aria-label set that attribute. */
  const ATTRS = [
    ["data-i18n-title", "title"],
    ["data-i18n-placeholder", "placeholder"],
    ["data-i18n-aria-label", "aria-label"],
  ];
  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = core.t(el.getAttribute("data-i18n"), paramsOf(el));
    });
    for (const pair of ATTRS) {
      scope.querySelectorAll("[" + pair[0] + "]").forEach(function (el) {
        el.setAttribute(pair[1], core.t(el.getAttribute(pair[0]), paramsOf(el)));
      });
    }
  }

  function announce() {
    document.documentElement.lang = core.language();
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", () => apply(), { once: true });
    else apply();
    window.dispatchEvent(new CustomEvent("ov-language", { detail: { language: core.language() } }));
  }

  /* `ready` resolves when the first init has finished (also when the catalog could not be loaded). */
  let readyPromise = null;
  window.OVI18N = {
    format: format,
    resolveLanguage: resolveLanguage,
    createI18n: createI18n,
    init: function (pref, boot) {
      const p = core.init(pref, boot);
      if (core.isSettled()) {
        announce();
        readyPromise = p;
      } else
        readyPromise = p.then(function (code) {
          announce();
          return code;
        });
      return readyPromise;
    },
    ready: function () {
      return readyPromise || Promise.resolve(core.language());
    },
    setLanguage: function (pref) {
      const p = core.setLanguage(pref);
      if (core.isSettled()) {
        announce();
        return Promise.resolve(core.language());
      }
      return p.then(function (took) {
        if (took) announce();
        return core.language();
      });
    },
    t: core.t,
    languages: core.languages,
    language: core.language,
    preference: core.preference,
    apply: apply,
  };
})();
