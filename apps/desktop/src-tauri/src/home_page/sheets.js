/* Projects page overlays, as in the prototype: context menu, sheet (top-anchored dialog), toast.
   One of each at a time; all live in #layer so they share the window's stacking context. */
(function () {
  "use strict";
  const { ic, esc } = OV;
  const win = document.getElementById("win"),
    layer = document.getElementById("layer");

  /* ---------- toast ---------- */
  let toastTimer;
  /* msg is HTML (callers escape user text); action = { label, act }; tone 'error' marks failures. */
  function toast(msg, action, tone) {
    clearTimeout(toastTimer);
    const old = layer.querySelector(".toast");
    if (old) old.remove();
    const t = document.createElement("div");
    t.className = "toast" + (tone === "error" ? " is-error" : "");
    t.setAttribute("role", tone === "error" ? "alert" : "status");
    t.innerHTML =
      "<span>" +
      msg +
      "</span>" +
      (action ? '<button class="btn btn-sm" type="button">' + esc(action.label) + "</button>" : "");
    if (action)
      t.querySelector("button").onclick = () => {
        t.remove();
        action.act();
      };
    layer.appendChild(t);
    toastTimer = setTimeout(() => t.remove(), tone === "error" ? 9000 : 6500);
  }

  /* ---------- menu ---------- */
  let menuEl = null,
    menuRestore = null,
    menuBtn = null;
  function closeMenu(restore) {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    if (menuBtn) {
      menuBtn.setAttribute("aria-expanded", "false");
      menuBtn = null;
    }
    if (restore && menuRestore && menuRestore.focus) menuRestore.focus();
    menuRestore = null;
  }
  /* items: { label (HTML), icon, kbd, danger, radio, checked, disabled, act } | { sep: 1 } */
  function showMenu(items, x, y, restoreEl, btn) {
    closeMenu(false);
    const m = document.createElement("div");
    m.className = "menu";
    m.setAttribute("role", "menu");
    m.innerHTML = items
      .map((it, i) =>
        it.sep
          ? '<div class="menu-sep" role="separator"></div>'
          : '<button class="menu-item' +
            (it.danger ? " is-danger" : "") +
            '" type="button" role="' +
            (it.radio ? "menuitemradio" : "menuitem") +
            '"' +
            (it.radio ? ' aria-checked="' + !!it.checked + '"' : "") +
            ' data-i="' +
            i +
            '"' +
            (it.disabled ? " disabled" : "") +
            ">" +
            (it.radio
              ? '<span class="tick">' + (it.checked ? ic("check", 12) : "") + "</span>"
              : ic(it.icon)) +
            '<span class="grow">' +
            it.label +
            "</span>" +
            (it.kbd ? '<span class="sc">' + it.kbd + "</span>" : "") +
            "</button>",
      )
      .join("");
    layer.appendChild(m);
    const w = win.getBoundingClientRect(),
      mr = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(x - w.left, w.width - mr.width - 8)) + "px";
    let top = y - w.top;
    if (top + mr.height > w.height - 34) top = Math.max(8, w.height - 34 - mr.height);
    m.style.top = top + "px";
    menuEl = m;
    menuRestore = restoreEl;
    if (btn) {
      menuBtn = btn;
      btn.setAttribute("aria-expanded", "true");
    }
    const enabled = () => [...m.querySelectorAll(".menu-item:not([disabled])")];
    if (enabled()[0]) enabled()[0].focus();
    m.addEventListener("mouseover", (e) => {
      const b = e.target.closest(".menu-item");
      if (b && !b.disabled && document.activeElement !== b) b.focus({ preventScroll: true });
    });
    m.addEventListener("click", (e) => {
      const b = e.target.closest(".menu-item");
      if (!b) return;
      const it = items[b.dataset.i];
      closeMenu(true);
      if (it.act) it.act();
    });
    m.addEventListener("keydown", (e) => {
      const list = enabled(),
        i = list.indexOf(document.activeElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        list[(i + 1) % list.length].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        list[(i - 1 + list.length) % list.length].focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        list[0].focus();
      } else if (e.key === "End") {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
      }
    });
    return m;
  }
  document.addEventListener("mousedown", (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu(false);
  });

  /* ---------- sheet ---------- */
  let openSheet = null;
  function sheet(html, opts) {
    closeMenu(false);
    if (openSheet) openSheet.close();
    const restore = document.activeElement;
    const sc = document.createElement("div");
    sc.className = "scrim";
    const sh = document.createElement("div");
    sh.className = "sheet";
    sh.setAttribute("role", (opts && opts.role) || "dialog");
    sh.setAttribute("aria-modal", "true");
    sh.innerHTML = html;
    layer.append(sc, sh);
    const h = sh.querySelector("h3");
    if (h) {
      h.id = "sheet-title";
      sh.setAttribute("aria-labelledby", h.id);
    }
    const close = () => {
      closeMenu(false);
      sc.remove();
      sh.remove();
      if (openSheet && openSheet.sh === sh) openSheet = null;
      if (restore && restore.focus && restore.isConnected) restore.focus();
      if (opts && opts.onClose) opts.onClose();
    };
    sc.onclick = () => {
      if (!sh.classList.contains("is-busy")) close();
    };
    sh.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !sh.classList.contains("is-busy")) {
        e.stopPropagation();
        close();
      }
      if (e.key === "Tab") {
        const f = [
            ...sh.querySelectorAll(
              "button:not([disabled]),input:not([disabled]),select:not([disabled])",
            ),
          ].filter((el) => !el.closest("[hidden]")),
          i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0].focus();
        }
      }
    });
    const cancel = sh.querySelector("[data-cancel]");
    if (cancel) cancel.onclick = close;
    openSheet = { sh, close };
    return openSheet;
  }
  const sheetOpen = () => !!openSheet;

  window.OVH = { toast, showMenu, closeMenu, sheet, sheetOpen, menuOpen: () => !!menuEl };
})();
