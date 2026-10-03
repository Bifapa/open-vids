/* Report window — a problem report written in a window of its own, so the editor stays usable beside it.
   Talks to the desktop home server (token on every call):
   GET/PUT  /api/report/draft                    the text fields, saved as typed (and kept across restarts)
   POST     /api/report/screenshots              raw image body → {id,name,size,mime}
   POST     /api/report/screenshots/capture      {hideWindow} → one screenshot, or {cancelled}
   POST     /api/report/screenshots/pick         native file picker → {added[], rejected[]}
   GET/DELETE /api/report/screenshots/<id>       the image / drop it
   POST     /api/report/pin                      {alwaysOnTop}
   POST     /api/report/submit                   sends the SAVED draft with its screenshots + logs
   POST     /api/open-external                   the published issue, in the default browser */
(function () {
  "use strict";
  const { ic, esc, api, formatBytes } = OV;
  const t = (key, params) => OVI18N.t(key, params);
  const $ = (selector) => document.querySelector(selector);

  const LIMITS = {
    minDescription: 10,
    description: 8000,
    steps: 4000,
    email: 200,
    shots: 5,
    shotBytes: 8 * 1024 * 1024,
    counterFrom: 7000,
    counterWarn: 7800,
  };
  const TYPES = ["image/png", "image/jpeg", "image/webp"];
  const EXT_TYPES = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const HIDE_KEY = "ov-report-hide-window";

  const desc = $("#rpDesc"),
    steps = $("#rpSteps"),
    email = $("#rpEmail"),
    hide = $("#rpHide");
  const fields = [desc, steps, email];

  const S = {
    shots: [] /* {id,name,size,mime} on the server */,
    pending: [] /* uploads in flight: {key,name,url,file,mime} */,
    busy: null /* "capture" | "pick" while a native step runs */,
    sending: false,
    done: null /* {kind:"published",number,url} | {kind:"received"} */,
    error: null /* a failed send: {code,message,retryAfter} */,
    loadError: null /* the draft could not be read */,
    shotErrors: [],
    touched: { desc: false, email: false },
    draftLoaded: false,
    pin: false,
  };
  /* id → blob: URL of the image (thumbnails need the token header, so an <img src> to the route cannot be used). */
  const thumbs = new Map();

  const authHeaders = () => ({ "X-OpenVids-Token": window.OV_TOKEN });
  const locked = () => S.sending || !!S.done;
  const fieldsLocked = () => locked() || !S.draftLoaded;
  const shotsFull = () => S.shots.length + S.pending.length >= LIMITS.shots;
  const descLength = () => desc.value.trim().length;
  const emailValue = () => email.value.trim();
  const emailValid = () => emailValue() === "" || EMAIL.test(emailValue());
  const descValid = () =>
    descLength() >= LIMITS.minDescription && descLength() <= LIMITS.description;
  const canSend = () =>
    !locked() && S.draftLoaded && descValid() && emailValid() && S.pending.length === 0 && !S.busy;

  /* ---------- draft: saved as typed, flushed on blur / hide, and always before a send ---------- */
  const values = () => ({ description: desc.value, steps: steps.value, email: email.value });
  let draftDirty = false;
  let draftTimer = 0;
  let saveChain = Promise.resolve();

  function putDraft(body, keepalive) {
    return fetch("/api/report/draft", {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify(body),
      keepalive: !!keepalive,
    }).then((res) => {
      if (!res.ok) throw new Error(t("home.error.requestFailed", { status: res.status }));
    });
  }
  function scheduleSave() {
    if (!S.draftLoaded || S.done) return;
    draftDirty = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(flushDraft, 500);
  }
  /* Writes the pending text now. Writes are chained so an older one never lands after a newer one. Rejects when
     the write failed (the text stays marked unsaved). */
  function flushDraft() {
    clearTimeout(draftTimer);
    const run = () => {
      if (!draftDirty) return undefined;
      draftDirty = false;
      return putDraft(values()).catch((err) => {
        draftDirty = true;
        throw err;
      });
    };
    const next = saveChain.then(run);
    saveChain = next.catch(() => {});
    return next;
  }
  /* Unload cannot wait for an answer: a keepalive request outlives the page. */
  function flushOnHide() {
    if (!draftDirty || !S.draftLoaded || S.done) return;
    clearTimeout(draftTimer);
    draftDirty = false;
    putDraft(values(), true).catch(() => {
      draftDirty = true;
    });
  }

  function fillFields(d) {
    desc.value = typeof d.description === "string" ? d.description : "";
    steps.value = typeof d.steps === "string" ? d.steps : "";
    email.value = typeof d.email === "string" ? d.email : "";
  }
  function loadDraft(retry) {
    return api("/api/report/draft")
      .then((d) => {
        S.loadError = null;
        if (!retry || fields.every((f) => f.value === "")) fillFields(d);
        for (const s of Array.isArray(d.screenshots) ? d.screenshots : []) addShot(s);
      })
      .catch((err) => {
        S.loadError = err;
      })
      .then(() => {
        S.draftLoaded = true;
        render();
        if (!retry) desc.focus();
      });
  }

  /* ---------- screenshots ---------- */
  function mimeOf(file) {
    if (TYPES.includes(file.type)) return file.type;
    const ext = String(file.name || "")
      .split(".")
      .pop()
      .toLowerCase();
    return EXT_TYPES[ext] || file.type;
  }
  function shotError(code, name, message) {
    const params = { name: name || "", max: LIMITS.shots, message: message || "" };
    if (code === "too_large" || code === "unsupported_type" || code === "too_many")
      return t("report.shots.error." + code, params);
    return t("report.shots.error.failed", params);
  }
  function pushShotError(code, name, message) {
    const text = shotError(code, name, message);
    if (!S.shotErrors.includes(text)) S.shotErrors.push(text);
  }
  /* The code a failed api() call carried (its answer is {error: code, message?}). */
  const codeOf = (err) =>
    err && err.data && typeof err.data.error === "string" ? err.data.error : "";
  const messageOf = (err) =>
    (err && err.data && typeof err.data.message === "string" && err.data.message) ||
    (err && err.message) ||
    "";

  function loadThumb(id) {
    if (thumbs.has(id)) return;
    thumbs.set(id, "");
    fetch("/api/report/screenshots/" + encodeURIComponent(id), { headers: authHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.blob();
      })
      .then((blob) => {
        thumbs.set(id, URL.createObjectURL(blob));
        renderShots();
      })
      .catch(() => {
        thumbs.delete(id);
      });
  }
  function addShot(s) {
    if (!s || typeof s.id !== "string" || S.shots.some((x) => x.id === s.id)) return;
    S.shots.push(s);
    loadThumb(s.id);
  }

  let uploadChain = Promise.resolve();
  function upload(p) {
    return fetch("/api/report/screenshots", {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": p.mime, "X-File-Name": encodeURIComponent(p.name) },
        authHeaders(),
      ),
      body: p.file,
    })
      .then((res) =>
        res
          .json()
          .catch(() => ({}))
          .then((data) => {
            if (!res.ok || (data && typeof data.error === "string")) {
              const err = new Error((data && data.message) || "HTTP " + res.status);
              err.data = data;
              throw err;
            }
            return data;
          }),
      )
      .then((data) => {
        /* Keep the local preview as the thumbnail: no second download. */
        thumbs.set(data.id, p.url);
        p.url = "";
        S.shots.push(data);
      })
      .catch((err) => pushShotError(codeOf(err), p.name, messageOf(err)))
      .then(() => {
        if (p.url) URL.revokeObjectURL(p.url);
        S.pending = S.pending.filter((x) => x !== p);
        render();
      });
  }

  /* Files from a paste, a drop… Each is checked here only for what the server would refuse anyway. */
  function addFiles(list) {
    if (locked()) return;
    S.shotErrors = [];
    for (const file of Array.from(list)) {
      const name = file.name || t("report.shots.defaultName");
      const mime = mimeOf(file);
      if (!TYPES.includes(mime)) pushShotError("unsupported_type", name);
      else if (file.size > LIMITS.shotBytes) pushShotError("too_large", name);
      else if (shotsFull()) pushShotError("too_many", name);
      else {
        const p = { name, mime, file, url: URL.createObjectURL(file) };
        S.pending.push(p);
        uploadChain = uploadChain.then(() => upload(p));
      }
    }
    render();
  }

  function removeShot(id) {
    if (locked()) return;
    const at = S.shots.findIndex((s) => s.id === id);
    if (at < 0) return;
    const [gone] = S.shots.splice(at, 1);
    S.shotErrors = [];
    render();
    api("/api/report/screenshots/" + encodeURIComponent(id), undefined, "DELETE")
      .then(() => {
        const url = thumbs.get(id);
        if (url) URL.revokeObjectURL(url);
        thumbs.delete(id);
      })
      .catch((err) => {
        S.shots.splice(at, 0, gone);
        pushShotError("remove", gone.name, messageOf(err));
        render();
      });
  }

  function pick() {
    if (locked() || S.busy) return;
    S.shotErrors = [];
    if (shotsFull()) {
      pushShotError("too_many", "");
      render();
      return;
    }
    S.busy = "pick";
    render();
    api("/api/report/screenshots/pick", {})
      .then((res) => {
        for (const s of Array.isArray(res.added) ? res.added : []) addShot(s);
        for (const r of Array.isArray(res.rejected) ? res.rejected : [])
          pushShotError(r && r.error, r && r.name);
      })
      .catch((err) => pushShotError(codeOf(err), "", messageOf(err)))
      .then(() => {
        S.busy = null;
        render();
      });
  }
  function capture() {
    if (locked() || S.busy) return;
    S.shotErrors = [];
    if (shotsFull()) {
      pushShotError("too_many", "");
      render();
      return;
    }
    S.busy = "capture";
    render();
    api("/api/report/screenshots/capture", { hideWindow: hide.checked })
      .then((res) => {
        if (!res.cancelled) addShot(res);
      })
      .catch((err) => pushShotError(codeOf(err), t("report.shots.capturedName"), messageOf(err)))
      .then(() => {
        S.busy = null;
        render();
      });
  }

  /* ---------- sending ---------- */
  function send() {
    if (!canSend()) return;
    S.sending = true;
    S.error = null;
    render();
    flushDraft()
      .catch((err) => {
        const e = new Error(err.message);
        e.data = { error: "draft", message: err.message };
        throw e;
      })
      .then(() => api("/api/report/submit", {}))
      .then((res) => {
        S.sending = false;
        clearTimeout(draftTimer);
        draftDirty = false;
        if (res && res.status === "published")
          S.done = { kind: "published", number: res.issueNumber, url: res.issueUrl };
        else S.done = { kind: "received" };
        /* The draft and its screenshots are gone on the server too. */
        fillFields({});
        for (const url of thumbs.values()) if (url) URL.revokeObjectURL(url);
        thumbs.clear();
        S.shots = [];
        S.shotErrors = [];
        render();
      })
      .catch((err) => {
        S.sending = false;
        const data = (err && err.data) || {};
        S.error = {
          code: typeof data.error === "string" ? data.error : err && err.data ? "" : "network",
          message: messageOf(err),
          retryAfter: typeof data.retryAfter === "number" ? data.retryAfter : 0,
        };
        render();
      });
  }
  function newReport() {
    S.done = null;
    S.error = null;
    S.touched = { desc: false, email: false };
    render();
    desc.focus();
  }

  /* ---------- rendering ---------- */
  function errorText(e) {
    switch (e.code) {
      case "rate_limited": {
        const minutes = Math.max(1, Math.ceil(e.retryAfter / 60));
        return e.retryAfter > 0
          ? t("report.error.rateLimited", { minutes })
          : t("report.error.rateLimitedNow");
      }
      case "disabled":
        return t("report.error.disabled");
      case "network":
        return t("report.error.network");
      case "too_large":
        return t("report.error.tooLarge");
      case "invalid_request":
        return t("report.error.invalid", { message: e.message });
      case "draft":
        return t("report.error.draft", { message: e.message });
      case "server":
        return t("report.error.server");
      default:
        return t("report.error.generic", { message: e.message });
    }
  }
  function banner(kind, icon, text, sub, retry) {
    return (
      '<div class="rp-banner' +
      (kind ? " is-" + kind : "") +
      '" role="' +
      (kind === "error" ? "alert" : "status") +
      '">' +
      icon +
      '<span class="rp-banner-text">' +
      esc(text) +
      (sub ? '<span class="rp-banner-sub">' + esc(sub) + "</span>" : "") +
      "</span>" +
      (retry
        ? '<button type="button" class="btn btn-sm" data-act="' +
          retry +
          '">' +
          esc(t("report.retry")) +
          "</button>"
        : "") +
      "</div>"
    );
  }
  function renderBanner() {
    let html = "";
    if (S.sending)
      html = banner(
        "",
        '<span class="spinner"></span>',
        t("report.sending"),
        t("report.sending.hint"),
      );
    else if (S.error)
      html = banner("error", ic("alert"), errorText(S.error), t("report.error.kept"), "retry");
    else if (S.loadError)
      html = banner(
        "error",
        ic("alert"),
        t("report.error.load", { message: messageOf(S.loadError) }),
        "",
        "reload",
      );
    $("#rpBanner").innerHTML = html;
  }
  function renderShots() {
    const items = S.shots
      .map((s) => {
        const url = thumbs.get(s.id);
        const label = s.name + (s.size ? " · " + formatBytes(s.size) : "");
        return (
          '<li class="rp-shot"><div class="rp-shot-img">' +
          (url
            ? '<img alt="" draggable="false" src="' + esc(url) + '" />'
            : '<span class="spinner"></span>') +
          '</div><button type="button" class="icon-btn xs rp-shot-x" data-remove="' +
          esc(s.id) +
          '" aria-label="' +
          esc(t("report.shots.remove", { name: s.name })) +
          '"' +
          (locked() ? " disabled" : "") +
          ">" +
          ic("x") +
          '</button><div class="rp-shot-name" title="' +
          esc(label) +
          '">' +
          esc(s.name) +
          "</div></li>"
        );
      })
      .concat(
        S.pending.map(
          (p) =>
            '<li class="rp-shot is-pending"><div class="rp-shot-img"><img alt="" draggable="false" src="' +
            esc(p.url) +
            '" /><span class="spinner"></span></div><div class="rp-shot-name">' +
            esc(p.name) +
            "</div></li>",
        ),
      );
    $("#rpShots").innerHTML = items.join("");
    $("#rpShotsEmpty").hidden = items.length > 0;
    $("#rpShotErrors").innerHTML = S.shotErrors.map((m) => "<li>" + esc(m) + "</li>").join("");
  }
  function renderCounts() {
    const length = desc.value.length;
    const count = $("#rpDescCount");
    count.hidden = length < LIMITS.counterFrom;
    count.textContent = t("report.description.count", { count: length, max: LIMITS.description });
    count.classList.toggle("is-near", length >= LIMITS.counterWarn);
    $("#rpShotsCount").textContent = t("report.shots.count", {
      count: S.shots.length + S.pending.length,
      max: LIMITS.shots,
    });
  }
  function renderHints() {
    const shortDesc = S.touched.desc && !descValid() && !locked();
    const dh = $("#rpDescHint");
    dh.hidden = !shortDesc;
    dh.textContent = shortDesc
      ? t("report.description.tooShort", { min: LIMITS.minDescription })
      : "";
    desc.classList.toggle("is-invalid", shortDesc);
    const badEmail = S.touched.email && !emailValid() && !locked();
    const eh = $("#rpEmailHint");
    eh.hidden = !badEmail;
    eh.textContent = badEmail ? t("report.email.invalid") : "";
    email.classList.toggle("is-invalid", badEmail);
  }
  function renderDone() {
    const done = S.done;
    $("#rpForm").hidden = !!done;
    $("#rpDone").hidden = !done;
    $("#rpFoot").hidden = !!done;
    if (!done) return;
    $("#rpDoneIc").innerHTML = ic("check");
    const text = $("#rpDoneText");
    if (done.kind === "published" && typeof done.number === "number" && done.url)
      text.innerHTML = OVI18N.rich(
        "report.done.published",
        { number: String(done.number) },
        { a: (inner) => '<a href="#" class="link" data-act="issue">' + inner + "</a>" },
      );
    else if (done.kind === "published") text.textContent = t("report.done.publishedPlain");
    else text.textContent = t("report.done.received");
  }
  function render() {
    for (const f of fields) f.readOnly = fieldsLocked();
    $("#rpPick").innerHTML =
      (S.busy === "pick" ? '<span class="spinner sm"></span>' : ic("image")) +
      esc(t("report.shots.choose"));
    $("#rpCapture").innerHTML =
      (S.busy === "capture" ? '<span class="spinner sm"></span>' : ic("maximize")) +
      esc(t("report.shots.capture"));
    const noAdd = locked() || !!S.busy;
    $("#rpPick").disabled = noAdd;
    $("#rpCapture").disabled = noAdd;
    hide.disabled = locked();
    $("#rpPin").setAttribute("aria-checked", String(S.pin));
    const send = $("#rpSend");
    send.disabled = !canSend();
    send.innerHTML = S.sending
      ? '<span class="spinner"></span>' + esc(t("report.sending"))
      : esc(t("report.send")) + ' <span class="kbd">⌘↵</span>';
    renderShots();
    renderCounts();
    renderHints();
    renderBanner();
    renderDone();
  }

  /* ---------- events ---------- */
  for (const f of fields) {
    f.addEventListener("input", () => {
      scheduleSave();
      renderCounts();
      $("#rpSend").disabled = !canSend();
      if (f === desc && S.touched.desc && descValid()) renderHints();
      if (f === email && S.touched.email) renderHints();
    });
    f.addEventListener("blur", () => {
      if (f === desc) S.touched.desc = true;
      if (f === email) S.touched.email = true;
      renderHints();
      flushDraft().catch(() => {});
    });
  }
  $("#rpForm").addEventListener("submit", (e) => e.preventDefault());
  $("#rpSend").addEventListener("click", send);
  $("#rpPick").addEventListener("click", pick);
  $("#rpCapture").addEventListener("click", capture);
  $("#rpNew").addEventListener("click", newReport);
  hide.addEventListener("change", () => {
    try {
      localStorage.setItem(HIDE_KEY, hide.checked ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  });
  try {
    hide.checked = localStorage.getItem(HIDE_KEY) !== "0";
  } catch {
    /* storage unavailable: keep the default (on) */
  }
  $("#rpShots").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (btn) removeShot(btn.dataset.remove);
  });
  document.body.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    e.preventDefault();
    if (act.dataset.act === "retry") send();
    else if (act.dataset.act === "reload") loadDraft(true);
    else if (act.dataset.act === "issue" && S.done && S.done.url && /^https:\/\//.test(S.done.url))
      api("/api/open-external", { url: S.done.url }).catch(() => {});
  });

  /* Always on top: an optimistic switch that goes back if the window refuses. */
  $("#rpPin").addEventListener("click", () => {
    const next = !S.pin;
    S.pin = next;
    render();
    api("/api/report/pin", { alwaysOnTop: next }).catch(() => {
      S.pin = !next;
      render();
    });
  });

  /* ⌘↵ sends from anywhere. Esc is left alone: nothing here is closed or cleared by it. */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });

  /* Images pasted anywhere in the page become screenshots. */
  document.addEventListener("paste", (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  /* Files dropped on the window (the native drop handler is off, so the DOM sees the File objects). A drop must
     always be cancelled, or the webview would navigate to the dropped file. */
  let dragDepth = 0;
  const hasFiles = (e) =>
    !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  const dropEl = $("#rpDrop");
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    dropEl.hidden = locked();
  });
  document.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropEl.hidden = true;
  });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropEl.hidden = true;
    addFiles(e.dataTransfer.files);
  });

  window.addEventListener("pagehide", flushOnHide);
  window.addEventListener("beforeunload", flushOnHide);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnHide();
  });

  window.addEventListener("ov-language", render);

  /* ---------- preferences the address and the boot data did not carry ---------- */
  const query = new URLSearchParams(location.search);
  const boot = window.OV_BOOT && typeof window.OV_BOOT === "object" ? window.OV_BOOT : {};
  function syncPreferences() {
    const missingTheme = !boot.theme && !query.has("theme");
    const missingDensity = !query.has("density");
    const missingLanguage = !boot.languagePreference && !query.has("language");
    if (!missingTheme && !missingDensity && !missingLanguage) return;
    api("/api/preferences")
      .then((p) => {
        if (missingTheme) OV.applyTheme(p.theme);
        if (missingDensity) OV.applyDensity(p.density);
        if (missingLanguage && typeof p.language === "string") OVI18N.setLanguage(p.language);
      })
      .catch(() => {});
  }
  syncPreferences();
  window.addEventListener("focus", syncPreferences);

  render();
  OVI18N.ready().then(render);
  loadDraft(false);
})();
