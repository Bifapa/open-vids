/* Settings → Jev: the shared fast worker. Its fields are agents.jev in the global agent settings
   (GET/PUT /api/agent/settings: enabled, provider, modelId, thinking, credentials "provider-login" | "api-key"),
   its own API key (POST /api/agent/jev/api-key {apiKey|null}; the key is never returned, only apiKeyConfigured)
   and a live check (POST /api/agent/jev/test). Models of the chosen provider: GET /api/agent/providers/:id/models. */
(function () {
  "use strict";
  const { ic, esc, api, S, ui, PAGES, CLICK, CHANGE, row, group, sw, select, opts, head, lede } =
    OVS;

  const EFFORT_LABELS = {
    off: "Off",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
  };
  /* Jev runs short jobs: when a provider is picked, start from its quick model rather than leave Jev without one. */
  const FAST_MODEL = /(^|[-_/.: ])(haiku|mini|flash|lite|nano|small|instant)([-_/.: ]|$)/i;
  const KEY_FOOT =
    "Stored in a private file on this Mac, readable only by you. Not in the macOS Keychain, and not shared with OMP.";

  const jevModels = (id) => (id ? S.provModels[id] : null);
  const jevModelInfo = (j) => {
    const m = jevModels(j.provider);
    return m && m.status === "ready" ? m.models.find((x) => x.modelId === j.modelId) || null : null;
  };
  const clearTest = () => {
    ui.flags.jevTest = null;
  };

  function providerOptions(j, keyMode) {
    const list = OVS.providerList();
    const items = list.map((p) => {
      const note =
        p.status === "connected"
          ? ""
          : p.status === "signin_required"
            ? " — needs sign-in"
            : p.status === "error"
              ? " — error"
              : " — not set up";
      /* With Jev's own key any provider will do; with the agents' connection only a connected one can. */
      return [p.id, p.name + note, !keyMode && !p.authenticated && p.id !== j.provider];
    });
    if (j.provider && !list.some((p) => p.id === j.provider))
      items.unshift([j.provider, j.provider]);
    if (!j.provider) items.unshift(["", "Choose a provider", true]);
    return opts(items, j.provider || "");
  }

  function modelRow(j) {
    const m = jevModels(j.provider);
    let ctl,
      sub = null;
    if (!j.provider) {
      ctl = select(
        opts([["", "Choose a provider first", true]], ""),
        "jev-model",
        "Jev model",
        null,
        "",
        true,
      );
    } else if (!m || m.status === "loading") {
      ctl = select(
        opts([["", "Loading models…", true]], ""),
        "jev-model",
        "Jev model",
        null,
        "",
        true,
      );
    } else if (m.status === "failed") {
      ctl = select(
        opts([["", "Models unavailable", true]], ""),
        "jev-model",
        "Jev model",
        null,
        "",
        true,
      );
      sub = `<span class="status error">${ic("alert")}${esc(m.error)} · <button type="button" class="link" data-act="jev-models-retry" data-fk="jev-models-retry">Retry</button></span>`;
    } else if (m.models.length === 0) {
      ctl = select(opts([["", "No models", true]], ""), "jev-model", "Jev model", null, "", true);
    } else {
      const items = m.models.map((x) => [x.modelId, x.name || x.modelId]);
      if (!j.modelId) items.unshift(["", "Choose a model", true]);
      else if (!m.models.some((x) => x.modelId === j.modelId))
        items.push([j.modelId, j.modelId + " (unavailable)"]);
      ctl = select(opts(items, j.modelId || ""), "jev-model", "Jev model");
    }
    return row("Model", sub, ctl);
  }

  function thinkingRow(j) {
    const info = jevModelInfo(j);
    if (!info || !info.efforts || info.efforts.length === 0) return "";
    const values = ["off"].concat(info.efforts.filter((e) => e !== "off"));
    if (j.thinking && !values.includes(j.thinking)) values.push(j.thinking);
    return row(
      "Thinking effort",
      null,
      select(
        opts(
          [["", "Default"]].concat(values.map((e) => [e, EFFORT_LABELS[e] || e])),
          j.thinking || "",
        ),
        "jev-thinking",
        "Jev thinking effort",
      ),
    );
  }

  function credentialBlock(j, prov) {
    const name = prov ? prov.name : j.provider || "provider";
    if (prov && prov.keyless && j.credentials !== "api-key")
      return row(
        "API key",
        "Local providers don’t need one.",
        `<span class="status success">${ic("check")}Not needed</span>`,
      );
    const radio = (mode, label, hint) =>
      `<button type="button" class="st-radio" role="radio" aria-checked="${j.credentials === mode}" data-act="jev-cred" data-v="${mode}" data-fk="jev-cred:${mode}"><span class="st-label"><b>${label}</b><span>${hint}</span></span></button>`;
    const radios = `<div class="st-choice" role="radiogroup" aria-label="Jev credential">${radio(
      "provider-login",
      `Use the ${esc(name)} connection`,
      "Same credential and limits as your agents",
    )}${radio("api-key", "Separate API key for Jev", "Keeps Jev’s usage and rate limits apart")}</div>`;
    if (j.credentials !== "api-key") return radios;
    const busy = ui.busy.jev;
    if (j.apiKeyConfigured && !ui.flags.jevReplace) {
      const status = busy
        ? `<span class="st-preset-note"><i class="spinner" aria-hidden="true"></i>${esc(busy)}</span>`
        : `<span class="status success">${ic("check")}Key saved</span>`;
      return (
        radios +
        row(
          "API key",
          '<span class="mono">••••••••••••</span> · Saved in a private file on this Mac',
          `${status}<button type="button" class="btn" data-act="jev-replace" data-fk="jev-replace"${
            busy ? " disabled" : ""
          }>Replace</button><button type="button" class="btn btn-ghost" data-act="jev-remove" data-fk="jev-remove"${
            busy ? " disabled" : ""
          }>Remove</button>`,
        )
      );
    }
    const err = ui.err.jev;
    return (
      radios +
      `<div class="st-sub"><div class="st-inline"><input class="input mono${err ? " is-invalid" : ""}" type="password" autocomplete="off" spellcheck="false" placeholder="Paste ${esc(
        name,
      )} API key" aria-label="Jev API key" data-act="key-input" data-v="jev" data-draft="jev" data-fk="key:jev"${
        err ? ' aria-invalid="true" aria-describedby="err-jev"' : ""
      } /><button type="button" class="btn" data-act="jev-save" data-fk="jev-save"${busy ? " disabled" : ""}>${
        busy ? esc(busy) : "Save"
      }</button>${
        j.apiKeyConfigured
          ? '<button type="button" class="btn btn-ghost" data-act="jev-replace-cancel" data-fk="jev-replace-cancel">Cancel</button>'
          : ""
      }</div>${err ? `<p class="st-field-err" id="err-jev" role="alert">${esc(err)}</p>` : ""}<p class="st-foot">${KEY_FOOT}</p></div>`
    );
  }

  function checkBlock() {
    const t = ui.flags.jevTest,
      busy = !!(t && t.busy);
    const status = busy
      ? '<span class="st-preset-note"><i class="spinner" aria-hidden="true"></i>Testing…</span>'
      : t && t.ok
        ? `<span class="status success">${ic("check")}Replied in ${((Number(t.elapsedMs) || 0) / 1000).toFixed(1)} s</span>`
        : t
          ? `<span class="status error">${ic("alert")}Failed</span>`
          : "";
    const detail =
      t && t.ok
        ? `<div class="st-sub"><pre class="st-err-log">${esc(t.model && t.model.modelId)}\n${esc(t.reply)}</pre></div>`
        : t && !busy
          ? `<div class="st-sub"><p class="st-field-err" role="alert">${esc(t.message || "The test failed.")}</p></div>`
          : "";
    return (
      row(
        "Test Jev",
        "Sends a short prompt with the settings above.",
        `<span aria-live="polite">${status}</span><button type="button" class="btn" data-act="jev-test" data-fk="jev-test"${
          busy ? " disabled" : ""
        }>Test</button>`,
      ) + detail
    );
  }

  PAGES.jev = function () {
    const intro = lede(
      "A fast worker the Director and specialists hand small, well-defined tasks. It doesn’t take part in chats on its own.",
    );
    if (!S.agents)
      return (
        head("Jev") +
        intro +
        (S.agentsError
          ? OVS.failure("The agent runtime is unavailable", S.agentsError, "agents-retry")
          : OVS.loading("Jev"))
      );
    const j = S.agents.jev,
      prov = OVS.providerById(j.provider),
      keyMode = j.credentials === "api-key";
    const warn = !keyMode && OVS.providerBad(prov) ? OVS.providerWarn(prov) : null;
    return (
      head("Jev") +
      intro +
      OVS.noteHtml(S.agentsNote) +
      group(
        "Worker",
        row(
          "Use Jev",
          "Off: agents do Jev’s small tasks themselves.",
          sw(j.enabled, "jev-on", "Use Jev"),
        ) +
          row(
            "Provider",
            warn,
            select(
              providerOptions(j, keyMode),
              "jev-provider",
              "Jev provider",
              null,
              warn ? "is-warn" : "",
            ),
          ) +
          modelRow(j) +
          thinkingRow(j),
      ) +
      group("Credential", credentialBlock(j, prov)) +
      group("Check", checkBlock())
    );
  };

  /* ---------- actions ---------- */
  const patchJev = (jev) => {
    clearTest();
    return OVS.saveAgents({ jev });
  };
  CLICK["jev-on"] = () => {
    const next = !S.agents.jev.enabled;
    patchJev({ enabled: next });
  };
  CLICK["jev-cred"] = (t) => {
    if (S.agents.jev.credentials === t.dataset.v) return;
    ui.flags.jevReplace = false;
    patchJev({ credentials: t.dataset.v });
  };
  CLICK["jev-models-retry"] = () => {
    if (S.agents.jev.provider) OVS.loadModels(S.agents.jev.provider);
  };
  CLICK["jev-replace"] = () => {
    ui.flags.jevReplace = true;
    ui.pendingFk = "key:jev";
  };
  CLICK["jev-replace-cancel"] = () => {
    ui.flags.jevReplace = false;
    delete ui.draft.jev;
    delete ui.err.jev;
    ui.pendingFk = "jev-replace";
  };
  CLICK["jev-save"] = () => jevSave();
  CLICK["jev-remove"] = () => {
    ui.busy.jev = "Removing…";
    delete ui.err.jev;
    ui.pendingFk = "key:jev";
    clearTest();
    api("/api/agent/jev/api-key", { apiKey: null })
      .then(applyKeyResult)
      .catch((err) => {
        ui.err.jev = err.message;
        ui.flags.jevReplace = false;
      })
      .finally(() => {
        delete ui.busy.jev;
        OVS.render(true);
        ui.pendingFk = null;
      });
  };
  CLICK["jev-test"] = () => {
    if (ui.flags.jevTest && ui.flags.jevTest.busy) return;
    ui.flags.jevTest = { busy: true };
    api("/api/agent/jev/test", {})
      .then((r) => {
        ui.flags.jevTest = r;
      })
      .catch((err) => {
        ui.flags.jevTest = { ok: false, message: err.message };
      })
      .finally(() => OVS.render(true));
  };
  function applyKeyResult(next) {
    S.agents = next;
    delete ui.draft.jev;
    delete ui.err.jev;
    ui.flags.jevReplace = false;
    OVS.post({ type: "ov-agents" });
  }
  /* The key leaves the page in this one request: once the runtime has it, the draft is dropped and only
     apiKeyConfigured is ever shown again. */
  function jevSave() {
    const v = (ui.draft.jev || "").trim();
    if (!v) ui.err.jev = "Paste an API key first.";
    else if (/\s/.test(v)) ui.err.jev = "An API key can’t contain spaces.";
    else if (v.length > 4096) ui.err.jev = "That key is too long.";
    else {
      delete ui.err.jev;
      ui.busy.jev = "Saving…";
      ui.pendingFk = "jev-replace";
      clearTest();
      api("/api/agent/jev/api-key", { apiKey: v })
        .then(applyKeyResult)
        .catch((err) => {
          ui.err.jev = err.message;
        })
        .finally(() => {
          delete ui.busy.jev;
          OVS.render(true);
          ui.pendingFk = null;
        });
    }
  }
  OVS.jevSave = jevSave;

  CHANGE["jev-provider"] = (t) => {
    const id = t.value,
      p = OVS.providerById(id);
    if (!id) return;
    OVS.saveAgents((a) => {
      const jev = { provider: id, modelId: null, thinking: null };
      /* A local provider takes no key: leave "Separate API key" so Jev isn't left waiting for one. */
      if (p && p.keyless && a.jev.credentials === "api-key") jev.credentials = "provider-login";
      return { jev };
    })
      .then((ok) => {
        if (!ok) return null;
        const m = S.provModels[id];
        return m && m.status === "ready" ? null : OVS.loadModels(id);
      })
      .then(() => {
        const m = S.provModels[id],
          j = S.agents.jev;
        if (!m || m.status !== "ready" || m.models.length === 0 || j.provider !== id || j.modelId)
          return null;
        const pick = m.models.find((x) => FAST_MODEL.test(x.modelId)) || m.models[0];
        return OVS.saveAgents({ jev: { provider: id, modelId: pick.modelId } });
      });
    clearTest();
  };
  CHANGE["jev-model"] = (t) => {
    const j = S.agents.jev,
      m = jevModels(j.provider),
      info = m && m.status === "ready" ? m.models.find((x) => x.modelId === t.value) : null;
    if (!info || t.value === j.modelId) return;
    /* An effort the new model doesn't accept is dropped (null = its default). */
    const drop = j.thinking && j.thinking !== "off" && !(info.efforts || []).includes(j.thinking);
    patchJev(
      Object.assign(
        { provider: j.provider, modelId: info.modelId },
        drop ? { thinking: null } : {},
      ),
    );
  };
  CHANGE["jev-thinking"] = (t) => patchJev({ thinking: t.value || null });

  OVS.ON_ENTER.jev = () => {
    if (!S.providers && !S.providersError) OVS.loadProviders();
    if (S.agents && S.agents.jev.provider) OVS.ensureModels(S.agents.jev.provider);
  };
})();
