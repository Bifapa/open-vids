/* Design systems: the dialogs of the Projects page's section (design.js) and the New Project picker.
   view     — a large sheet: the system's own showcase (the token-free GET /design-files/:id/system.html) in a script-less
              sandbox="allow-same-origin" iframe beside the
              fonts with license / portability / "similar" markers and the counts. GET /api/design-systems/:id answers
              {…summary, fonts: [{family, role, source, portable, licenseName, guess}], transitions, versions}.
   create   — choose a source and the project the agent works in; the project opens in Studio with design: "create".
   picker   — the optional design system of a new project (POST /api/create {designSystemId}), and the create
              answer's `designWarning` as one line. Adds itself to window.OVDesign; inert without design.js's kit. */
(function () {
  "use strict";
  const lib = window.OVDesign;
  if (!lib || !lib.kit) return;
  const { ic, esc, api, fmtNumber } = OV;
  const { showMenu, sheet } = OVH;
  const { tr, th, url, fileUrl, designError, swatches, warnings, sourceLabel, systems } = lib.kit;
  /* "Oct 4, 2026" / "4 окт. 2026 г.": a date reads the same mid-sentence in every language (no weekday or "yesterday"). */
  const shortDate = (ms) =>
    new Date(ms).toLocaleDateString(OVI18N.language(), {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  /* The sources the Create dialog offers: [kind, icon]. "From another project" waits for the project mentions. */
  const CREATE_SOURCES = [
    ["scratch", "chat"],
    ["project", "folder"],
    ["video", "film"],
    ["website", "globe"],
  ];

  /* ---------- view ---------- */
  const str = (v) => (typeof v === "string" ? v : "");
  function toDetail(d) {
    const o = d && typeof d === "object" ? d : {};
    return {
      fonts: (Array.isArray(o.fonts) ? o.fonts : [])
        .filter((f) => f && typeof f === "object" && typeof f.family === "string")
        .map((f) => ({
          family: f.family,
          role: str(f.role),
          source: str(f.source),
          portable: f.portable !== false,
          license: typeof f.licenseName === "string" && f.licenseName ? f.licenseName : null,
          guess: f.guess === true,
        })),
      transitions: Number.isInteger(o.transitions) ? o.transitions : null,
      versions: Number.isInteger(o.versions) ? o.versions : null,
    };
  }
  const fontRole = (r) =>
    ["display", "body", "mono", "other"].includes(r) ? tr("home.design.font.role." + r) : r;
  const fontSource = (r) =>
    ["google", "file", "system"].includes(r) ? tr("home.design.font.source." + r) : r;
  function fontHtml(f) {
    const tags = [];
    if (f.guess)
      tags.push(["", tr("home.design.font.similar"), tr("home.design.font.similar.tip")]);
    if (!f.portable)
      tags.push([
        "warning",
        tr("home.design.font.notPortable"),
        tr("home.design.font.notPortable.tip"),
      ]);
    return (
      '<li class="ds-fontrow"><div class="nm"><span>' +
      esc(f.family) +
      '</span><span class="role">' +
      esc(fontRole(f.role)) +
      '</span></div><div class="sub"><span>' +
      esc(fontSource(f.source)) +
      '</span><span class="mid">·</span><span' +
      (f.license ? "" : ' class="warn"') +
      ">" +
      esc(
        f.license
          ? tr("home.design.font.license", { license: f.license })
          : tr("home.design.font.licenseUnknown"),
      ) +
      "</span></div>" +
      (tags.length
        ? '<div class="ds-tags">' +
          tags
            .map(
              (t) =>
                '<span class="badge sm ' +
                t[0] +
                '" title="' +
                esc(t[2]) +
                '">' +
                esc(t[1]) +
                "</span>",
            )
            .join("") +
          "</div>"
        : "") +
      "</li>"
    );
  }
  function detailsHtml(s, d) {
    const warns = warnings(s);
    const fact = (key, n) =>
      n === null ? "" : "<dt>" + th(key) + "</dt><dd>" + esc(fmtNumber(n)) + "</dd>";
    return (
      (warns.length
        ? '<ul class="ds-warns">' +
          warns.map((w) => "<li>" + ic("alert") + "<span>" + esc(w.tip) + "</span></li>").join("") +
          "</ul>"
        : "") +
      "<section><h4>" +
      th("home.design.view.fonts") +
      '</h4><ul class="ds-fonts">' +
      (d.fonts.length
        ? d.fonts.map(fontHtml).join("")
        : '<li class="ds-fontrow"><div class="sub">' +
          th("home.design.view.noFonts") +
          "</div></li>") +
      '</ul></section><dl class="ds-facts">' +
      fact("home.design.view.transitions", d.transitions) +
      fact("home.design.view.versions", d.versions) +
      "</dl>"
    );
  }
  function view(s) {
    const { sh, close } = sheet(
      '<div class="ds-view-head"><h3>' +
        esc(s.name) +
        "</h3>" +
        swatches(s.palette, "lg") +
        '<span class="ds-sub">' +
        esc(
          [tr("home.design.version.long", { version: s.version }), sourceLabel(s)]
            .filter(Boolean)
            .concat(
              s.updatedAt ? [tr("home.design.view.updated", { when: shortDate(s.updatedAt) })] : [],
            )
            .join(" · "),
        ) +
        '</span><button class="icon-btn sm" type="button" data-ds-close aria-label="' +
        th("common.close") +
        '">' +
        ic("x", 12) +
        '</button></div><div class="ds-view-body"><div class="ds-preview"></div><div class="ds-details"></div></div>' +
        '<div class="sheet-actions"><button class="btn btn-primary" type="button" data-cancel>' +
        th("common.close") +
        "</button></div>",
    );
    sh.classList.add("ds-sheet");
    /* Script-less: no allow-scripts, so nothing in the showcase can ever run. allow-same-origin keeps the document on
       this server's origin, so its font requests are plain same-origin loads (the server grants no CORS to anyone). */
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.setAttribute("referrerpolicy", "no-referrer");
    /* Focusable, so arrow keys can scroll the showcase where the webview lets Tab stop on a frame; the header button
       keeps Shift+Tab inside the dialog. */
    frame.tabIndex = 0;
    frame.title = tr("home.design.view.previewTitle", { name: s.name });
    frame.src = fileUrl(s.id, "system.html");
    sh.querySelector(".ds-preview").appendChild(frame);
    const det = sh.querySelector(".ds-details");
    const fetchDetails = () => {
      det.setAttribute("aria-busy", "true");
      det.innerHTML =
        '<span class="sk" style="height:48px"></span><span class="sk" style="height:48px"></span>';
      api(url(s.id))
        .then((res) => {
          det.removeAttribute("aria-busy");
          det.innerHTML = detailsHtml(s, toDetail(res));
        })
        .catch((err) => {
          det.removeAttribute("aria-busy");
          det.innerHTML =
            '<span class="np-err" role="alert">' +
            ic("alert", 12) +
            "<span>" +
            th("home.design.error.details", { message: designError(err) }) +
            '</span></span><div><button class="btn btn-sm" type="button" data-retry>' +
            th("common.retry") +
            "</button></div>";
          det.querySelector("[data-retry]").onclick = fetchDetails;
        });
    };
    fetchDetails();
    sh.querySelector("[data-ds-close]").onclick = close;
    sh.querySelector(".sheet-actions [data-cancel]").focus();
  }

  /* ---------- create: which source, which project; Studio asks for the rest ---------- */
  function create() {
    const projects = lib.kit
      .projects()
      .filter((p) => !p.missing)
      .sort((a, b) => b.ts - a.ts);
    /* Two projects can share a name: the folder tells them apart. */
    const option = (p) =>
      '<option value="' +
      esc(p.id) +
      '">' +
      esc(projects.filter((x) => x.name === p.name).length > 1 ? p.name + " — " + p.path : p.name) +
      "</option>";
    let kind = CREATE_SOURCES[0][0];
    const { sh, close } = sheet(
      "<h3>" +
        th("home.design.create.title") +
        "</h3><p>" +
        th("home.design.create.lede") +
        '</p><div class="np-f" role="group" aria-labelledby="dsSrcL"><span id="dsSrcL">' +
        th("home.design.create.source") +
        '</span><div class="pick ds-src" role="radiogroup" aria-labelledby="dsSrcL">' +
        CREATE_SOURCES.map(
          ([k, icon], i) =>
            '<button type="button" role="radio" data-kind="' +
            k +
            '" aria-checked="' +
            (i === 0) +
            '" tabindex="' +
            (i === 0 ? 0 : -1) +
            '">' +
            ic(icon) +
            '<span class="tx"><b>' +
            th("home.design.source." + k) +
            "</b><small>" +
            th("home.design.source." + k + ".desc") +
            '</small></span><span class="tick">' +
            (i === 0 ? ic("check", 12) : "") +
            "</span></button>",
        ).join("") +
        "</div></div>" +
        (projects.length
          ? "<label>" +
            th("home.design.create.project") +
            '<select class="sel" id="dsProject">' +
            projects.map(option).join("") +
            '</select></label><p class="ds-note">' +
            th("home.design.create.note") +
            "</p>"
          : '<p class="ds-note" role="status">' + th("home.design.create.noProjects") + "</p>") +
        '<div class="sheet-actions"><button class="btn" type="button" data-cancel>' +
        th("common.cancel") +
        '</button><button class="btn btn-primary" type="button" id="dsGo"' +
        (projects.length ? "" : " disabled") +
        ">" +
        th("home.design.create.go") +
        "</button></div>",
    );
    const radios = [...sh.querySelectorAll('[role="radio"]')];
    const choose = (r, focus) => {
      kind = r.dataset.kind;
      for (const x of radios) {
        const on = x === r;
        x.setAttribute("aria-checked", String(on));
        x.tabIndex = on ? 0 : -1;
        x.querySelector(".tick").innerHTML = on ? ic("check", 12) : "";
      }
      if (focus) r.focus();
    };
    const group = sh.querySelector('[role="radiogroup"]');
    group.addEventListener("click", (e) => {
      const r = e.target.closest('[role="radio"]');
      if (r) choose(r, false);
    });
    group.addEventListener("keydown", (e) => {
      const i = radios.indexOf(document.activeElement),
        step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (i < 0 || !step) return;
      e.preventDefault();
      choose(radios[(i + step + radios.length) % radios.length], true);
    });
    sh.querySelector("#dsGo").onclick = () => {
      const p = projects.find((x) => x.id === sh.querySelector("#dsProject").value);
      if (!p) return;
      close();
      lib.kit.open(p, { design: "create", designSource: kind });
    };
    radios[0].focus();
  }

  /* ---------- New Project sheet: an optional design system ---------- */
  const menuLabel = (s) =>
    '<span class="ds-mi">' +
    swatches(s.palette) +
    '<span class="ds-nm">' +
    esc(s.name) +
    '</span><span class="ds-ver">' +
    th("home.design.version", { version: s.version }) +
    "</span></span>";
  /* The row of the New Project sheet; nothing while the library is empty or unread. */
  function pickerHtml() {
    if (!lib.kit.ready() || !systems().length) return "";
    return (
      '<div class="np-f" role="group" aria-labelledby="npDsL"><span id="npDsL">' +
      th("home.design.pick.label") +
      '</span><button class="btn ds-pick" type="button" id="npDs" aria-haspopup="menu" aria-expanded="false" aria-describedby="npDsHint"></button>' +
      '<span class="ds-note" id="npDsHint">' +
      th("home.design.pick.hint") +
      "</span></div>"
    );
  }
  /* Wires the row inside the opened sheet; id() is the chosen system's id, or null (None, the default). */
  function bindPicker(sh) {
    const btn = sh.querySelector("#npDs");
    if (!btn) return { id: () => null };
    let chosen = null;
    const paint = () => {
      btn.innerHTML =
        (chosen ? swatches(chosen.palette) : "") +
        '<span class="ds-pick-name' +
        (chosen ? "" : " is-none") +
        '">' +
        (chosen ? esc(chosen.name) : th("common.none")) +
        "</span>" +
        ic("chevron", 12);
    };
    const pick = (s) => {
      chosen = s;
      paint();
    };
    btn.onclick = () => {
      const r = btn.getBoundingClientRect();
      const menu = showMenu(
        [{ label: th("common.none"), radio: true, checked: !chosen, act: () => pick(null) }].concat(
          systems().map((s) => ({
            label: menuLabel(s),
            radio: true,
            checked: !!chosen && chosen.id === s.id,
            act: () => pick(s),
          })),
        ),
        r.left,
        r.bottom + 4,
        btn,
        btn,
      );
      /* As wide as the button it opens from (and no wider than the sheet: .ds-mi truncates the name). */
      if (menu) menu.style.minWidth = r.width + "px";
    };
    paint();
    return { id: () => (chosen ? chosen.id : null) };
  }
  /* The create answer's `designWarning` (the project exists, the system was not applied) as one line, or "". */
  function warning(res) {
    const w = res && res.designWarning;
    if (!w) return "";
    const message = typeof w === "string" ? w : typeof w.message === "string" ? w.message : "";
    return tr("home.design.warning", { message: message || tr("home.error.unknown") });
  }

  Object.assign(lib, { view, create, pickerHtml, bindPicker, warning });
})();
