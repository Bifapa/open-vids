/* Settings → Models & Providers: the agent runtime's providers (GET /api/agent/providers, POST …/refresh) with
   their models (GET …/providers/:id/models) and the API key OpenVids keeps per provider
   (POST …/providers/:id/api-key {apiKey|null}). What is and isn't possible (see the settings contract):
   keys typed here live in a private file on this Mac (~/.openvids/agent), not in the macOS Keychain and not in
   OMP; there is no in-app sign-in (an expired OMP sign-in is renewed in OMP); only keys stored by OpenVids
   (credentialSource "api-key") can be removed here. */
(function () {
  "use strict";
  const { ic, esc, api, S, ui, PAGES, CLICK, INPUT, ENTER, AGENTS, group, head, lede } = OVS;

  /* Shown first, with the connected / error / sign-in ones; every other provider sits behind a disclosure. */
  const WELL_KNOWN = ["anthropic", "openai", "google", "openrouter", "ollama"];
  const MODEL_CAP = 12;
  const KEY_FOOT =
    "Stored in a private file on this Mac, readable only by you. Not in the macOS Keychain, and not shared with OMP.";

  const firstLine = (text, max) => {
    const line = String(text || "")
      .split("\n")[0]
      .trim();
    return line.length > max ? line.slice(0, max - 1) + "…" : line;
  };
  function ago(ts) {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60e3));
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    if (m < 24 * 60) return Math.round(m / 60) + " h ago";
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  /* ---------- data ---------- */
  function loadProviders() {
    S.providersError = null;
    return api("/api/agent/providers")
      .then(OVS.setProviders)
      .catch((err) => {
        /* A refresh that fails keeps the list it has; only a first load shows the error. */
        if (!S.providers) S.providersError = err.message;
      })
      .finally(() => OVS.render(true));
  }
  /* Models of one provider, loaded when its row opens (and for Jev's provider). A stale answer is dropped. */
  function loadModels(id) {
    const mark = { status: "loading" };
    S.provModels[id] = mark;
    return api(`/api/agent/providers/${encodeURIComponent(id)}/models`)
      .then((r) => {
        if (S.provModels[id] === mark)
          S.provModels[id] = { status: "ready", models: Array.isArray(r.models) ? r.models : [] };
      })
      .catch((err) => {
        if (S.provModels[id] === mark) S.provModels[id] = { status: "failed", error: err.message };
      })
      .finally(() => OVS.render(true));
  }
  function ensureModels(id) {
    if (id && !S.provModels[id]) loadModels(id);
  }
  /* Whatever changed a provider can change what the catalog offers and what the page underneath shows. */
  function providersChanged() {
    S.provModels = {};
    Object.keys(ui.open).forEach((id) => {
      const p = OVS.providerById(id);
      if (ui.open[id] && p && p.status !== "not_configured") loadModels(id);
    });
    OVS.reloadCatalog();
    OVS.post({ type: "ov-agents" });
  }
  function sync(rowId) {
    if (ui.busy.sync) return;
    ui.busy.sync = true;
    if (rowId) ui.busy[rowId] = "Checking…";
    ui.flags.providersNote = "";
    api("/api/agent/providers/refresh", undefined, "POST")
      .then((res) => {
        OVS.setProviders(res);
        providersChanged();
      })
      .catch((err) => {
        ui.flags.providersNote = "!Couldn’t refresh: " + err.message;
      })
      .finally(() => {
        delete ui.busy.sync;
        if (rowId) delete ui.busy[rowId];
        OVS.render(true);
      });
  }
  /* Store (string) or remove (null) the key OpenVids keeps for one provider. A new key is checked live, which
     can take ~10 s when the provider is unreachable: the row shows a busy label meanwhile. */
  function setKey(id, apiKey, label) {
    ui.busy[id] = label;
    ui.flags.providersNote = "";
    ui.pendingFk = `key:${id}`;
    api(`/api/agent/providers/${encodeURIComponent(id)}/api-key`, { apiKey })
      .then((res) => {
        /* The key is stored now (even if the provider then turns out to dislike it): drop the draft. */
        delete ui.draft[`prov:${id}`];
        delete ui.err[`prov:${id}`];
        OVS.setProviders(res);
        if (apiKey !== null) ui.open[id] = true;
        else if (OVS.providerById(id) && OVS.providerById(id).status === "not_configured")
          ui.open[id] = false;
        providersChanged();
      })
      .catch((err) => {
        ui.err[`prov:${id}`] = err.message;
      })
      .finally(() => {
        delete ui.busy[id];
        OVS.render(true);
        ui.pendingFk = null;
      });
  }
  function setLogout(id) {
    ui.busy[id] = "Signing out…";
    ui.flags.providersNote = "";
    api(`/api/agent/providers/${encodeURIComponent(id)}/oauth/logout`, undefined, "POST")
      .then((res) => {
        OVS.setProviders(res);
        providersChanged();
      })
      .catch((err) => {
        ui.flags.providersNote = "!Couldn’t sign out: " + err.message;
      })
      .finally(() => {
        delete ui.busy[id];
        OVS.render(true);
      });
  }
  function connect(id) {
    const k = `prov:${id}`,
      v = (ui.draft[k] || "").trim();
    if (!v) ui.err[k] = "Paste an API key first.";
    else if (/\s/.test(v)) ui.err[k] = "An API key can’t contain spaces.";
    else if (v.length > 4096) ui.err[k] = "That key is too long.";
    else {
      delete ui.err[k];
      setKey(id, v, "Checking the key…");
    }
  }

  /* ---------- who uses a model ---------- */
  function usedBy(provider, modelId) {
    if (!S.agents) return null;
    const sel = { provider, modelId };
    const users = AGENTS.filter((ag) => {
      const on = ag.id === "director" || S.agents.specialists[ag.id].enabledByDefault;
      return on && OVS.sameModel(OVS.effectiveModel(ag.id), sel);
    }).map((ag) => ag.name);
    const j = S.agents.jev;
    if (j.enabled && j.provider === provider && j.modelId === modelId) users.push("Jev");
    return users;
  }

  /* ---------- markup ---------- */
  function keyForm(p, label) {
    const err = ui.err[`prov:${p.id}`],
      id = esc(p.id);
    return (
      `<div class="st-inline"><input class="input mono${err ? " is-invalid" : ""}" type="password" autocomplete="off" spellcheck="false" placeholder="${label}" aria-label="${esc(
        p.name + " " + label,
      )}" data-act="key-input" data-v="${id}" data-draft="prov:${id}" data-fk="key:${id}"${
        err ? ` aria-invalid="true" aria-describedby="err-${id}"` : ""
      } /><button type="button" class="btn" data-act="prov-connect" data-v="${id}" data-fk="connect:${id}">Connect</button></div>` +
      (err ? `<p class="st-field-err" id="err-${id}" role="alert">${esc(err)}</p>` : "") +
      `<p class="st-foot">${KEY_FOOT}</p>`
    );
  }
  const disconnectLink = (p) =>
    `<div><button type="button" class="link" data-act="prov-disconnect" data-v="${esc(p.id)}" data-fk="disconnect:${esc(
      p.id,
    )}">Disconnect</button></div>`;
  const errLog = (p) =>
    `<pre class="st-err-log">${esc(p.error || "No details were reported.")}</pre>`;

  function modelsBlock(p) {
    const m = S.provModels[p.id];
    if (!m || m.status === "loading")
      return `<p class="st-foot"><span class="st-preset-note"><i class="spinner" aria-hidden="true"></i>Loading models…</span></p>`;
    if (m.status === "failed")
      return `<p class="st-field-err">Couldn’t load the models: ${esc(m.error)} <button type="button" class="link" data-act="prov-models-retry" data-v="${esc(
        p.id,
      )}" data-fk="models-retry:${esc(p.id)}">Retry</button></p>`;
    if (m.models.length === 0) return `<p class="st-foot">This provider lists no models.</p>`;
    const all = !!ui.flags[`allModels:${p.id}`];
    const rows = m.models
      .map((x) => ({ x, users: usedBy(p.id, x.modelId) }))
      .sort((a, b) => (b.users ? b.users.length > 0 : 0) - (a.users ? a.users.length > 0 : 0));
    const shown = all ? rows : rows.slice(0, MODEL_CAP);
    return (
      `<dl class="st-models">${shown
        .map(
          ({ x, users }) =>
            `<dt title="${esc(x.modelId)}">${esc(x.name || x.modelId)}</dt><dd>${
              users == null ? "" : users.length ? esc(users.join(", ")) : "Not used"
            }</dd>`,
        )
        .join("")}</dl>` +
      (rows.length > MODEL_CAP
        ? `<div><button type="button" class="link" data-act="prov-models-more" data-v="${esc(p.id)}" data-fk="models-more:${esc(
            p.id,
          )}">${all ? "Show fewer models" : `Show all ${rows.length} models`}</button></div>`
        : "")
    );
  }

  /* Sign out of a sign-in made inside OpenVids (credentialSource "oauth"); it does not revoke anything at the provider. */
  const signOutBlock = (p) =>
    `<p class="st-foot">Signed in with OpenVids. The sign-in is kept in a private OpenVids database on this Mac, never in the OMP setup. Signing out removes it from this Mac; it doesn’t revoke OpenVids’ access at ${esc(p.name)} — do that in your ${esc(p.name)} account settings.</p><div><button type="button" class="link" data-act="signout" data-v="${esc(p.id)}" data-fk="signout:${esc(p.id)}">Sign out</button></div>`;

  function providerBody(p) {
    const si = OVS.signin;
    /* A sign-in in progress is all the row shows: nothing else to do until it ends. */
    if (si.running(p.id)) return wrapBody(p, si.panel(p));
    let body = si.panel(p);
    if (p.status === "connected") {
      body +=
        modelsBlock(p) +
        (p.credentialSource === "oauth"
          ? signOutBlock(p)
          : p.credentialSource === "api-key"
            ? `<p class="st-foot">Key stored in a private file on this Mac, readable only by you. Not in the macOS Keychain, and not shared with OMP.</p>${disconnectLink(p)}`
            : p.keyless
              ? `<p class="st-foot">Runs on this Mac and needs no credential.</p>`
              : `<p class="st-foot">Connected through your OMP setup. OpenVids only reads it and can’t change or remove it from here.</p>`);
    } else if (p.status === "error") {
      body +=
        errLog(p) +
        si.start(p) +
        keyForm(p, p.credentialSource === "api-key" ? "Replace API key" : "API key") +
        (p.credentialSource === "api-key" ? disconnectLink(p) : "") +
        (p.credentialSource === "oauth" ? signOutBlock(p) : "");
    } else if (p.status === "signin_required") {
      body +=
        (p.error ? errLog(p) : "") +
        (p.oauth
          ? si.start(p)
          : `<p class="st-foot">This sign-in is made in OMP. Sign in to ${esc(p.name)} there, then press Refresh above. Models stay listed while signed out, but agents can’t use them. Or use an API key instead.</p>`) +
        keyForm(p, "API key");
    } else {
      body += si.start(p) + keyForm(p, "API key");
    }
    return wrapBody(p, body);
  }
  const wrapBody = (p, body) =>
    `<div class="st-prov-body" data-provider-body="${esc(p.id)}">${body}</div>`;

  function providerRow(p) {
    const open = !!ui.open[p.id],
      busy = ui.busy[p.id],
      id = esc(p.id),
      keyBtn = `<button type="button" class="btn" data-act="prov-open" data-v="${id}" data-fk="setup:${id}">Use an API key</button>`;
    let dot = "off",
      badge = '<span class="badge">Not configured</span>',
      sub = "Add an API key to use it",
      act = "";
    if (p.status === "connected") {
      const via = p.keyless
        ? "Local · no key needed"
        : p.credentialSource === "api-key"
          ? "API key in OpenVids"
          : p.credentialSource === "oauth"
            ? "Signed in with OpenVids"
            : p.credentialSource === "omp"
              ? "From your OMP setup"
              : "Credential found";
      dot = "ok";
      badge = '<span class="badge success">Connected</span>';
      sub = `${via} · ${p.modelCount} ${p.modelCount === 1 ? "model" : "models"}${
        p.verified || p.keyless ? "" : " · not checked"
      }`;
    } else if (p.status === "signin_required") {
      dot = "warn";
      badge = '<span class="badge warning">Sign-in required</span>';
      sub = firstLine(p.error, 100) || "The OMP sign-in expired";
      act = open ? "" : OVS.signin.rowAction(p) + keyBtn;
    } else if (p.status === "error") {
      dot = "err";
      badge = '<span class="badge error">Error</span>';
      sub = firstLine(p.error, 100) || "The provider couldn’t be checked";
      act =
        `<button type="button" class="btn" data-act="prov-retry" data-v="${id}" data-fk="retry:${id}">Retry</button>` +
        OVS.signin.rowAction(p);
    } else if (!open) {
      act = p.oauth
        ? OVS.signin.rowAction(p) + keyBtn
        : `<button type="button" class="btn" data-act="prov-open" data-v="${id}" data-fk="setup:${id}">Set up</button>`;
    }
    const signing = OVS.signin.rowState(p);
    if (signing) {
      badge = `<span class="st-preset-note"><i class="spinner" aria-hidden="true"></i>${esc(signing)}</span>`;
      act = "";
    }
    if (busy) {
      badge = `<span class="st-preset-note"><i class="spinner" aria-hidden="true"></i>${esc(busy)}</span>`;
      act = "";
    }
    const toggle =
      p.status === "not_configured" && !open
        ? ""
        : `<button type="button" class="icon-btn st-prov-toggle" aria-expanded="${open}" aria-label="${
            open ? "Hide" : "Show"
          } ${esc(p.name)} details" data-act="prov-toggle" data-v="${id}" data-fk="toggle:${id}">${ic(
            "chevron-right",
          )}</button>`;
    return (
      `<div class="st-prov" data-provider="${id}"><span class="dot ${dot}" aria-hidden="true"></span><div class="st-label"><b>${esc(
        p.name,
      )}</b><span title="${esc(sub)}">${esc(sub)}</span></div><div class="st-ctl">${badge}${act}${toggle}</div></div>` +
      (open ? providerBody(p) : "")
    );
  }

  function split() {
    const rank = (p) => {
      const i = WELL_KNOWN.indexOf(p.id);
      return i < 0 ? 99 : i;
    };
    const byName = (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name);
    const list = S.providers || [];
    const shown = (p) => p.status !== "not_configured" || WELL_KNOWN.includes(p.id);
    return {
      primary: list.filter(shown).sort(byName),
      rest: list.filter((p) => !shown(p)).sort(byName),
    };
  }

  PAGES.providers = function () {
    if (!S.providers)
      return (
        head("Models & Providers") +
        (S.providersError
          ? OVS.failure("The agent runtime is unavailable", S.providersError, "providers-retry")
          : OVS.loading("providers"))
      );
    const { primary, rest } = split();
    const showAll = !!ui.flags.showAllProviders;
    const connected = S.providers.filter((p) => p.status === "connected").length;
    const meta = `<span class="st-head-meta">${
      ui.busy.sync
        ? '<i class="spinner" aria-hidden="true"></i>Syncing…'
        : esc(S.syncedAt ? "Synced " + ago(S.syncedAt) : "Not synced yet")
    }<button type="button" class="btn" data-act="sync" data-fk="sync"${ui.busy.sync ? " disabled" : ""}>${ic(
      "refresh",
    )}Refresh</button></span>`;
    const disclosure = rest.length
      ? `<div class="st-sub"><button type="button" class="link" data-act="providers-all" aria-expanded="${showAll}" data-fk="providers-all">${
          showAll ? "Hide other providers" : `Show all providers (${rest.length} more)`
        }</button></div>`
      : "";
    return (
      head("Models & Providers", meta) +
      lede(
        "Providers and their models come from your OMP setup, plus any API key you add here. Agents and Jev can only use models from connected providers.",
      ) +
      OVS.noteHtml(ui.flags.providersNote) +
      group(
        "Providers",
        primary.map(providerRow).join("") +
          disclosure +
          (showAll ? rest.map(providerRow).join("") : ""),
        `<span class="note">${connected} of ${S.providers.length} connected</span>`,
      )
    );
  };

  /* ---------- actions ---------- */
  function openRow(id) {
    ui.open[id] = true;
    const p = OVS.providerById(id);
    if (p && p.status === "connected") ensureModels(id);
  }
  CLICK["providers-retry"] = () => {
    loadProviders();
  };
  CLICK["goto-provider"] = (t) => {
    const id = t.dataset.v,
      p = OVS.providerById(id);
    if (p && split().rest.includes(p)) ui.flags.showAllProviders = true;
    openRow(id);
    OVS.go("providers");
    const el = OVS.main.querySelector(`[data-provider="${CSS.escape(id)}"]`);
    if (el) el.scrollIntoView({ block: "center" });
    return false;
  };
  CLICK["providers-all"] = () => {
    ui.flags.showAllProviders = !ui.flags.showAllProviders;
  };
  CLICK["prov-toggle"] = (t) => {
    const id = t.dataset.v;
    if (ui.open[id]) ui.open[id] = false;
    else openRow(id);
  };
  CLICK["prov-open"] = (t) => {
    openRow(t.dataset.v);
    ui.pendingFk = `key:${t.dataset.v}`;
  };
  CLICK["prov-retry"] = (t) => sync(t.dataset.v);
  CLICK.sync = () => sync(null);
  CLICK["prov-connect"] = (t) => connect(t.dataset.v);
  CLICK["prov-disconnect"] = (t) => setKey(t.dataset.v, null, "Disconnecting…");
  CLICK.signout = (t) => setLogout(t.dataset.v);
  CLICK["prov-models-retry"] = (t) => loadModels(t.dataset.v);
  CLICK["prov-models-more"] = (t) => {
    const k = `allModels:${t.dataset.v}`;
    ui.flags[k] = !ui.flags[k];
  };
  /* Drafts and their errors share one key (data-draft): "prov:<id>" here, "jev" in Settings → Jev. */
  INPUT["key-input"] = (t) => {
    const k = t.dataset.draft;
    ui.draft[k] = t.value;
    if (ui.err[k]) {
      delete ui.err[k];
      OVS.render(true);
    }
  };
  ENTER["key-input"] = (t) => {
    if (t.dataset.draft === "jev") OVS.jevSave();
    else connect(t.dataset.v);
    OVS.render(true);
  };

  /* Every provider in display order (for pickers elsewhere). */
  OVS.providerList = () => {
    const { primary, rest } = split();
    return primary.concat(rest);
  };
  OVS.providerRow = providerRow;
  OVS.loadProviders = loadProviders;
  OVS.providersChanged = providersChanged;
  OVS.loadModels = loadModels;
  OVS.ensureModels = ensureModels;
  OVS.ON_ENTER.providers = () => {
    /* Come back to a list that may have changed (a key set in OMP meanwhile): re-read it quietly. */
    if (S.providers) loadProviders();
    OVS.signin.onEnter();
  };
})();
