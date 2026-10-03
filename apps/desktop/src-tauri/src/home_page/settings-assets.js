/* Settings → Asset Search: the global policy in ~/.openvids/research/policy.json, the same routes Studio uses:
   GET/PUT /api/research/policy {mode?, websites?: {readLinkedPages?, fullAccess?}}, POST /api/research/sources {name, domains},
   PATCH/DELETE /api/research/sources/:id {enabled}, POST /api/research/sources/restore. Every success answers the
   whole policy; the server validates (a refused source comes back as {error:{message}}, shown at the field).
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
  function sourceRow(s) {
    const kinds = s.kinds.map((k) => (KIND_KEYS[k] ? tr(KIND_KEYS[k]) : k)).join(" · ");
    const domains = s.domains.join(", ");
    return `<div class="st-row st-src${s.enabled ? "" : " is-off"}" data-source="${esc(s.id)}">${sw(
      s.enabled,
      "source-on",
      tr("settings.assets.useSource", { name: s.name }),
      s.id,
    )}<div class="st-label"><b>${esc(s.name)}${
      s.builtIn ? "" : `<span class="badge sm">${te("settings.assets.custom")}</span>`
    }</b><span><span class="mono" title="${esc(domains)}">${esc(domains)}</span></span>${
      s.licenseNote ? `<span>${esc(s.licenseNote)}</span>` : ""
    }</div><span class="lic">${esc(kinds)}</span><button type="button" class="icon-btn" aria-label="${te(
      "settings.assets.removeSource",
      { name: s.name },
    )}" data-tip="${te("common.remove")}" data-tip-align="end" data-act="source-remove" data-key="${esc(s.id)}" data-fk="remove:${esc(
      s.id,
    )}">${ic("trash")}</button></div>`;
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
    const readLinked = p.websites.readLinkedPages;
    const fullAccess = readLinked && p.websites.fullAccess;
    return (
      head(title) +
      intro +
      OVS.noteHtml(S.policyNote) +
      group(te("settings.assets.group.mode"), modes) +
      `<section class="st-group"><div class="sect-label"><span>${te("settings.assets.group.sources")}</span>${meta}</div><div class="st-box">${list}${add}</div>${empty}</section>` +
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

  OVS.ON_ENTER.assets = () => {
    if (!S.policy) loadPolicy();
  };
})();
