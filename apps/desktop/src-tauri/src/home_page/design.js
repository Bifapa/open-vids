/* Projects page → Design systems (beta, behind OV.betaFeatures()). The library is ~/.openvids/design-systems, read
   through the home server: GET /api/design-systems → {systems: DesignSystemSummary[]}; PATCH /api/design-systems/:id
   {name}; DELETE (all with the token); the <img> loads the token-free GET /design-files/:id/thumbnail.svg. This file
   owns the section: the card grid, the states
   (loading, empty, error), keyboard roving, inline rename and the delete confirm. The view and Create dialogs and the
   New Project picker are in design-sheets.js, which adds itself to window.OVDesign; home.js hands over the recent
   projects and the open-project call (OVDesign.mount). A stable build gets inert hooks and draws nothing.
   Server text is escaped or validated before it reaches markup. */
(function () {
  "use strict";
  const inert = {
    mount() {},
    sync() {},
    pickerHtml: () => "",
    bindPicker: () => ({ id: () => null }),
    warning: () => "",
  };
  if (!OV.betaFeatures()) {
    window.OVDesign = inert;
    return;
  }
  const { ic, esc, api, describeError, fmtNumber } = OV;
  const { toast, showMenu, sheet } = OVH;
  const tr = (key, params) => OVI18N.t(key, params);
  const th = (key, params) => esc(OVI18N.t(key, params));
  /* packages/agent-protocol DESIGN_LIMITS.nameChars */
  const NAME_CHARS = 80;
  const SOURCE_KINDS = ["scratch", "project", "video", "website", "external_project"];
  const COLOR =
    /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([0-9a-z.%\s,/+-]{1,80}\))$/i;

  const D = {
    systems: [],
    phase: "loading",
    error: "",
    renaming: null,
    focus: null,
    hidden: false,
    bare: false,
  };
  let host = null,
    root = null,
    body = null,
    loadSeq = 0,
    renameBusy = false,
    skipView = null;
  const byId = (id) => D.systems.find((s) => s.id === id);

  /* ---------- data: what the server sent, checked before use ---------- */
  const str = (v) => (typeof v === "string" ? v : "");
  const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const safeColor = (v) => (typeof v === "string" && COLOR.test(v.trim()) ? v.trim() : null);
  /* Seconds or milliseconds: the page's other timestamps are seconds, the library's are whatever Date.now() gave. */
  const toMs = (n) => (n < 1e11 ? n * 1000 : n);
  function toSystem(r) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.name !== "string")
      return null;
    const src = r.source && typeof r.source === "object" ? r.source : {};
    return {
      id: r.id,
      name: r.name,
      version: Number.isInteger(r.version) && r.version > 0 ? r.version : 1,
      kind: str(src.kind),
      ref: str(src.ref),
      palette: strs(r.palette)
        .map((c) => safeColor(c))
        .filter(Boolean),
      displayFont: str(r.displayFont),
      unknownLicenses: strs(r.unknownLicenses),
      nonPortableFonts: strs(r.nonPortableFonts),
      updatedAt: typeof r.updatedAt === "number" ? toMs(r.updatedAt) : 0,
    };
  }
  const url = (id, tail) => "/api/design-systems/" + encodeURIComponent(id) + (tail || "");
  /* The token-free GETs an <img> / <iframe> can load (like /thumb/<file>): the thumbnail and the showcase page. */
  const fileUrl = (id, file) => "/design-files/" + encodeURIComponent(id) + "/" + file;
  /* A DesignError ({error: {code, message}}): the catalog's sentence for its code, else the server's own. */
  function designError(err) {
    const e = err && err.data && err.data.error;
    if (e && typeof e === "object" && typeof e.code === "string") {
      const key = "home.design.error.code." + e.code;
      const text = tr(key, { detail: str(e.message) });
      if (text !== key) return text;
    }
    return describeError(err) || tr("home.error.unknown");
  }
  const fail = (key, params) => (err) =>
    toast(th(key, Object.assign({ message: designError(err) }, params)), null, "error");

  function load(quiet) {
    const mine = ++loadSeq;
    if (!quiet) {
      D.phase = "loading";
      paint();
    }
    return api("/api/design-systems")
      .then((res) => {
        if (mine !== loadSeq) return;
        D.systems = (res && Array.isArray(res.systems) ? res.systems : [])
          .map(toSystem)
          .filter(Boolean);
        D.phase = "ready";
        paint();
      })
      .catch((err) => {
        if (mine !== loadSeq) return;
        if (quiet) return fail("home.design.error.load")(err);
        D.phase = "error";
        D.error = designError(err);
        paint();
      });
  }

  /* ---------- markup ---------- */
  const sourceLabel = (s) =>
    SOURCE_KINDS.includes(s.kind) ? tr("home.design.source." + s.kind) : "";
  const sourceTitle = (s) =>
    s.ref
      ? tr("home.design.source.withRef", { source: sourceLabel(s), ref: s.ref })
      : sourceLabel(s);
  const swatches = (palette, size) =>
    palette.length
      ? '<span class="ds-sw' +
        (size ? " " + size : "") +
        '" aria-hidden="true">' +
        palette.map((c) => '<i style="background:' + esc(c) + '"></i>').join("") +
        "</span>"
      : "";
  /* Names the license check lists: "font:Inter" → Inter, "logo" → the word for it. */
  const licenseItems = (s) =>
    s.unknownLicenses.map((n) =>
      n.startsWith("font:") ? n.slice(5) : n === "logo" ? tr("home.design.logo") : n,
    );
  /* The honest caveats of a system, as chips: an unknown license is checked before export; a system font is not
     stored with the system, so another computer may not have it. */
  function warnings(s) {
    const out = [];
    if (s.unknownLicenses.length)
      out.push({
        label: tr("home.design.warn.license"),
        tip: tr("home.design.warn.license.tip", { items: licenseItems(s).join(", ") }),
      });
    if (s.nonPortableFonts.length)
      out.push({
        label: tr("home.design.warn.system"),
        tip: tr("home.design.warn.system.tip", { fonts: s.nonPortableFonts.join(", ") }),
      });
    return out;
  }
  const nameHtml = (s) =>
    D.renaming === s.id
      ? '<input class="rename-input" data-ds-rename value="' +
        esc(s.name) +
        '" maxlength="' +
        NAME_CHARS +
        '" aria-label="' +
        th("home.design.renameLabel") +
        '" spellcheck="false" />'
      : esc(s.name);
  function cardHtml(s, tab) {
    const warns = warnings(s),
      src = sourceLabel(s);
    const label = [tr("home.design.card.aria", { name: s.name, version: s.version })]
      .concat(
        src ? [src] : [],
        warns.map((w) => w.label),
      )
      .join(", ");
    return (
      '<div class="card sel-item ds-card" role="listitem" tabindex="' +
      tab +
      '" data-ds data-id="' +
      esc(s.id) +
      '" aria-label="' +
      esc(label) +
      '"><div class="thumb"><img src="' +
      esc(fileUrl(s.id, "thumbnail.svg") + "?v=" + s.version + "-" + s.updatedAt) +
      '" alt="" loading="lazy" draggable="false" /><span class="thumb-dur">' +
      th("home.design.version", { version: s.version }) +
      '</span><button class="thumb-more" type="button" tabindex="-1" data-more aria-label="' +
      th("home.item.moreActions", { name: s.name }) +
      '" aria-haspopup="menu">' +
      ic("ellipsis", 14) +
      '</button></div><div class="card-text"><div class="name" title="' +
      esc(s.name) +
      '">' +
      nameHtml(s) +
      '</div><div class="meta">' +
      swatches(s.palette) +
      (s.displayFont
        ? '<span class="ds-font" title="' +
          esc(s.displayFont) +
          '">' +
          esc(s.displayFont) +
          "</span>"
        : "") +
      '</div><div class="ds-tags">' +
      (src
        ? '<span class="badge sm" title="' + esc(sourceTitle(s)) + '">' + esc(src) + "</span>"
        : "") +
      warns
        .map(
          (w) =>
            '<span class="badge sm warning" title="' +
            esc(w.tip) +
            '">' +
            ic("alert", 10) +
            esc(w.label) +
            "</span>",
        )
        .join("") +
      "</div></div></div>"
    );
  }
  const skeletonHtml = () =>
    '<div class="ds-grid" aria-busy="true"><p class="sr-only" role="status">' +
    th("home.design.loading") +
    "</p>" +
    [0, 1, 2]
      .map(
        (i) =>
          '<div class="card sel-item is-loading" aria-hidden="true"><div class="thumb"><span class="sk" style="width:100%;height:100%;animation-delay:' +
          i * 90 +
          'ms"></span></div><div class="card-text" style="gap:5px;padding-top:2px"><span class="sk" style="height:10px;width:' +
          (48 + ((i * 17) % 40)) +
          '%"></span><span class="sk" style="height:8px;width:' +
          (30 + ((i * 11) % 22)) +
          '%"></span></div></div>',
      )
      .join("") +
    "</div>";
  const emptyHtml = (tone, icon, title, text, action) =>
    '<div class="empty inline' +
    tone +
    '"><div class="empty-mark">' +
    ic(icon) +
    "</div><h2>" +
    title +
    "</h2><p>" +
    text +
    "</p>" +
    (action ? '<div class="empty-actions">' + action + "</div>" : "") +
    "</div>";

  /* Hidden while Recent is searched, and while there is nothing to show on a page with no projects. */
  function applyHidden() {
    if (!root) return;
    root.hidden = D.hidden || (D.bare && !(D.phase === "ready" && D.systems.length));
  }
  function paint() {
    if (!root) return;
    const ready = D.phase === "ready";
    applyHidden();
    root.querySelector("#dsTitle").innerHTML =
      th("home.design.title") +
      (ready && D.systems.length
        ? '<span class="count num">' + esc(fmtNumber(D.systems.length)) + "</span>"
        : "");
    const create = root.querySelector("#dsCreate");
    create.innerHTML = ic("plus", 12) + th("home.design.create");
    create.setAttribute("aria-label", tr("home.design.createAria"));
    if (D.phase === "loading") body.innerHTML = skeletonHtml();
    else if (D.phase === "error")
      body.innerHTML = emptyHtml(
        " is-error",
        "alert",
        th("home.design.error.title"),
        esc(D.error),
        '<button class="btn" type="button" data-ds-retry>' + th("common.retry") + "</button>",
      );
    else if (!D.systems.length)
      body.innerHTML = emptyHtml(
        "",
        "shapes",
        th("home.design.empty.title"),
        th("home.design.empty.body"),
        "",
      );
    else {
      if (!byId(D.focus)) D.focus = D.systems[0].id;
      body.innerHTML =
        '<div class="ds-grid" role="list" aria-label="' +
        th("home.design.title") +
        '">' +
        D.systems.map((s) => cardHtml(s, s.id === D.focus ? 0 : -1)).join("") +
        "</div>";
    }
  }
  const cards = () => [...root.querySelectorAll("[data-ds]")];
  const cardEl = (id) => cards().find((c) => c.dataset.id === id) || null;
  function focusCard(id) {
    const all = cards(),
      el = all.find((c) => c.dataset.id === id) || all[0];
    if (!el) return root.querySelector("#dsCreate").focus();
    all.forEach((c) => {
      c.tabIndex = c === el ? 0 : -1;
    });
    D.focus = el.dataset.id;
    el.focus();
  }
  /* The card the arrow key leads to: sideways in reading order, up and down to the nearest card of the next row. */
  function neighbour(list, i, key) {
    if (key === "ArrowRight") return list[i + 1];
    if (key === "ArrowLeft") return list[i - 1];
    if (key === "Home") return list[0];
    if (key === "End") return list[list.length - 1];
    const r = list[i].getBoundingClientRect(),
      dir = key === "ArrowDown" ? 1 : -1,
      cx = r.left + r.width / 2;
    let best = null,
      bestScore = Infinity;
    for (const c of list) {
      const b = c.getBoundingClientRect(),
        dy = (b.top - r.top) * dir;
      if (dy <= 4) continue;
      const score = dy * 1000 + Math.abs(b.left + b.width / 2 - cx);
      if (score < bestScore) {
        best = c;
        bestScore = score;
      }
    }
    return best;
  }

  /* ---------- rename: inline, as a project's ---------- */
  function startRename(id) {
    D.renaming = id;
    paint();
    const inp = root.querySelector("[data-ds-rename]");
    if (!inp) return;
    inp.focus();
    inp.select();
  }
  function commitRename(save) {
    if (!D.renaming || renameBusy) return;
    const s = byId(D.renaming),
      inp = root.querySelector("[data-ds-rename]"),
      next = inp ? inp.value.trim() : "";
    D.renaming = null;
    if (!s || save === false || !next || next === s.name) {
      paint();
      if (s) focusCard(s.id);
      return;
    }
    renameBusy = true;
    const old = s.name;
    s.name = next;
    paint();
    focusCard(s.id);
    api(url(s.id), { name: next }, "PATCH")
      .then(() => load(true))
      .then(() => focusCard(s.id))
      .catch((err) => {
        s.name = old;
        paint();
        focusCard(s.id);
        fail("home.design.error.rename", { name: old })(err);
      })
      .finally(() => {
        renameBusy = false;
      });
  }

  /* ---------- delete: confirmed; projects that use a system keep their own copy ---------- */
  function confirmDelete(s) {
    const { sh, close } = sheet(
      "<h3>" +
        th("home.design.delete.title", { name: s.name }) +
        "</h3><p>" +
        th("home.design.delete.body") +
        "</p><p>" +
        th("home.design.delete.hint") +
        '</p><div class="sheet-actions"><button class="btn" type="button" data-cancel>' +
        th("common.cancel") +
        '</button><button class="btn btn-danger" type="button" id="dsDelOk">' +
        th("common.delete") +
        "</button></div>",
      { role: "alertdialog" },
    );
    sh.querySelector("#dsDelOk").onclick = () => {
      close();
      doDelete(s);
    };
    sh.querySelector("[data-cancel]").focus();
  }
  function doDelete(s) {
    const i = D.systems.indexOf(s),
      next = D.systems[i + 1] || D.systems[i - 1];
    api(url(s.id), undefined, "DELETE")
      .then(() => {
        D.systems = D.systems.filter((x) => x.id !== s.id);
        paint();
        focusCard(next ? next.id : null);
        toast(th("home.design.toast.deleted", { name: s.name }));
      })
      .catch(fail("home.design.error.delete", { name: s.name }));
  }

  /* ---------- the section: menu, keys, clicks, mounting ---------- */
  function menuFor(s, x, y, btn) {
    showMenu(
      [
        {
          label: th("home.design.menu.view"),
          icon: "eye",
          kbd: "↵",
          act: () => window.OVDesign.view(s),
        },
        { label: th("home.item.rename"), icon: "pencil", kbd: "F2", act: () => startRename(s.id) },
        { sep: 1 },
        {
          label: th("home.design.menu.delete"),
          icon: "trash",
          kbd: OV.shortcutKey("⌘⌫"),
          danger: 1,
          act: () => confirmDelete(s),
        },
      ],
      x,
      y,
      cardEl(s.id),
      btn,
    );
  }
  function onKey(e) {
    if (e.target.matches("[data-ds-rename]")) {
      if (e.key === "Enter") {
        e.preventDefault();
        commitRename();
      } else if (e.key === "Escape") commitRename(false);
      e.stopPropagation();
      return;
    }
    const el = e.target.closest("[data-ds]");
    if (!el || e.target.closest("button")) return;
    const s = byId(el.dataset.id),
      mod = e.metaKey || e.ctrlKey;
    if (!s) return;
    if (e.key === "Enter") window.OVDesign.view(s);
    else if (e.key === "F2") startRename(s.id);
    else if ((mod && e.key === "Backspace") || e.key === "Delete") confirmDelete(s);
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      const r = el.getBoundingClientRect();
      menuFor(s, r.left + 24, r.top + 48);
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      const list = cards(),
        to = neighbour(list, list.indexOf(el), e.key);
      if (to) focusCard(to.dataset.id);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }
  function onClick(e) {
    if (e.target.closest("#dsCreate")) return window.OVDesign.create();
    if (e.target.closest("[data-ds-retry]")) return void load();
    const el = e.target.closest("[data-ds]");
    if (!el || e.target.closest("[data-ds-rename]")) return;
    const s = byId(el.dataset.id),
      skip = skipView;
    skipView = null;
    if (!s) return;
    const more = e.target.closest("[data-more]");
    if (more) {
      const r = more.getBoundingClientRect();
      return menuFor(s, r.left, r.bottom + 4, more);
    }
    if (skip !== s.id) window.OVDesign.view(s);
  }
  function mount(h) {
    if (root) return;
    host = h;
    root = document.createElement("section");
    root.className = "ds";
    root.id = "designs";
    root.hidden = true;
    root.setAttribute("aria-labelledby", "dsTitle");
    root.innerHTML =
      '<div class="lo-head"><h2 class="sect-label" id="dsTitle"></h2><button class="btn btn-ghost btn-sm" id="dsCreate" type="button"></button></div><div id="dsBody"></div>';
    body = root.querySelector("#dsBody");
    host.recent.before(root);
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKey);
    root.addEventListener("contextmenu", (e) => {
      const el = e.target.closest("[data-ds]"),
        s = el && byId(el.dataset.id);
      if (!s || e.target.closest("[data-ds-rename]")) return;
      e.preventDefault();
      menuFor(s, e.clientX, e.clientY);
    });
    root.addEventListener("focusin", (e) => {
      const el = e.target.closest("[data-ds]");
      if (!el) return;
      D.focus = el.dataset.id;
      cards().forEach((c) => {
        c.tabIndex = c === el ? 0 : -1;
      });
    });
    root.addEventListener("focusout", (e) => {
      if (e.target.matches && e.target.matches("[data-ds-rename]"))
        setTimeout(() => commitRename(), 0);
    });
    /* A thumbnail that can't load gives way to the page's own blank frame. */
    root.addEventListener(
      "error",
      (e) => {
        if (e.target.tagName !== "IMG" || !e.target.closest(".ds-card .thumb")) return;
        e.target.insertAdjacentHTML("afterend", OV.blankThumb());
        e.target.remove();
      },
      true,
    );
    /* Clicking anywhere else in the page commits an open rename before the click acts. */
    host.main.addEventListener(
      "click",
      (e) => {
        skipView = null;
        if (D.renaming && !e.target.closest("[data-ds-rename]")) {
          skipView = D.renaming;
          commitRename();
        }
      },
      true,
    );
    window.addEventListener("ov-language", paint);
    paint();
    load();
  }
  /* home.js: Recent is searched (the section steps aside) or empty (no projects to work in: only systems show). */
  function sync(state) {
    D.hidden = !!state.hidden;
    D.bare = !!state.bare;
    applyHidden();
  }
  /* What design-sheets.js builds on; not for the page. */
  const kit = {
    tr,
    th,
    url,
    fileUrl,
    designError,
    swatches,
    warnings,
    sourceLabel,
    systems: () => D.systems,
    ready: () => D.phase === "ready",
    projects: () => host.projects(),
    open: (p, extra) => host.open(p, extra),
  };
  window.OVDesign = { mount, sync, kit };
})();
