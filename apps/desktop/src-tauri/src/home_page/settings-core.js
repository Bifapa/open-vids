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

  const SECTIONS = [
    { group: "App", id: "general", label: "General", icon: "settings" },
    { group: "App", id: "appearance", label: "Appearance", icon: "contrast" },
    { group: "AI", id: "agents", label: "Agents", icon: "agents" },
    { group: "AI", id: "providers", label: "Models & Providers", icon: "plug" },
    { group: "AI", id: "jev", label: "Jev", icon: "bolt" },
    { group: "Workflow", id: "assets", label: "Asset Search", icon: "image" },
    { group: "Workflow", id: "execution", label: "Execution", icon: "gauge" },
  ];
  /* Agent ids are the runtime's (packages/agent-protocol SpecialistId); the Director is configured apart. */
  const AGENTS = [
    { id: "director", name: "Director", mono: "D", role: "Plans the edit and delegates" },
    { id: "editor", name: "Editor", mono: "E", role: "Cuts clips & handles timing" },
    { id: "vision", name: "Vision", mono: "V", role: "Reviews pacing & framing" },
    { id: "motion", name: "Motion Designer", mono: "MD", role: "Builds titles & transitions" },
    { id: "research", name: "Research", mono: "R", role: "Finds relevant B-roll" },
    { id: "audio", name: "Audio", mono: "A", role: "Balances dialogue & music" },
  ];

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

  /* Server data. A note is "" or a message; a leading "!" marks an error. */
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
    return `<div class="seg st-step" role="group" aria-label="${esc(label)}"><button type="button" aria-label="Fewer" data-act="${act}" data-d="-1" data-fk="${act}:-"${
      value <= min ? " disabled" : ""
    }>${ic("minus")}</button><output aria-live="polite">${value}</output><button type="button" aria-label="More" data-act="${act}" data-d="1" data-fk="${act}:+"${
      value >= max ? " disabled" : ""
    }>${ic("plus")}</button></div>`;
  }
  const head = (title, right) => `<div class="st-head"><h1>${esc(title)}</h1>${right || ""}</div>`;
  const lede = (text) => `<p class="st-lede">${text}</p>`;
  const loading = (what) => `<div class="st-loading"><i class="spinner"></i>Loading ${what}…</div>`;
  /* A data source that failed: what failed, the reason, and a way to try again. */
  const failure = (what, reason, act) =>
    `<p class="st-status is-error" role="alert">${esc(what)}${reason ? ": " + esc(reason) : ""}</p><p><button type="button" class="btn" data-act="${act}" data-fk="${act}">Try Again</button></p>`;
  const noteHtml = (note) =>
    note
      ? `<p class="st-status${note.startsWith("!") ? " is-error" : ""}" role="${
          note.startsWith("!") ? "alert" : "status"
        }">${esc(note.replace(/^!/, ""))}</p>`
      : "";
  const sameModel = (a, b) => !!a && !!b && a.provider === b.provider && a.modelId === b.modelId;
  const modelKey = (m) => (m ? m.provider + "/" + m.modelId : "");

  /* ---------- providers: shared by Agents, Models & Providers and Jev ---------- */
  const providerById = (id) => (S.providers || []).find((p) => p.id === id) || null;
  const providerName = (id) => (providerById(id) ? providerById(id).name : id);
  /* Not usable as it is: sign-in expired, no credential, or the live check failed. */
  const providerBad = (p) => !!p && p.status !== "connected";
  function issueText(p) {
    return p.status === "signin_required"
      ? `${p.name} needs sign-in`
      : p.status === "error"
        ? `${p.name} has an error`
        : `${p.name} isn’t set up`;
  }
  const issueCount = () =>
    (S.providers || []).filter((p) => p.status === "error" || p.status === "signin_required")
      .length;
  /* Warning with a link that jumps to the provider (prototype "Fix"). */
  const fixLink = (id) =>
    `<button type="button" class="link" data-act="goto-provider" data-v="${esc(id)}" data-fk="fix:${esc(
      id,
    )}">Fix</button>`;
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
        html += `<div class="nav-label">${s.group}</div>`;
        last = s.group;
      }
      const badge =
        s.id === "providers" && issues
          ? `<span class="pill warn" aria-label="${issues} need attention">${issues}</span>`
          : "";
      html += `<button type="button" class="nav-item" data-section="${s.id}"${
        s.id === section ? ' aria-current="page"' : ""
      }>${ic(s.icon)}<span class="grow">${esc(s.label)}</span>${badge}</button>`;
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
    if (title && known) title.textContent = known.label;
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
        head(known ? known.label : "Settings") +
        noteHtml("!This page failed to draw: " + err.message);
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
        S.agentsError = err.message;
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
          S.agentsNote = "!Couldn’t save: " + err.message;
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
