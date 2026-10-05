/* Settings → Asset Search: the global policy in ~/.openvids/research/policy.json, the same routes Studio uses:
   GET/PUT /api/research/policy {mode?, websites?: {readLinkedPages?, fullAccess?}}, POST /api/research/sources {name, domains},
   PATCH/DELETE /api/research/sources/:id {enabled}, POST /api/research/sources/restore. Every success answers the
   whole policy; the server validates (a refused source comes back as {error:{message}}, shown at the field).
   PUT/DELETE /api/research/sources/:id/api-key {key} saves or forgets the user's own key of a source that has an
   `apiKey` (the policy only ever says whether one is `configured`; a key is never drawn into the markup).
   Source names, domains and license notes are user- or server-supplied text: always escaped. */
(function () {
  "use strict";
  const { ic, esc, api, S, ui, PAGES, CLICK, INPUT, ENTER, tr, msg, text, row, group } = OVS;
  const { sw, head, lede } = OVS;
  /* Escaped text of a catalog message, for the helpers that take markup. */
  const te = (key, params) => esc(tr(key, params));

  /* A kind this page doesn't know is shown as the server names it. */
  const KIND_KEYS = {
    video: "settings.assets.kind.video",
    picture: "settings.assets.kind.picture",
    audio: "settings.assets.kind.audio",
  };
  /* packages/agent-protocol RESEARCH_LIMITS.nameChars */
  const NAME_CHARS = 80;
  /* [mode, icon, title key, hint key] */
  const MODES = [
    ["trusted", "shield", "settings.assets.mode.trusted", "settings.assets.mode.trusted.hint"],
    ["any", "globe", "settings.assets.mode.any", "settings.assets.mode.any.hint"],
  ];

  const sourcesUrl = (id) => "/api/research/sources/" + encodeURIComponent(id);
  /* "https://www.Archive.org/x" → "archive.org" (display name only; the server normalizes the real domain). */
  const normDomain = (v) =>
    v
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/^www\./, "")
      .replace(/[/?#].*$/, "");

  /* ---------- data ---------- */
  function loadPolicy() {
    if (ui.flags.policyLoading) return;
    ui.flags.policyLoading = true;
    S.policyError = null;
    api("/api/research/policy")
      .then((p) => {
        S.policy = p;
      })
      .catch((err) => {
        S.policyError = OV.describeError(err);
      })
      .finally(() => {
        ui.flags.policyLoading = false;
        OVS.render(true);
      });
  }
  /* Changes are queued: each one answers with the whole policy, and the last answer wins in order.
     Resolves to the server's refusal (or null when it accepted the change). */
  let queue = Promise.resolve(null);
  function policyOp(request, inline) {
    queue = queue.then(() =>
      request()
        .then((policy) => {
          S.policy = policy;
          S.policyNote = "";
          return null;
        })
        .catch((err) => {
          if (!inline)
            S.policyNote = OVS.failMsg("settings.note.saveFailed", {
              message: OV.describeError(err),
            });
          return OV.describeError(err);
        })
        .finally(() => OVS.render(true)),
    );
    return queue;
  }
  function addSource() {
    const raw = (ui.draft.source || "").trim();
    if (!raw) {
      ui.err.source = msg("settings.assets.error.enterSite");
      return;
    }
    if (ui.busy.source) return;
    const domains = [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
    const name = (normDomain(domains[0]) || domains[0]).slice(0, NAME_CHARS);
    delete ui.err.source;
    ui.busy.source = true;
    ui.pendingFk = "source-input";
    policyOp(() => api("/api/research/sources", { name, domains }), true).then((refusal) => {
      delete ui.busy.source;
      if (refusal) ui.err.source = refusal;
      else ui.draft.source = "";
      OVS.render(true);
    });
  }

  /* ---------- markup ---------- */
  /* The key line of a source that needs the user's own API key: the note and the field while there is none,
     "Key saved" with Replace / Remove once there is. Drafts, errors and busy flags live under `srckey:<id>`. */
  function keyBlock(s) {
    const id = esc(s.id),
      k = `srckey:${s.id}`,
      busy = !!ui.busy[k],
      err = ui.err[k],
      configured = s.apiKey.configured,
      replacing = configured && !!ui.flags[`replace:${s.id}`];
    const link = (act, label, aria) =>
      `<button type="button" class="link" data-act="${act}" data-v="${id}" data-fk="${act}:${id}"${
        aria ? ` aria-label="${esc(aria)}"` : ""
      }${busy ? " disabled" : ""}>${label}</button>`;
    const line = configured
      ? `<span class="status success">${ic("check")}${te("settings.assets.key.saved")}</span>${
          replacing
            ? ""
            : link(
                "srckey-replace",
                te("settings.assets.key.replace"),
                tr("settings.assets.key.replaceAria", { name: s.name }),
              ) +
              link(
                "srckey-remove",
                te("common.remove"),
                tr("settings.assets.key.removeAria", { name: s.name }),
              )
        }`
      : `${ic("key")}<span>${te("settings.assets.key.needs")}</span>${link(
          "srckey-get",
          te("settings.assets.key.get"),
        )}`;
    const form =
      !configured || replacing
        ? `<div class="st-inline"><input class="input mono${err ? " is-invalid" : ""}" type="password" autocomplete="off" spellcheck="false" placeholder="${te(
            "settings.assets.key.placeholder",
          )}" aria-label="${te("settings.assets.key.aria", {
            name: s.name,
          })}" data-act="srckey-input" data-v="${id}" data-draft="${esc(k)}" data-fk="srckey-input:${id}"${
            busy ? " readonly" : ""
          }${
            err ? ` aria-invalid="true" aria-describedby="err-${esc(k)}"` : ""
          } /><button type="button" class="btn" data-act="srckey-save" data-v="${id}" data-fk="srckey-save:${id}"${
            busy ? ' disabled aria-busy="true"' : ""
          }>${busy ? '<i class="spinner" aria-hidden="true"></i>' : ""}${te("common.save")}</button>${
            replacing
              ? `<button type="button" class="btn btn-ghost" data-act="srckey-cancel" data-v="${id}" data-fk="srckey-cancel:${id}"${
                  busy ? " disabled" : ""
                }>${te("common.cancel")}</button>`
              : ""
          }</div>`
        : "";
    return `<div class="st-src-key" data-key-for="${id}"><p class="st-src-key-line">${line}</p>${form}${
      err ? `<p class="st-field-err" id="err-${esc(k)}" role="alert">${esc(text(err))}</p>` : ""
    }</div>`;
  }
  function sourceRow(s) {
    const kinds = s.kinds.map((k) => (KIND_KEYS[k] ? tr(KIND_KEYS[k]) : k)).join(" · ");
    const domains = s.domains.join(", ");
    /* An enabled source with no key searches nothing yet: shown as off, with the reason beside its name. */
    const needsKey = !!s.apiKey && !s.apiKey.configured;
    const badge = !s.builtIn
      ? `<span class="badge sm">${te("settings.assets.custom")}</span>`
      : s.enabled && needsKey
        ? `<span class="badge sm is-quiet">${te("settings.assets.key.badge")}</span>`
        : "";
    return `<div class="st-row st-src${s.enabled && !needsKey ? "" : " is-off"}" data-source="${esc(s.id)}">${sw(
      s.enabled,
      "source-on",
      tr("settings.assets.useSource", { name: s.name }),
      s.id,
    )}<div class="st-label"><b>${esc(s.name)}${badge}</b><span><span class="mono" title="${esc(domains)}">${esc(domains)}</span></span>${
      s.licenseNote ? `<span>${esc(s.licenseNote)}</span>` : ""
    }</div><span class="lic">${esc(kinds)}</span><button type="button" class="icon-btn" aria-label="${te(
      "settings.assets.removeSource",
      { name: s.name },
    )}" data-tip="${te("common.remove")}" data-tip-align="end" data-act="source-remove" data-key="${esc(s.id)}" data-fk="remove:${esc(
      s.id,
    )}">${ic("trash")}</button>${s.apiKey ? keyBlock(s) : ""}</div>`;
  }

  PAGES.assets = function () {
    const intro = lede("settings.assets.lede");
    const title = tr("settings.section.assets");
    const p = S.policy;
    if (!p)
      return (
        head(title) +
        intro +
        (S.policyError
          ? OVS.failure("settings.failure.assets", S.policyError, "policy-retry")
          : OVS.loading("settings.loading.assets"))
      );
    const onCount = p.sources.filter((s) => s.enabled).length;
    const modes = `<div class="st-choice" role="radiogroup" aria-label="${te("settings.assets.mode.aria")}">${MODES.map(
      (m) =>
        `<button type="button" class="st-radio" role="radio" aria-checked="${p.mode === m[0]}" data-act="asset-mode" data-v="${m[0]}" data-fk="mode:${m[0]}"><span class="st-label"><b>${ic(
          m[1],
        )}${te(m[2])}</b><span>${te(m[3])}</span></span></button>`,
    ).join("")}</div>`;
    const err = ui.err.source;
    const add = `<div class="st-add"><div class="st-inline"><input class="input mono${err ? " is-invalid" : ""}" type="text" spellcheck="false" autocomplete="off" placeholder="${te("settings.assets.add.placeholder")}" aria-label="${te("settings.assets.add.aria")}" data-act="source-input" data-draft="source" data-fk="source-input"${
      err ? ' aria-invalid="true" aria-describedby="err-source"' : ""
    } /><button type="button" class="btn" data-act="source-add" data-fk="source-add"${
      ui.busy.source ? " disabled" : ""
    }>${ic("plus")}${te("settings.assets.add")}</button></div>${
      err ? `<p class="st-field-err" id="err-source" role="alert">${esc(text(err))}</p>` : ""
    }</div>`;
    const removed = p.removedBuiltIns.length;
    const meta = `<span class="note">${te(
      p.mode === "trusted"
        ? onCount
          ? "settings.assets.meta.trusted"
          : "settings.assets.meta"
        : "settings.assets.meta.any",
      { on: onCount, total: p.sources.length },
    )}</span>${
      removed
        ? `<button type="button" class="link push" data-act="source-restore" data-fk="source-restore">${te("settings.assets.restore", { count: removed })}</button>`
        : ""
    }`;
    const list = p.sources.length
      ? p.sources.map(sourceRow).join("")
      : `<div class="st-row"><div class="st-label"><span>${te(
          removed ? "settings.assets.empty.restore" : "settings.assets.empty",
        )}</span></div></div>`;
    const empty =
      p.mode === "trusted" && !onCount
        ? `<p class="st-foot"><span class="status warning">${ic("alert")}${te("settings.assets.allOff")}</span></p>`
        : "";
    const keysFoot = p.sources.some((s) => s.apiKey)
      ? `<p class="st-foot">${te("settings.assets.keysFoot")}</p>`
      : "";
    const readLinked = p.websites.readLinkedPages;
    const fullAccess = readLinked && p.websites.fullAccess;
    return (
      head(title) +
      intro +
      OVS.noteHtml(S.policyNote) +
      group(te("settings.assets.group.mode"), modes) +
      `<section class="st-group"><div class="sect-label"><span>${te("settings.assets.group.sources")}</span>${meta}</div><div class="st-box">${list}${add}</div>${keysFoot}${empty}</section>` +
      group(
        te("settings.assets.group.websites"),
        row(
          te("settings.assets.readLinked"),
          te("settings.assets.readLinked.hint"),
          sw(readLinked, "read-linked", tr("settings.assets.readLinked")),
        ) +
          row(
            te("settings.assets.fullAccess"),
            te("settings.assets.fullAccess.hint"),
            sw(fullAccess, "full-access", tr("settings.assets.fullAccess"), "", !readLinked),
            readLinked ? "" : "is-disabled",
          ),
      )
    );
  };

  /* ---------- actions ---------- */
  CLICK["policy-retry"] = () => loadPolicy();
  CLICK["asset-mode"] = (t) => {
    const mode = t.dataset.v;
    if (S.policy && S.policy.mode !== mode)
      policyOp(() => api("/api/research/policy", { mode }, "PUT"));
  };
  CLICK["source-on"] = (t) => {
    const id = t.dataset.key,
      s = S.policy && S.policy.sources.find((x) => x.id === id);
    if (s) policyOp(() => api(sourcesUrl(id), { enabled: !s.enabled }, "PATCH"));
  };
  CLICK["source-remove"] = (t) => {
    const id = t.dataset.key;
    ui.pendingFk = "source-input";
    policyOp(() => api(sourcesUrl(id), undefined, "DELETE")).then(() => {
      ui.pendingFk = null;
    });
  };
  CLICK["source-restore"] = () =>
    policyOp(() => api("/api/research/sources/restore", undefined, "POST"));
  CLICK["source-add"] = () => addSource();
  /* ---- the user's own API key of a source that needs one ---- */
  /* Saves the pasted key; on success the field gives way to "Key saved", on a refusal it stays with the reason. */
  function saveKey(id) {
    const k = `srckey:${id}`,
      key = (ui.draft[k] || "").trim();
    if (ui.busy[k]) return;
    if (!key) {
      ui.err[k] = msg("settings.key.error.empty");
      return;
    }
    delete ui.err[k];
    ui.busy[k] = true;
    policyOp(() => api(sourcesUrl(id) + "/api-key", { key }, "PUT"), true).then((refusal) => {
      delete ui.busy[k];
      if (refusal) ui.err[k] = refusal;
      else {
        delete ui.draft[k];
        delete ui.flags[`replace:${id}`];
      }
      ui.pendingFk = refusal ? `srckey-input:${id}` : `srckey-replace:${id}`;
      OVS.render(true);
      ui.pendingFk = null;
    });
  }
  CLICK["srckey-save"] = (t) => saveKey(t.dataset.v);
  CLICK["srckey-replace"] = (t) => {
    ui.flags[`replace:${t.dataset.v}`] = true;
    ui.pendingFk = `srckey-input:${t.dataset.v}`;
  };
  CLICK["srckey-cancel"] = (t) => {
    const id = t.dataset.v;
    delete ui.flags[`replace:${id}`];
    delete ui.draft[`srckey:${id}`];
    delete ui.err[`srckey:${id}`];
    ui.pendingFk = `srckey-replace:${id}`;
  };
  CLICK["srckey-remove"] = (t) => {
    const id = t.dataset.v,
      k = `srckey:${id}`;
    if (ui.busy[k]) return;
    delete ui.err[k];
    ui.busy[k] = true;
    policyOp(() => api(sourcesUrl(id) + "/api-key", undefined, "DELETE"), true).then((refusal) => {
      delete ui.busy[k];
      if (refusal) ui.err[k] = refusal;
      ui.pendingFk = refusal ? `srckey-remove:${id}` : `srckey-input:${id}`;
      OVS.render(true);
      ui.pendingFk = null;
    });
  };
  /* The sign-up page opens in the default browser through the shell, which only opens https addresses. */
  CLICK["srckey-get"] = (t) => {
    const s = S.policy && S.policy.sources.find((x) => x.id === t.dataset.v);
    if (s && s.apiKey) api("/api/open-external", { url: s.apiKey.signupUrl }).catch(() => {});
  };
  CLICK["read-linked"] = () => {
    if (S.policy)
      policyOp(() =>
        api(
          "/api/research/policy",
          { websites: { readLinkedPages: !S.policy.websites.readLinkedPages } },
          "PUT",
        ),
      );
  };
  CLICK["full-access"] = () => {
    if (S.policy && S.policy.websites.readLinkedPages)
      policyOp(() =>
        api(
          "/api/research/policy",
          { websites: { fullAccess: !S.policy.websites.fullAccess } },
          "PUT",
        ),
      );
  };
  INPUT["source-input"] = (t) => {
    ui.draft.source = t.value;
    if (ui.err.source) {
      delete ui.err.source;
      OVS.render(true);
    }
  };
  ENTER["source-input"] = () => {
    addSource();
    OVS.render(true);
  };
  INPUT["srckey-input"] = (t) => {
    const k = `srckey:${t.dataset.v}`;
    ui.draft[k] = t.value;
    if (ui.err[k]) {
      delete ui.err[k];
      OVS.render(true);
    }
  };
  ENTER["srckey-input"] = (t) => {
    saveKey(t.dataset.v);
    OVS.render(true);
  };

  OVS.ON_ENTER.assets = () => {
    if (!S.policy) loadPolicy();
  };
})();
