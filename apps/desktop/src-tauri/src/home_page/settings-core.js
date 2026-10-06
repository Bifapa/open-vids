/* Settings window core — the prototype's openvids-settings.js shell: section list, markup helpers (rows, groups,
   switches, segmented controls), the render loop with focus restoration, and the data the sections share
   (agent settings + model catalog, provider list). Each section file registers its page and handlers on
   window.OVS; settings.js wires the events and boots. Everything that comes from the server or the user is
   untrusted and goes through esc() before it reaches a template. */
(function () {
  "use strict";
  const { ic, esc, api } = OV;
  const params = new URLSearchParams(location.search);
  const SECTION_KEY = "ov-settings-section";

  /* Labels are catalog keys, read when drawn (a language switch redraws the window). */
  /* A section marked `beta` exists only while OV.betaFeatures() (the shell's beta channel / debug builds). */
  const SECTIONS = [
    {
      group: "settings.nav.group.app",
      id: "general",
      label: "settings.section.general",
      icon: "settings",
    },
    {
      group: "settings.nav.group.app",
      id: "appearance",
      label: "settings.section.appearance",
      icon: "contrast",
    },
    {
      group: "settings.nav.group.ai",
      id: "agents",
      label: "settings.section.agents",
      icon: "agents",
    },
    {
      group: "settings.nav.group.ai",
      id: "providers",
      label: "settings.section.providers",
      icon: "plug",
    },
    { group: "settings.nav.group.ai", id: "jev", label: "settings.section.jev", icon: "bolt" },
    {
      group: "settings.nav.group.workflow",
      id: "assets",
      label: "settings.section.assets",
      icon: "image",
    },
    {
      group: "settings.nav.group.workflow",
      id: "voice",
      label: "settings.section.voice",
      icon: "audio",
      beta: true,
    },
    {
      group: "settings.nav.group.workflow",
      id: "execution",
      label: "settings.section.execution",
      icon: "gauge",
    },
  ].filter((s) => !s.beta || OV.betaFeatures());
  const tr = (key, params) => OVI18N.t(key, params);
  /* State keeps a message it will show as { key, params } until it is drawn, so a language switch re-words it
     (failMsg marks an error note). A plain string is text as it came from the server or the user. */
  const msg = (key, params) => ({ key, params });
  const failMsg = (key, params) => ({ key, params, error: true });
  const text = (m) =>
    m && typeof m === "object" ? tr(m.key, m.params) : m == null ? "" : String(m);
  /* Names in a row ("A, B, C"), joined the way the active language does. */
  const list = (items) =>
    new Intl.ListFormat(OVI18N.language(), { type: "unit", style: "short" }).format(items);
  /* Agent ids are the runtime's (packages/agent-protocol SpecialistId); the Director is configured apart.
     name, mono and role are read when drawn. */
  const agent = (id) => ({
    id,
    get name() {
      return tr(`settings.agent.${id}.name`);
    },
    get mono() {
      return tr(`settings.agent.${id}.mono`);
    },
    get role() {
      return tr(`settings.agent.${id}.role`);
    },
  });
  const AGENTS = ["director", "editor", "vision", "motion", "research", "audio"].map(agent);

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* unavailable */
      }
    },
  };

  let section = SECTIONS.some((s) => s.id === params.get("section"))
    ? params.get("section")
    : store.get(SECTION_KEY) || "general";
  if (!SECTIONS.some((s) => s.id === section)) section = "general";

  /* Server data. A note is "" or a message ({ key, params, error? } or text; text with a leading "!" is an error). */
  const S = {
    prefs: null,
    prefsError: null,
    prefsNote: "",
    agents: null,
    catalog: null,
    agentsError: null,
    agentsNote: "",
    providers: null,
    syncedAt: null,
    providersError: null,
    provModels: {},
    policy: null,
    policyError: null,
    policyNote: "",
  };
  /* Interface state: open provider rows, busy labels, field errors, unsaved drafts (keys never leave memory),
     and a focus key to return to once a re-render replaced the element that had it. */
  const ui = { open: {}, busy: {}, err: {}, draft: {}, flags: {}, pendingFk: null };

  const PAGES = {};
  const CLICK = {};
  const CHANGE = {};
  const INPUT = {};
  const ENTER = {};
  const ON_ENTER = {};
  const ON_LEAVE = {};

  /* Messages to the page that frames this one (Settings window) — or, where another host mounts the sections
     (the first-run onboarding in the Projects page), whatever that host sets OVS.post to. */
  const defaultPost = (msg) => {
    try {
      window.parent.postMessage(msg, location.origin);
    } catch {
      /* not framed */
    }
  };
  const post = (msg) => window.OVS.post(msg);

  /* ---------- markup helpers (prototype openvids-settings.js). label/sub/ctl/inner are HTML: callers
     escape every dynamic value they put in. ---------- */
  function row(label, sub, ctl, cls) {
    return `<div class="st-row${cls ? " " + cls : ""}"><div class="st-label"><b>${label}</b>${
      sub ? `<span>${sub}</span>` : ""
    }</div><div class="st-ctl">${ctl}</div></div>`;
  }
  function group(title, inner, meta) {
    return `<section class="st-group"><div class="sect-label"><span>${title}</span>${
      meta || ""
    }</div><div class="st-box">${inner}</div></section>`;
  }
  function sw(on, act, label, key, disabled) {
    return `<button type="button" class="sw" role="switch" aria-checked="${!!on}" aria-label="${esc(
      label,
    )}" data-act="${act}"${key ? ` data-key="${esc(key)}"` : ""} data-fk="${act}:${esc(key || "")}"${
      disabled ? " disabled" : ""
    }></button>`;
  }
  function seg(options, value, act, label, key, disabled) {
    return `<div class="seg text" role="group" aria-label="${esc(label)}">${options
      .map(
        (o) =>
          `<button type="button" aria-pressed="${String(o[0]) === String(value)}" data-act="${act}" data-v="${esc(
            o[0],
          )}"${key ? ` data-key="${esc(key)}"` : ""} data-fk="${act}:${esc(key || "")}:${esc(o[0])}"${
            disabled ? " disabled" : ""
          }>${esc(o[1])}</button>`,
      )
      .join("")}</div>`;
  }
  function select(optionsHtml, act, label, key, cls, disabled) {
    return `<select class="sel${cls ? " " + cls : ""}" aria-label="${esc(label)}" data-act="${act}"${
      key ? ` data-key="${esc(key)}"` : ""
    } data-fk="${act}:${esc(key || "")}"${disabled ? " disabled" : ""}>${optionsHtml}</select>`;
  }
  /* list: [value, label, disabled?] */
  const opts = (list, value) =>
    list
      .map(
        (o) =>
          `<option value="${esc(o[0])}"${String(o[0]) === String(value) ? " selected" : ""}${
            o[2] ? " disabled" : ""
          }>${esc(o[1])}</option>`,
      )
      .join("");
  function stepper(value, min, max, act, label) {
    return `<div class="seg st-step" role="group" aria-label="${esc(label)}"><button type="button" aria-label="${esc(
      tr("settings.stepper.fewer"),
    )}" data-act="${act}" data-d="-1" data-fk="${act}:-"${
      value <= min ? " disabled" : ""
    }>${ic("minus")}</button><output aria-live="polite">${value}</output><button type="button" aria-label="${esc(
      tr("settings.stepper.more"),
    )}" data-act="${act}" data-d="1" data-fk="${act}:+"${
      value >= max ? " disabled" : ""
    }>${ic("plus")}</button></div>`;
  }
  const head = (title, right) => `<div class="st-head"><h1>${esc(title)}</h1>${right || ""}</div>`;
  /* key: the catalog key of the intro paragraph. */
  const lede = (key) => `<p class="st-lede">${esc(tr(key))}</p>`;
  /* what: the catalog key of the whole "Loading …" line. */
  const loading = (what) => `<div class="st-loading"><i class="spinner"></i>${esc(tr(what))}</div>`;
  /* A data source that failed: what failed (a catalog key), the reason, and a way to try again. */
  const failure = (what, reason, act) =>
    `<p class="st-status is-error" role="alert">${esc(
      reason ? tr("settings.failure.withReason", { what: tr(what), reason }) : tr(what),
    )}</p><p><button type="button" class="btn" data-act="${act}" data-fk="${act}">${esc(
      tr("settings.failure.tryAgain"),
    )}</button></p>`;
  const noteHtml = (note) => {
    if (!note) return "";
    const bad = typeof note === "object" ? !!note.error : note.startsWith("!");
    const body = typeof note === "object" ? text(note) : note.replace(/^!/, "");
    return `<p class="st-status${bad ? " is-error" : ""}" role="${bad ? "alert" : "status"}">${esc(body)}</p>`;
  };
  const sameModel = (a, b) => !!a && !!b && a.provider === b.provider && a.modelId === b.modelId;
  const modelKey = (m) => (m ? m.provider + "/" + m.modelId : "");

  /* ---------- providers: shared by Agents, Models & Providers and Jev ---------- */
  const providerById = (id) => (S.providers || []).find((p) => p.id === id) || null;
  const providerName = (id) => (providerById(id) ? providerById(id).name : id);
  /* Not usable as it is: sign-in expired, no credential, or the live check failed. */
  const providerBad = (p) => !!p && p.status !== "connected";
  function issueText(p) {
    return p.status === "signin_required"
      ? tr("settings.provider.issue.signinRequired", { name: p.name })
      : p.status === "error"
        ? tr("settings.provider.issue.error", { name: p.name })
        : tr("settings.provider.issue.notSetUp", { name: p.name });
  }
  const issueCount = () =>
    (S.providers || []).filter((p) => p.status === "error" || p.status === "signin_required")
      .length;
  /* Warning with a link that jumps to the provider (prototype "Fix"). */
  const fixLink = (id) =>
    `<button type="button" class="link" data-act="goto-provider" data-v="${esc(id)}" data-fk="fix:${esc(
      id,
    )}">${esc(tr("settings.provider.fix"))}</button>`;
  const providerWarn = (p) =>
    `<span class="status warning">${ic("alert")}<span>${esc(issueText(p))} · ${fixLink(p.id)}</span></span>`;
  function setProviders(res) {
    S.providers = Array.isArray(res && res.providers) ? res.providers : [];
    S.syncedAt = res && typeof res.syncedAt === "number" ? res.syncedAt : null;
    S.providersError = null;
  }

  /* ---------- render ---------- */
  /* The elements the sections draw into: the Settings window's by default; useHost() points them at another
     page's container (nav and title are optional there). */
  let win = document.getElementById("win"),
    nav = document.getElementById("stNav"),
    main = document.getElementById("stMain"),
    title = document.getElementById("stTitle");
  let pageClass = "st-page";
  function useHost(host) {
    if ("pageClass" in host) pageClass = host.pageClass;
    if ("main" in host) main = host.main;
    if ("nav" in host) nav = host.nav;
    if ("title" in host) title = host.title;
    if (host.section) section = host.section;
  }

  function renderNav() {
    if (!nav) return;
    let html = "",
      last = "";
    const issues = issueCount();
    SECTIONS.forEach((s) => {
      if (s.group !== last) {
        html += `<div class="nav-label">${esc(tr(s.group))}</div>`;
        last = s.group;
      }
      const badge =
        s.id === "providers" && issues
          ? `<span class="pill warn" aria-label="${esc(
              tr("settings.nav.needAttention", { count: issues }),
            )}">${issues}</span>`
          : "";
      html += `<button type="button" class="nav-item" data-section="${s.id}"${
        s.id === section ? ' aria-current="page"' : ""
      }>${ic(s.icon)}<span class="grow">${esc(tr(s.label))}</span>${badge}</button>`;
    });
    nav.innerHTML = html;
  }
  function caretOf(el) {
    try {
      return el.selectionStart;
    } catch {
      return null;
    }
  }
  function render(keepScroll) {
    const a = document.activeElement;
    const inMain = !!a && main.contains(a);
    const fk = inMain && a.dataset && a.dataset.fk ? a.dataset.fk : null;
    const caret = inMain && a.tagName === "INPUT" ? caretOf(a) : null;
    const navKey = nav && a && nav.contains(a) && a.dataset ? a.dataset.section : null;
    const top = main.scrollTop;
    const known = SECTIONS.find((s) => s.id === section);
    if (title) title.textContent = known ? tr(known.label) : tr("settings.window.heading");
    renderNav();
    if (navKey) {
      const n = nav.querySelector(`[data-section="${navKey}"]`);
      if (n) n.focus({ preventScroll: true });
    }
    let html;
    try {
      html = PAGES[section]();
    } catch (err) {
      console.error(err);
      html =
        head(known ? tr(known.label) : tr("settings.window.heading")) +
        noteHtml(failMsg("settings.page.drawFailed", { message: err.message }));
    }
    main.innerHTML = `<div class="${pageClass}">${html}</div>`;
    /* Unsaved key drafts are put back as a property, never written into the markup. */
    main.querySelectorAll("[data-draft]").forEach((el) => {
      const v = ui.draft[el.dataset.draft];
      if (v) el.value = v;
    });
    if (keepScroll) main.scrollTop = top;
    /* Focus goes back to the element that had it; if a change removed it, to the key set aside for that. */
    const focusKey = (key) => {
      if (!key) return false;
      const el = main.querySelector(`[data-fk="${CSS.escape(key)}"]`);
      if (!el || el.disabled) return false;
      el.focus({ preventScroll: true });
      if (key === fk && caret != null && el.setSelectionRange) {
        try {
          el.setSelectionRange(caret, caret);
        } catch {
          /* input type without a selection */
        }
      }
      return true;
    };
    if (!focusKey(fk) && focusKey(ui.pendingFk)) ui.pendingFk = null;
  }
  function enter(id) {
    if (ON_ENTER[id]) ON_ENTER[id]();
  }
  function go(id) {
    const prev = section;
    if (prev !== id && ON_LEAVE[prev]) ON_LEAVE[prev]();
    section = id;
    if (SECTIONS.some((s) => s.id === id)) store.set(SECTION_KEY, id);
    ui.pendingFk = null;
    render(false);
    main.scrollTop = 0;
    enter(id);
  }

  /* ---------- agent runtime data: settings + model catalog (Agents, Jev, Execution) ---------- */
  function loadAgents() {
    S.agentsError = null;
    return Promise.all([api("/api/agent/settings"), api("/api/agent/models")])
      .then(([s, c]) => {
        S.agents = s;
        S.catalog = c;
      })
      .catch((err) => {
        S.agentsError = OV.describeError(err);
      })
      .finally(() => render(true));
  }
  /* The catalog lists only models of providers that are usable now: reload it whenever providers change. */
  function reloadCatalog() {
    return api("/api/agent/models")
      .then((c) => {
        S.catalog = c;
      })
      .catch(() => {
        /* keep the last catalog */
      })
      .finally(() => render(true));
  }
  /* Saves are queued: build(agents) runs against the settings as they are when its turn comes, so two quick
     clicks never overwrite one another with a stale copy. Resolves true when the runtime accepted it. */
  let agentsQueue = Promise.resolve(true);
  function saveAgents(build, note) {
    agentsQueue = agentsQueue.then(() => {
      const patch = typeof build === "function" ? build(S.agents) : build;
      if (!patch) return true;
      return api("/api/agent/settings", patch, "PUT")
        .then((next) => {
          S.agents = next;
          S.agentsNote = note || "";
          post({ type: "ov-agents" });
          return true;
        })
        .catch((err) => {
          S.agentsNote = failMsg("settings.note.saveFailed", { message: OV.describeError(err) });
          return false;
        })
        .finally(() => render(true));
    });
    return agentsQueue;
  }
  /* The model an agent really runs: its own, else the Director's, else the runtime default. */
  function effectiveModel(agentId) {
    const dir =
      (S.agents && S.agents.director.model) || (S.catalog && S.catalog.defaultModel) || null;
    if (agentId === "director" || !S.agents) return dir;
    return S.agents.specialists[agentId].model || dir;
  }

  /* ---------- events: handlers registered by the sections (CLICK / CHANGE / INPUT / ENTER by data-act) ---------- */
  function wire(el) {
    el.addEventListener("click", (e) => {
      const t = e.target.closest("[data-act]");
      if (!t || t.tagName === "SELECT" || t.tagName === "INPUT" || t.disabled) return;
      const fn = CLICK[t.dataset.act];
      if (!fn) return;
      /* A handler that navigates or draws by itself answers false. */
      if (fn(t, e) !== false) render(true);
    });
    /* Selects and number fields: the control already shows the new value; the save redraws when it answers. */
    el.addEventListener("change", (e) => {
      const t = e.target,
        fn = t.dataset && CHANGE[t.dataset.act];
      if (fn) fn(t, e);
    });
    el.addEventListener("input", (e) => {
      const t = e.target,
        fn = t.dataset && INPUT[t.dataset.act];
      if (fn) fn(t, e);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      const t = e.target,
        fn = t.tagName === "INPUT" && t.dataset && ENTER[t.dataset.act];
      if (!fn) return;
      e.preventDefault();
      /* The page's own Enter shortcuts (a primary button) must not also fire. */
      e.stopPropagation();
      fn(t, e);
    });
  }

  window.OVS = {
    ic,
    tr,
    msg,
    failMsg,
    text,
    list,
    esc,
    api,
    params,
    SECTIONS,
    AGENTS,
    S,
    ui,
    PAGES,
    CLICK,
    CHANGE,
    INPUT,
    ENTER,
    ON_ENTER,
    ON_LEAVE,
    get main() {
      return main;
    },
    get nav() {
      return nav;
    },
    get win() {
      return win;
    },
    post: defaultPost,
    useHost,
    wire,
    caretOf,
    row,
    group,
    sw,
    seg,
    select,
    opts,
    stepper,
    head,
    lede,
    loading,
    failure,
    noteHtml,
    sameModel,
    modelKey,
    providerById,
    providerName,
    providerBad,
    issueText,
    issueCount,
    fixLink,
    providerWarn,
    setProviders,
    render,
    go,
    enter,
    section: () => section,
    /* Whether the provider list is on screen (sign-in polling follows it); a host with its own screens overrides it. */
    providersVisible: () => section === "providers",
    loadAgents,
    reloadCatalog,
    saveAgents,
    effectiveModel,
  };
})();
