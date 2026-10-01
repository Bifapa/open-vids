/* Settings window — the prototype's openvids-settings.html, limited to what the desktop backs:
   General and Appearance (the shared app preferences file, /api/preferences) and Agents (the global
   agent defaults and default Execution Quality, through the agent runtime, /api/agent/*). Framed over
   the Projects page; posts ov-theme / ov-prefs / ov-agents / ov-settings-close to it. */
(function () {
  "use strict";
  const { ic, esc, api } = OV;
  const params = new URLSearchParams(location.search);
  const SECTION_KEY = "ov-settings-section";
  const SECTIONS = [
    { group: "App", id: "general", label: "General", icon: "settings" },
    { group: "App", id: "appearance", label: "Appearance", icon: "contrast" },
    { group: "AI", id: "agents", label: "Agents", icon: "agents" },
  ];
  const AGENTS = [
    { id: "director", name: "Director", mono: "D", role: "Plans the edit and delegates" },
    { id: "editor", name: "Editor", mono: "E", role: "Cuts clips & handles timing" },
    { id: "vision", name: "Vision", mono: "V", role: "Reviews pacing & framing" },
    { id: "motion", name: "Motion Designer", mono: "MD", role: "Builds titles & transitions" },
    { id: "research", name: "Research", mono: "R", role: "Finds relevant B-roll" },
    { id: "audio", name: "Audio", mono: "A", role: "Balances dialogue & music" },
  ];
  const EFFORTS = [
    ["", "Default"],
    ["low", "Low"],
    ["medium", "Med"],
    ["high", "High"],
  ];
  const QUALITY = [
    ["fast", "Fast"],
    ["balanced", "Balanced"],
    ["best", "Best"],
  ];
  const QUALITY_NOTE = {
    fast: "Quickest drafts. Agents skip the QA pass.",
    balanced: "The default for most edits.",
    best: "Slowest. Deep research and two QA passes.",
    custom: "A custom mix chosen in a chat. Pick a preset to replace it.",
  };
  const FORMATS = [
    ["1920x1080", "1920 × 1080 · 16:9"],
    ["3840x2160", "3840 × 2160 · 16:9"],
    ["1080x1920", "1080 × 1920 · 9:16"],
    ["1080x1080", "1080 × 1080 · 1:1"],
    ["1080x1350", "1080 × 1350 · 4:5"],
  ];
  const FPS = [
    [24, "24 fps"],
    [25, "25 fps"],
    [30, "30 fps"],
    [60, "60 fps"],
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
  let prefs = null,
    prefsError = null,
    agents = null,
    catalog = null,
    agentsError = null,
    agentsSaving = false,
    agentsNote = "";

  const post = (msg) => {
    try {
      window.parent.postMessage(msg, location.origin);
    } catch {
      /* not framed */
    }
  };
  const sameModel = (a, b) => !!a && !!b && a.provider === b.provider && a.modelId === b.modelId;
  const modelKey = (m) => (m ? m.provider + "/" + m.modelId : "");

  /* ---------- helpers (prototype markup) ---------- */
  function row(label, sub, ctl, cls) {
    return (
      '<div class="st-row' +
      (cls ? " " + cls : "") +
      '"><div class="st-label"><b>' +
      label +
      "</b>" +
      (sub ? "<span>" + sub + "</span>" : "") +
      '</div><div class="st-ctl">' +
      ctl +
      "</div></div>"
    );
  }
  function group(title, inner, meta) {
    return (
      '<section class="st-group"><div class="sect-label"><span>' +
      title +
      "</span>" +
      (meta || "") +
      '</div><div class="st-box">' +
      inner +
      "</div></section>"
    );
  }
  function sw(on, act, label, key, disabled) {
    return (
      '<button type="button" class="sw" role="switch" aria-checked="' +
      !!on +
      '" aria-label="' +
      esc(label) +
      '" data-act="' +
      act +
      '"' +
      (key ? ' data-key="' + esc(key) + '"' : "") +
      ' data-fk="' +
      act +
      ":" +
      esc(key || "") +
      '"' +
      (disabled ? " disabled" : "") +
      "></button>"
    );
  }
  function seg(options, value, act, label, key) {
    return (
      '<div class="seg text" role="group" aria-label="' +
      esc(label) +
      '">' +
      options
        .map(
          (o) =>
            '<button type="button" aria-pressed="' +
            (String(o[0]) === String(value)) +
            '" data-act="' +
            act +
            '" data-v="' +
            esc(o[0]) +
            '"' +
            (key ? ' data-key="' + esc(key) + '"' : "") +
            ' data-fk="' +
            act +
            ":" +
            esc(key || "") +
            ":" +
            esc(o[0]) +
            '">' +
            esc(o[1]) +
            "</button>",
        )
        .join("") +
      "</div>"
    );
  }
  function select(optionsHtml, act, label, key) {
    return (
      '<select class="sel" aria-label="' +
      esc(label) +
      '" data-act="' +
      act +
      '"' +
      (key ? ' data-key="' + esc(key) + '"' : "") +
      ' data-fk="' +
      act +
      ":" +
      esc(key || "") +
      '">' +
      optionsHtml +
      "</select>"
    );
  }
  const opts = (list, value) =>
    list
      .map(
        (o) =>
          '<option value="' +
          esc(o[0]) +
          '"' +
          (String(o[0]) === String(value) ? " selected" : "") +
          ">" +
          esc(o[1]) +
          "</option>",
      )
      .join("");
  const head = (title) => '<div class="st-head"><h1>' + title + "</h1></div>";
  const loading = (what) =>
    '<div class="st-loading"><i class="spinner"></i>Loading ' + what + "…</div>";

  /* ---------- sections ---------- */
  const PAGES = {};
  PAGES.general = function () {
    if (!prefs)
      return (
        head("General") +
        (prefsError
          ? '<p class="st-status is-error">' + esc(prefsError) + "</p>"
          : loading("preferences"))
      );
    const np = prefs.newProject,
      fmt = np.width + "x" + np.height;
    const formats = FORMATS.some((f) => f[0] === fmt)
      ? FORMATS
      : FORMATS.concat([[fmt, np.width + " × " + np.height + " · custom"]]);
    return (
      head("General") +
      group(
        "New projects",
        row(
          "Location",
          null,
          '<div class="loc"><span class="path" title="' +
            esc(np.location) +
            '">' +
            ic("folder") +
            esc(np.location) +
            '</span></div><button type="button" class="btn" data-act="choose-location" data-fk="choose-location">Choose…</button>',
        ) +
          row(
            "Open in",
            null,
            seg(
              [
                ["media", "Media"],
                ["story", "Story"],
                ["edit", "Edit"],
              ],
              np.openIn,
              "np",
              "Open new projects in",
              "openIn",
            ),
          ) +
          row("Format", null, select(opts(formats, fmt), "np-format", "Default format")) +
          row("Frame rate", null, select(opts(FPS, np.fps), "np-fps", "Default frame rate")),
        '<span class="note">Changes apply to projects you create next</span>',
      ) +
      group(
        "App",
        row(
          "On launch",
          null,
          select(
            opts(
              [
                ["last", "Reopen last project"],
                ["projects", "Show Projects"],
              ],
              prefs.onLaunch,
            ),
            "launch",
            "On launch",
          ),
        ) +
          row(
            "Confirm before moving projects to Trash",
            null,
            sw(prefs.confirmTrash, "confirm-trash", "Confirm before moving projects to Trash"),
          ),
      )
    );
  };
  PAGES.appearance = function () {
    const theme = prefs ? prefs.theme : OV.themePref();
    const tiles = [
      ["system", "Match system"],
      ["dark", "Dark"],
      ["light", "Light"],
    ]
      .map(
        (t) =>
          '<button type="button" class="st-theme" data-v="' +
          t[0] +
          '" aria-pressed="' +
          (theme === t[0]) +
          '" data-act="theme" data-fk="theme:' +
          t[0] +
          '">' +
          (t[0] === "system"
            ? '<i class="theme-dark"><span class="theme-light"></span></i>'
            : '<i class="theme-' + t[0] + '"></i>') +
          t[1] +
          "</button>",
      )
      .join("");
    return (
      head("Appearance") +
      group(
        "Interface",
        row(
          "Theme",
          theme === "system" ? "Follows the macOS appearance" : null,
          '<div class="st-themes" role="group" aria-label="Theme">' + tiles + "</div>",
        ),
      )
    );
  };
  function modelOptions(value, inherit) {
    let html = inherit
      ? '<option value=""' + (value ? "" : " selected") + ">Same as Director</option>"
      : '<option value=""' + (value ? "" : " selected") + ">Runtime default</option>";
    const models = (catalog && catalog.models) || [];
    [...new Set(models.map((m) => m.provider))].forEach((p) => {
      html +=
        '<optgroup label="' +
        esc(p) +
        '">' +
        models
          .filter((m) => m.provider === p)
          .map(
            (m) =>
              '<option value="' +
              esc(modelKey(m)) +
              '"' +
              (sameModel(m, value) ? " selected" : "") +
              ">" +
              esc(m.name) +
              "</option>",
          )
          .join("") +
        "</optgroup>";
    });
    if (value && !models.some((m) => sameModel(m, value)))
      html +=
        '<optgroup label="Unavailable"><option value="' +
        esc(modelKey(value)) +
        '" selected>' +
        esc(value.modelId) +
        "</option></optgroup>";
    return html;
  }
  PAGES.agents = function () {
    if (!agents)
      return (
        head("Agents") +
        (agentsError
          ? '<p class="st-status is-error">The agent runtime is unavailable: ' +
            esc(agentsError) +
            '</p><p><button type="button" class="btn" data-act="agents-retry">Try Again</button></p>'
          : loading("agent defaults"))
      );
    const rows = AGENTS.map((ag) => {
      const dir = ag.id === "director",
        cfg = dir ? agents.director : agents.specialists[ag.id],
        on = dir || cfg.enabledByDefault;
      const missing = cfg.model && catalog && !catalog.models.some((m) => sameModel(m, cfg.model));
      return (
        '<div class="st-row' +
        (on ? "" : " is-off") +
        '">' +
        '<div class="st-agent"><span class="st-mono" aria-hidden="true">' +
        ag.mono +
        '</span><div class="st-label"><b>' +
        ag.name +
        "</b><span>" +
        ag.role +
        "</span></div></div>" +
        '<div class="st-model-cell">' +
        select(modelOptions(cfg.model, !dir), "agent-model", ag.name + " model", ag.id) +
        (missing
          ? '<span class="status warning">' + ic("alert") + "Model unavailable</span>"
          : "") +
        "</div>" +
        seg(EFFORTS, cfg.thinking || "", "agent-effort", ag.name + " thinking effort", ag.id) +
        (dir
          ? '<span data-tip="Director is always on" data-tip-align="end">' +
            sw(true, "agent-on", "Director, always on", ag.id, true) +
            "</span>"
          : sw(cfg.enabledByDefault, "agent-on", ag.name + " on by default", ag.id)) +
        "</div>"
      );
    }).join("");
    const eq = agents.executionQuality || { preset: "balanced" };
    const options = eq.preset === "custom" ? QUALITY.concat([["custom", "Custom"]]) : QUALITY;
    return (
      head("Agents") +
      '<section class="st-group st-agents"><div class="sect-label"><span>Defaults for new chats</span><button type="button" class="link push" data-act="agents-reset" data-fk="agents-reset">Reset to defaults</button></div><div class="st-box">' +
      '<div class="st-row st-th list-head" aria-hidden="true"><span>Agent</span><span>Model</span><span>Thinking effort</span><span>On</span></div>' +
      rows +
      '</div><p class="st-foot">Per-chat changes in the Chat panel override these. Models come from connected providers.</p></section>' +
      group(
        "Execution",
        row(
          "Execution quality",
          QUALITY_NOTE[eq.preset] || "",
          seg(options, eq.preset, "quality", "Default Execution Quality"),
        ),
      ) +
      (agentsNote
        ? '<p class="st-status' +
          (agentsNote.startsWith("!") ? " is-error" : "") +
          '" role="status">' +
          esc(agentsNote.replace(/^!/, "")) +
          "</p>"
        : "")
    );
  };

  /* ---------- render ---------- */
  const nav = document.getElementById("stNav"),
    main = document.getElementById("stMain"),
    title = document.getElementById("stTitle");
  function renderNav() {
    let html = "",
      last = "";
    SECTIONS.forEach((s) => {
      if (s.group !== last) {
        html += '<div class="nav-label">' + s.group + "</div>";
        last = s.group;
      }
      html +=
        '<button type="button" class="nav-item" data-section="' +
        s.id +
        '"' +
        (s.id === section ? ' aria-current="page"' : "") +
        ">" +
        ic(s.icon) +
        '<span class="grow">' +
        s.label +
        "</span></button>";
    });
    nav.innerHTML = html;
  }
  function render(keepScroll) {
    const fk =
      document.activeElement && document.activeElement.dataset
        ? document.activeElement.dataset.fk
        : null;
    const top = main.scrollTop;
    title.textContent = SECTIONS.find((s) => s.id === section).label;
    renderNav();
    main.innerHTML = '<div class="st-page">' + PAGES[section]() + "</div>";
    if (keepScroll) main.scrollTop = top;
    if (fk) {
      const el = main.querySelector('[data-fk="' + CSS.escape(fk) + '"]');
      if (el && !el.disabled) el.focus({ preventScroll: true });
    }
  }
  function go(id) {
    section = id;
    store.set(SECTION_KEY, id);
    render(false);
    main.scrollTop = 0;
  }

  /* ---------- data ---------- */
  function savePrefs(patch) {
    api("/api/preferences", patch, "PUT")
      .then((next) => {
        prefs = next;
        prefsError = null;
        post({ type: "ov-prefs", prefs: next });
        render(true);
      })
      .catch((err) => {
        prefsError = "Couldn’t save: " + err.message;
        render(true);
      });
  }
  function loadAgents() {
    agentsError = null;
    Promise.all([api("/api/agent/settings"), api("/api/agent/models")])
      .then(([s, c]) => {
        agents = s;
        catalog = c;
        render(true);
      })
      .catch((err) => {
        agentsError = err.message;
        render(true);
      });
  }
  function saveAgents(patch, note) {
    if (agentsSaving) return;
    agentsSaving = true;
    api("/api/agent/settings", patch, "PUT")
      .then((next) => {
        agents = next;
        agentsNote = note || "";
        post({ type: "ov-agents" });
      })
      .catch((err) => {
        agentsNote = "!Couldn’t save: " + err.message;
      })
      .finally(() => {
        agentsSaving = false;
        render(true);
      });
  }
  const specialistPatch = (id, change) => ({
    specialists: { [id]: Object.assign({}, agents.specialists[id], change) },
  });
  function parseModel(value) {
    const m = ((catalog && catalog.models) || []).find((x) => modelKey(x) === value);
    return m ? { provider: m.provider, modelId: m.modelId } : null;
  }

  /* ---------- actions ---------- */
  nav.addEventListener("click", (e) => {
    const b = e.target.closest("[data-section]");
    if (b) go(b.dataset.section);
  });
  nav.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = SECTIONS.findIndex((s) => s.id === section),
      n = SECTIONS[(i + (e.key === "ArrowDown" ? 1 : SECTIONS.length - 1)) % SECTIONS.length].id;
    go(n);
    nav.querySelector('[data-section="' + n + '"]').focus();
  });
  main.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t || t.tagName === "SELECT" || t.disabled) return;
    const a = t.dataset.act;
    if (a === "np") savePrefs({ newProject: { [t.dataset.key]: t.dataset.v } });
    else if (a === "confirm-trash") savePrefs({ confirmTrash: !prefs.confirmTrash });
    else if (a === "choose-location")
      api("/api/pick-parent", {})
        .then((r) => {
          if (!r.cancelled) savePrefs({ newProject: { location: r.path } });
        })
        .catch((err) => {
          prefsError = err.message;
          render(true);
        });
    else if (a === "theme") {
      OV.applyTheme(t.dataset.v);
      post({ type: "ov-theme", pref: t.dataset.v });
      savePrefs({ theme: t.dataset.v });
    } else if (a === "agents-retry") {
      render(true);
      loadAgents();
    } else if (!agents) return;
    else if (a === "agent-effort") {
      const v = t.dataset.v || null;
      saveAgents(
        t.dataset.key === "director"
          ? { director: Object.assign({}, agents.director, { thinking: v }) }
          : specialistPatch(t.dataset.key, { thinking: v }),
      );
    } else if (a === "agent-on")
      saveAgents(
        specialistPatch(t.dataset.key, {
          enabledByDefault: !agents.specialists[t.dataset.key].enabledByDefault,
        }),
      );
    else if (a === "quality") {
      const eq = agents.executionQuality || {};
      if (t.dataset.v !== "custom")
        saveAgents({ executionQuality: { preset: t.dataset.v, custom: eq.custom } });
    } else if (a === "agents-reset") {
      const specialists = {};
      AGENTS.slice(1).forEach((ag) => {
        specialists[ag.id] = {
          model: null,
          thinking: null,
          allowedModels: [],
          enabledByDefault: true,
        };
      });
      saveAgents(
        { director: { model: null, thinking: null }, specialists },
        "Agent defaults reset.",
      );
    }
  });
  main.addEventListener("change", (e) => {
    const t = e.target,
      a = t.dataset.act;
    if (a === "np-format") {
      const [w, h] = t.value.split("x").map(Number);
      savePrefs({ newProject: { width: w, height: h } });
    } else if (a === "np-fps") savePrefs({ newProject: { fps: Number(t.value) } });
    else if (a === "launch") savePrefs({ onLaunch: t.value });
    else if (a === "agent-model" && agents) {
      const model = t.value ? parseModel(t.value) : null;
      saveAgents(
        t.dataset.key === "director"
          ? { director: Object.assign({}, agents.director, { model }) }
          : specialistPatch(t.dataset.key, { model }),
      );
    }
  });

  /* Framed over Projects: the close button, Esc, ⌘W and a click outside return to it. */
  document.documentElement.classList.add("st-embed");
  const close = () => post({ type: "ov-settings-close" });
  const closeBtn = document.querySelector("button.tl.close");
  closeBtn.innerHTML = ic("x");
  closeBtn.onclick = close;
  document.body.addEventListener("mousedown", (e) => {
    if (e.target === document.body) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      close();
    } else if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "w" || e.key === ",")) {
      e.preventDefault();
      close();
    }
  });

  render(false);
  api("/api/preferences")
    .then((p) => {
      prefs = p;
      render(true);
    })
    .catch((err) => {
      prefsError = err.message;
      render(true);
    });
  loadAgents();
})();
