/* Projects page — the project tab strip (beta feature `projectTabs`). The shell keeps one webview per open project
   plus this page; its home server lists them at GET /api/tabs and this page draws the strip under the titlebar:
   a non-closable "Projects" tab (this page, always the selected one: the page is only visible while it is the
   active tab), one tab per open project, and a trailing + that comes back here. Nothing is drawn, fetched or
   listened to unless OV.betaFeatures(); with no project tab open the page looks exactly as it does without tabs.
   Global: window.OVTabs — home.js reads the tab state (per-project opening, the "Open" mark on cards). */
(function () {
  "use strict";
  const { api, esc, ic, describeError } = OV;
  const tr = (key, params) => OVI18N.t(key, params);
  const HOME = "home";
  /* Safety net under the shell's `openvids-tabs-changed` push: one re-read every 10 s while the page is visible. */
  const POLL_MS = 10000;

  /* The last answer of GET /api/tabs: { enabled, tabs: [{ key, name, state: "open" | "opening" }] }. */
  let state = { enabled: false, tabs: [] };
  let signature = "";
  let seq = 0;
  /* Keys whose close request is in flight (the shell may be asking the user in a native dialog). */
  const pending = new Set();
  /* A fork request is in flight (one at a time: the shell shows the Projects page's progress overlay for it). */
  let forking = false;
  /* The key holding the roving tabindex. */
  let focusKey = HOME;
  let strip = null,
    list = null;
  const listeners = new Set();

  /* The wire shape, checked: anything else counts as "tabs off". */
  function parseTabs(data) {
    if (!data || typeof data !== "object" || data.enabled !== true)
      return { enabled: false, tabs: [] };
    const tabs = [];
    for (const t of Array.isArray(data.tabs) ? data.tabs : []) {
      if (!t || typeof t.key !== "string" || !t.key) continue;
      if (t.state !== "open" && t.state !== "opening") continue;
      tabs.push({
        key: t.key,
        name: typeof t.name === "string" && t.name ? t.name : t.key,
        state: t.state,
      });
    }
    return { enabled: true, tabs };
  }
  const signatureOf = (s) =>
    JSON.stringify([s.enabled, s.tabs.map((t) => [t.key, t.name, t.state])]);

  function refresh() {
    const mine = ++seq;
    return api("/api/tabs")
      .then((data) => {
        if (mine === seq) apply(parseTabs(data));
      })
      .catch(() => {
        /* The shell is busy or answers no tab list: what is drawn stays; a page that never got an answer has no tabs. */
      });
  }
  function apply(next) {
    const sig = signatureOf(next);
    if (sig === signature) return;
    state = next;
    signature = sig;
    for (const key of [...pending]) if (!next.tabs.some((t) => t.key === key)) pending.delete(key);
    paint();
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
  }

  /* ---------- the strip ---------- */
  function paint() {
    if (state.enabled && state.tabs.length) {
      mount();
      render();
    } else unmount();
  }
  function mount() {
    if (strip) return;
    const header = document.querySelector(".titlebar");
    if (!header) return;
    strip = document.createElement("div");
    strip.id = "ovTabs";
    strip.className = "ov-tabs";
    /* Only the empty remainder of the row drags the window; the tabs themselves must take clicks. */
    strip.setAttribute("data-tauri-drag-region", "");
    strip.innerHTML =
      '<div class="ov-tabs-list" role="tablist"></div>' +
      '<button class="icon-btn sm ov-tabs-add" type="button">' +
      ic("plus", 14) +
      "</button>" +
      '<div class="ov-tabs-fill" data-tauri-drag-region></div>';
    list = strip.querySelector(".ov-tabs-list");
    strip.addEventListener("click", onClick);
    list.addEventListener("keydown", onKeydown);
    list.addEventListener("focusin", onFocusin);
    header.after(strip);
    document.documentElement.classList.add("ov-has-tabs");
  }
  function unmount() {
    if (!strip) return;
    strip.remove();
    strip = null;
    list = null;
    document.documentElement.classList.remove("ov-has-tabs");
  }
  function tabHtml(t) {
    const home = t.key === HOME,
      opening = t.state === "opening",
      closing = pending.has(t.key),
      key = esc(t.key);
    const full = opening ? tr("home.tabs.tabOpening", { name: t.name }) : t.name;
    return (
      '<div class="ov-tab' +
      (home ? " is-selected is-home" : "") +
      (opening ? " is-opening" : "") +
      (closing ? " is-closing" : "") +
      '" role="presentation">' +
      '<button class="ov-tab-btn" type="button" role="tab" data-key="' +
      key +
      '" aria-selected="' +
      home +
      '" tabindex="' +
      (t.key === focusKey ? 0 : -1) +
      '"' +
      (opening ? ' aria-disabled="true" aria-label="' + esc(full) + '"' : "") +
      (home ? "" : ' title="' + esc(full) + '"') +
      ">" +
      (home ? ic("grid", 14) : "") +
      '<span class="ov-tab-label">' +
      esc(t.name) +
      "</span></button>" +
      (home
        ? ""
        : opening
          ? '<span class="ov-tab-spin" aria-hidden="true"><i class="spinner sm"></i></span>'
          : '<button class="ov-tab-fork" type="button" tabindex="-1" data-fork="' +
            key +
            '" aria-label="' +
            esc(tr("home.tabs.fork", { name: t.name })) +
            '" title="' +
            esc(tr("home.tabs.fork", { name: t.name })) +
            '"' +
            (forking ? " disabled" : "") +
            ">" +
            ic("fork", 11) +
            "</button>" +
            '<button class="ov-tab-x" type="button" tabindex="-1" data-close="' +
            key +
            '" aria-label="' +
            esc(tr("home.tabs.close", { name: t.name })) +
            '" title="' +
            esc(tr("home.tabs.close", { name: t.name })) +
            '"' +
            (closing ? " disabled" : "") +
            ">" +
            ic("x", 10) +
            "</button>") +
      "</div>"
    );
  }
  function render() {
    if (!strip) return;
    const tabs = [{ key: HOME, name: tr("home.tabs.projects"), state: "open" }].concat(state.tabs);
    if (!tabs.some((t) => t.key === focusKey)) focusKey = HOME;
    const had = list.contains(document.activeElement),
      at = had ? document.activeElement.dataset : {},
      focused = at.key || at.close || at.fork || null;
    list.setAttribute("aria-label", tr("home.tabs.label"));
    list.innerHTML = tabs.map(tabHtml).join("");
    const add = strip.querySelector(".ov-tabs-add");
    add.title = tr("home.tabs.add");
    add.setAttribute("aria-label", tr("home.tabs.add"));
    /* A redraw must not drop keyboard focus; a tab that is gone hands it to the Projects tab. */
    if (had) {
      const el = tabEl(focused) || tabEl(HOME);
      if (el) el.focus({ preventScroll: true });
    }
  }
  const tabEl = (key) =>
    key && list
      ? [...list.querySelectorAll("[data-key]")].find((el) => el.dataset.key === key)
      : null;

  /* ---------- actions ---------- */
  const toast = (msg) => window.OVH && window.OVH.toast(esc(msg), null, "error");
  const find = (key) => state.tabs.find((t) => t.key === key);
  function activateTab(key) {
    /* This page is the Projects tab; a project that is still starting cannot be switched to. */
    const t = find(key);
    if (key === HOME || !t || t.state !== "open") return;
    api("/api/tabs/activate", { key }).catch((err) => {
      /* 404 (the tab went away) and 409 (still opening) are answered by the next read. */
      if (err.status !== 404 && err.status !== 409)
        toast(tr("home.tabs.error.activate", { message: describeError(err) }));
      return refresh();
    });
  }
  function closeTab(key) {
    const t = find(key);
    if (!t || t.state !== "open" || pending.has(key)) return;
    pending.add(key);
    render();
    /* No timeout: while a render or an agent turn runs, the shell answers only after the user decided. */
    api("/api/tabs/close", { key })
      .catch((err) => {
        if (err.status !== 404)
          toast(tr("home.tabs.error.close", { name: t.name, message: describeError(err) }));
      })
      .finally(() => {
        pending.delete(key);
        render();
        refresh();
      });
  }
  /* Fork: the shell starts the copy of this tab's project and this page shows its progress overlay (with Cancel);
     the finished fork opens as a new tab. One request at a time. */
  function forkTab(key) {
    const t = find(key);
    if (!t || t.state !== "open" || forking) return;
    forking = true;
    render();
    api("/api/tabs/fork", { key })
      .then(() => window.OVFork && window.OVFork.adopt())
      .catch((err) => {
        if (err.status !== 404)
          toast(tr("home.error.fork", { name: t.name, message: describeError(err) }));
      })
      .finally(() => {
        forking = false;
        render();
        refresh();
      });
  }
  /* + "Open another project": back to the Projects page, which is here already — put the cursor where a project
     is found or described. */
  function openAnother() {
    api("/api/tabs/activate", { key: HOME }).catch(() => {});
    const target = document.querySelector(
      "#search:not(:disabled), #chatHost textarea:not(:disabled)",
    );
    if (target) target.focus();
  }

  function onClick(e) {
    const x = e.target.closest("[data-close]");
    if (x) return closeTab(x.dataset.close);
    const fork = e.target.closest("[data-fork]");
    if (fork) return forkTab(fork.dataset.fork);
    const tab = e.target.closest('[role="tab"]');
    if (tab) return activateTab(tab.dataset.key);
    if (e.target.closest(".ov-tabs-add")) openAnother();
  }
  /* ←/→ (wrapping), Home/End move focus between the tabs; Enter/Space activate through the button's click;
     Delete/Backspace closes a focused project tab. */
  function onKeydown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tab = e.target.closest('[role="tab"]');
    if (!tab) return;
    const tabs = [...list.querySelectorAll('[role="tab"]')],
      i = tabs.indexOf(tab);
    const to = {
      ArrowRight: tabs[(i + 1) % tabs.length],
      ArrowLeft: tabs[(i - 1 + tabs.length) % tabs.length],
      Home: tabs[0],
      End: tabs[tabs.length - 1],
    }[e.key];
    /* Handled here and not passed on: the page's own key handler would move the Recent selection on arrows and
       remove the selected recent on Delete, and a redraw below detaches e.target before it gets there. */
    if (to) {
      e.preventDefault();
      e.stopPropagation();
      to.focus();
    } else if ((e.key === "Delete" || e.key === "Backspace") && tab.dataset.key !== HOME) {
      e.preventDefault();
      e.stopPropagation();
      closeTab(tab.dataset.key);
    }
  }
  function onFocusin(e) {
    const tab = e.target.closest('[role="tab"]');
    if (!tab) return;
    focusKey = tab.dataset.key;
    for (const el of list.querySelectorAll('[role="tab"]')) el.tabIndex = el === tab ? 0 : -1;
  }

  /* ---------- API for home.js ---------- */
  const ready = OV.betaFeatures() ? refresh() : Promise.resolve();
  window.OVTabs = {
    /* Settles once the first read of /api/tabs has (also when it failed). */
    ready,
    /* Tabs are on (beta build, desktop shell): opening a project no longer takes over the page. */
    enabled: () => state.enabled,
    keys: () => state.tabs.map((t) => t.key),
    /* "open" | "opening" | null for a project key (a recent's id). */
    stateOf(key) {
      const t = find(key);
      return t ? t.state : null;
    },
    refresh,
    /* fn() runs after the tab list changed (enabled flag, a tab added, removed, renamed or finished opening). */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  if (OV.betaFeatures()) {
    window.addEventListener("openvids-tabs-changed", refresh);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refresh();
    });
    window.addEventListener("focus", refresh);
    setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    window.addEventListener("ov-language", render);
  }
})();
