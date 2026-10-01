/* Settings → Asset Search: the global policy in ~/.openvids/research/policy.json, the same routes Studio uses:
   GET/PUT /api/research/policy {mode?, websites?: {readLinkedPages}}, POST /api/research/sources {name, domains},
   PATCH/DELETE /api/research/sources/:id {enabled}, POST /api/research/sources/restore. Every success answers the
   whole policy; the server validates (a refused source comes back as {error:{message}}, shown at the field).
   Source names, domains and license notes are user- or server-supplied text: always escaped. */
(function () {
  "use strict";
  const { ic, esc, api, S, ui, PAGES, CLICK, INPUT, ENTER, row, group, sw, head, lede } = OVS;

  const KIND_LABELS = { video: "Video", picture: "Pictures", audio: "Audio" };
  /* packages/agent-protocol RESEARCH_LIMITS.nameChars */
  const NAME_CHARS = 80;
  const MODES = [
    [
      "trusted",
      "shield",
      "Trusted sources only",
      "Search only the sources below. Each one notes its license terms.",
    ],
    [
      "any",
      "globe",
      "Any source",
      "Search the web. Check each asset’s license before you publish.",
    ],
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
        S.policyError = err.message;
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
          if (!inline) S.policyNote = "!Couldn’t save: " + err.message;
          return err.message;
        })
        .finally(() => OVS.render(true)),
    );
    return queue;
  }
  function addSource() {
    const raw = (ui.draft.source || "").trim();
    if (!raw) {
      ui.err.source = "Enter a site address.";
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
    const kinds = s.kinds.map((k) => KIND_LABELS[k] || k).join(" · ");
    const domains = s.domains.join(", ");
    return `<div class="st-row st-src${s.enabled ? "" : " is-off"}" data-source="${esc(s.id)}">${sw(
      s.enabled,
      "source-on",
      "Use " + s.name,
      s.id,
    )}<div class="st-label"><b>${esc(s.name)}${
      s.builtIn ? "" : '<span class="badge sm">Custom</span>'
    }</b><span><span class="mono" title="${esc(domains)}">${esc(domains)}</span></span>${
      s.licenseNote ? `<span>${esc(s.licenseNote)}</span>` : ""
    }</div><span class="lic">${esc(kinds)}</span><button type="button" class="icon-btn" aria-label="Remove ${esc(
      s.name,
    )}" data-tip="Remove" data-tip-align="end" data-act="source-remove" data-key="${esc(s.id)}" data-fk="remove:${esc(
      s.id,
    )}">${ic("trash")}</button></div>`;
  }

  PAGES.assets = function () {
    const intro = lede(
      "Applies to all projects. Only the Research agent searches outside a project, and only as allowed here.",
    );
    const p = S.policy;
    if (!p)
      return (
        head("Asset Search") +
        intro +
        (S.policyError
          ? OVS.failure("Couldn’t load Asset Search settings", S.policyError, "policy-retry")
          : OVS.loading("Asset Search settings"))
      );
    const onCount = p.sources.filter((s) => s.enabled).length;
    const modes = `<div class="st-choice" role="radiogroup" aria-label="Search mode">${MODES.map(
      (m) =>
        `<button type="button" class="st-radio" role="radio" aria-checked="${p.mode === m[0]}" data-act="asset-mode" data-v="${m[0]}" data-fk="mode:${m[0]}"><span class="st-label"><b>${ic(
          m[1],
        )}${m[2]}</b><span>${m[3]}</span></span></button>`,
    ).join("")}</div>`;
    const err = ui.err.source;
    const add = `<div class="st-add"><div class="st-inline"><input class="input mono${err ? " is-invalid" : ""}" type="text" spellcheck="false" autocomplete="off" placeholder="Add a site, e.g. archive.org" aria-label="Add a custom source" data-act="source-input" data-draft="source" data-fk="source-input"${
      err ? ' aria-invalid="true" aria-describedby="err-source"' : ""
    } /><button type="button" class="btn" data-act="source-add" data-fk="source-add"${
      ui.busy.source ? " disabled" : ""
    }>${ic("plus")}Add</button></div>${
      err ? `<p class="st-field-err" id="err-source" role="alert">${esc(err)}</p>` : ""
    }</div>`;
    const searchNote =
      p.mode === "trusted"
        ? onCount
          ? "Only these are searched"
          : ""
        : "Searched first, then the rest of the web";
    const removed = p.removedBuiltIns.length;
    const meta = `<span class="note">${onCount} of ${p.sources.length} on${
      searchNote ? " · " + searchNote : ""
    }</span>${
      removed
        ? `<button type="button" class="link push" data-act="source-restore" data-fk="source-restore">Restore built-in sources (${removed})</button>`
        : ""
    }`;
    const list = p.sources.length
      ? p.sources.map(sourceRow).join("")
      : `<div class="st-row"><div class="st-label"><span>No trusted sources. Add a site below${
          removed ? ", or restore the built-in sources" : ""
        }.</span></div></div>`;
    const empty =
      p.mode === "trusted" && !onCount
        ? `<p class="st-foot"><span class="status warning">${ic("alert")}All sources are off, so asset search will find nothing.</span></p>`
        : "";
    const readLinked = p.websites.readLinkedPages;
    return (
      head("Asset Search") +
      intro +
      OVS.noteHtml(S.policyNote) +
      group("Search mode", modes) +
      `<section class="st-group"><div class="sect-label"><span>Trusted sources</span>${meta}</div><div class="st-box">${list}${add}</div>${empty}</section>` +
      group(
        "Websites",
        row(
          "Open links you send in chat",
          "Agents can read the pages you link — colors, fonts, logo, screenshots — to match a site’s style. Only links from your own messages, plus other pages on the same site.",
          sw(readLinked, "read-linked", "Open links you send in chat"),
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
