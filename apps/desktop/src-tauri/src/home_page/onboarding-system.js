/* Onboarding step 3 — System check. GET /api/system/check lists Chrome, FFmpeg and ffprobe; a missing tool with
   `canInstall` gets an Install button driven by GET/POST /api/system/install/<tool> (+ /cancel), polled while it
   runs. The tool row is generic: it lights up for any tool whose check says canInstall and whose install state
   arrives in `install[<tool>]`. FFmpeg is installed only through Homebrew and provides ffprobe too, so the two
   are one install (ffprobe has no button of its own). Every string from the check or the installer is escaped. */
(function () {
  "use strict";
  const { ic, esc, api, CLICK, group } = OVS;
  const { title } = OVOB;

  /* `with`: the tool whose installer provides this one. */
  const TOOLS = [
    { id: "chrome", name: "Chrome", why: "Renders your video and captures project thumbnails." },
    { id: "ffmpeg", name: "FFmpeg", why: "Encodes and decodes video and audio when rendering." },
    {
      id: "ffprobe",
      name: "ffprobe",
      why: "Reads the length, size and format of imported media.",
      with: "ffmpeg",
    },
  ];
  /* What to run by hand when the page can't install (macOS: Homebrew). */
  const COMMANDS = { ffmpeg: "brew install ffmpeg" };
  const SOURCES = {
    openvids: "installed by OpenVids",
    env: "set by an environment variable",
    system: "found on this Mac",
  };
  const RUNNING = ["checking", "downloading", "installing"];
  const POLL_MS = 500;

  /* check: the last answer · inst: install state per tool · error: why the check couldn't run. */
  const Y = { check: null, error: null, loading: false, inst: {}, copied: null };
  const running = (key) => !!Y.inst[key] && RUNNING.includes(Y.inst[key].phase);
  /* An install state has its own `error` text: its body is data even when it says so. */
  const call = (path, method) => api(path, undefined, method, { plainBody: true });
  const route = (key) => `/api/system/install/${encodeURIComponent(key)}`;

  /* ---------- data ---------- */
  function check() {
    if (Y.loading) return;
    Y.loading = true;
    Y.error = null;
    OVS.render(true);
    api("/api/system/check")
      .then((res) => {
        Y.check = res;
        const inst = (res && res.install) || {};
        Object.keys(inst).forEach((k) => {
          Y.inst[k] = inst[k];
        });
      })
      .catch((err) => {
        Y.error = err.message;
      })
      .finally(() => {
        Y.loading = false;
        OVS.render(true);
        schedule(0);
      });
  }

  /* ---------- polling: one timer, only while an install runs, this step shows and the window is visible ---------- */
  let timer = null,
    polling = false;
  const runningKeys = () => Object.keys(Y.inst).filter(running);
  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function schedule(delay) {
    stop();
    if (!runningKeys().length || !OVOB.isStep("system") || document.hidden) return;
    timer = setTimeout(tick, delay == null ? POLL_MS : delay);
  }
  function tick() {
    timer = null;
    if (polling) return;
    polling = true;
    let finished = false;
    Promise.all(
      runningKeys().map((key) =>
        call(route(key), "GET")
          .then((st) => {
            const before = Y.inst[key] && Y.inst[key].phase;
            Y.inst[key] = st;
            if (RUNNING.includes(before) && st.phase === "done") finished = true;
          })
          .catch((err) => {
            Y.inst[key] = {
              phase: "failed",
              error: "Lost contact with the installer: " + err.message,
            };
          }),
      ),
    ).finally(() => {
      polling = false;
      OVS.render(true);
      /* Installed: look again, so the row shows the path and version it found. */
      if (finished) {
        Y.loading = false;
        check();
      } else schedule();
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) schedule(0);
    else stop();
  });
  window.addEventListener("pagehide", stop);

  function install(key) {
    if (running(key)) return;
    Y.inst[key] = { phase: "checking", downloaded: null, total: null, error: null, detail: null };
    call(route(key), "POST")
      .then((st) => {
        Y.inst[key] = st;
      })
      .catch((err) => {
        Y.inst[key] = { phase: "failed", error: err.message };
      })
      .finally(() => {
        OVS.render(true);
        schedule(0);
      });
  }
  function cancel(key) {
    call(`${route(key)}/cancel`, "POST")
      .then((st) => {
        Y.inst[key] = st;
      })
      .catch(() => {
        Y.inst[key] = { phase: "cancelled", error: null };
      })
      .finally(() => OVS.render(true));
  }

  /* ---------- markup ---------- */
  const loaderSrc = () =>
    document.documentElement.dataset.theme === "light"
      ? "/assets/mark-loader-light.svg"
      : "/assets/mark-loader.svg";
  function phaseText(st) {
    if (st.phase === "checking") return "Checking…";
    if (st.phase === "installing") return "Installing…";
    if (st.phase === "downloading") {
      const d = Number(st.downloaded),
        t = Number(st.total);
      if (t > 0 && d >= 0) return `Downloading · ${OV.formatBytes(d)} of ${OV.formatBytes(t)}`;
      if (d > 0) return `Downloading · ${OV.formatBytes(d)}`;
      return "Downloading…";
    }
    return "";
  }
  function runBlock(st) {
    const t = Number(st.total),
      d = Number(st.downloaded);
    const pct = t > 0 && d >= 0 ? Math.min(100, Math.round((d / t) * 100)) : null;
    return `<div class="ob-run" role="status"><img class="ob-loader" src="${loaderSrc()}" alt="" /><span class="st-preset-note">${esc(
      phaseText(st),
    )}</span></div>${
      pct == null
        ? ""
        : `<div class="ob-bar" role="progressbar" aria-label="Download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>`
    }${st.detail ? `<p class="ob-detail" title="${esc(st.detail)}">${esc(st.detail)}</p>` : ""}`;
  }
  /* The check says what Homebrew would run and what to tell the user; the constants are only a fallback. */
  const brew = () => (Y.check && Y.check.homebrew) || {};
  const commandFor = (key) =>
    key === "ffmpeg" ? brew().installCommand || COMMANDS.ffmpeg : COMMANDS[key];
  const copyRow = (cmd, key) =>
    `<div class="st-inline"><code class="ob-cmd">${esc(cmd)}</code><button type="button" class="btn btn-sm" data-act="ob-copy" data-v="${esc(
      cmd,
    )}" data-fk="ob-copy:${esc(key)}">${Y.copied === cmd ? "Copied" : "Copy"}</button></div>`;

  function toolRow(t) {
    const c = Y.check[t.id] || {},
      key = t.with || t.id,
      parent = t.with ? Y.check[t.with] || {} : null,
      st = Y.inst[key];
    const label = `<div class="st-label"><b>${esc(t.name)}</b><span>${esc(t.why)}</span>`;
    if (c.found) {
      const bits = [c.version && "version " + c.version, c.source && SOURCES[c.source]].filter(
        Boolean,
      );
      return `<div class="ob-tool">${label}${c.path ? `<span class="mono" title="${esc(c.path)}">${esc(c.path)}</span>` : ""}${
        bits.length ? `<span>${esc(bits.join(" · "))}</span>` : ""
      }</div><div class="st-ctl"><span class="status success">${ic("check")}Found</span></div></div>`;
    }
    /* Missing: what is happening, or what can be done. */
    let ctl = "",
      extra = "",
      sub = "";
    const own = !t.with || (parent && parent.found); /* ffprobe installs through FFmpeg's button */
    const canInstall = own && !!c.canInstall;
    if (t.with && !own) {
      sub = `<span>Comes with ${esc(TOOLS.find((x) => x.id === t.with).name)}.</span>`;
    }
    if (c.systemPath && !c.found)
      sub += `<span>Chrome is at <span class="mono">${esc(c.systemPath)}</span>, but rendering can’t use that copy.</span>`;
    if (st && RUNNING.includes(st.phase)) {
      ctl = own
        ? `<button type="button" class="btn" data-act="ob-sys-cancel" data-v="${esc(key)}" data-fk="ob-sys-cancel:${esc(key)}">Cancel</button>`
        : `<span class="st-preset-note"><i class="spinner" aria-hidden="true"></i>Installing…</span>`;
      if (own) extra = runBlock(st);
    } else {
      const failed = own && !!st && st.phase === "failed",
        cancelled = own && !!st && st.phase === "cancelled";
      const button = canInstall
        ? `<button type="button" class="btn" data-act="ob-sys-install" data-v="${esc(key)}" data-fk="ob-sys-install:${esc(key)}">${
            failed ? "Try again" : c.installer === "homebrew" ? "Install with Homebrew" : "Install"
          }</button>`
        : "";
      ctl = `<span class="status ${failed ? "error" : "warning"}">${ic("alert")}${
        failed ? "Install failed" : cancelled ? "Cancelled" : "Missing"
      }</span>${button}`;
      if (failed)
        extra += `<p class="st-field-err" role="alert">${esc(String((st && st.error) || "The install failed."))}</p>`;
      if (canInstall && c.installer === "homebrew" && !failed)
        extra += `<p class="st-foot">${
          brew().note
            ? esc(brew().note).replace(/`([^`]*)`/g, '<code class="mono">$1</code>')
            : `Runs <code class="mono">${esc(commandFor("ffmpeg"))}</code>, which can install several dependency packages and take a few minutes. FFmpeg includes ffprobe.`
        }</p>`;
      /* By hand: no installer here, or the installer failed. */
      const cmd = own && Y.check.platform === "macos" ? commandFor(key) : null;
      if (cmd && (!canInstall || failed)) {
        extra +=
          copyRow(cmd, key) +
          `<p class="st-foot">${failed ? "Or run it" : "Run it"} in Terminal, then press Check again.${
            c.installer == null && !canInstall && key === "ffmpeg"
              ? ' Homebrew isn’t installed: <button type="button" class="link" data-act="ob-open-brew" data-fk="ob-open-brew">Get Homebrew</button>.'
              : ""
          }</p>`;
      } else if (own && !canInstall && !cmd && !t.with)
        extra += `<p class="st-foot">Install ${esc(t.name)} yourself, then press Check again.</p>`;
    }
    return `<div class="ob-tool">${label}${sub}</div><div class="st-ctl">${ctl}</div>${
      extra ? `<div class="ob-tool-extra">${extra}</div>` : ""
    }</div>`;
  }

  const allFound = () => TOOLS.every((t) => Y.check && Y.check[t.id] && Y.check[t.id].found);

  OVOB.steps.system = {
    label: "System",
    skipWhenDone: true,
    done: () => (Y.check ? allFound() : Y.error ? false : null),
    load: () => check(),
    enter: () => {
      if (!Y.loading) check();
    },
    leave: stop,
    stop,
    view() {
      const head = title(
        "System check",
        "OpenVids needs Chrome and FFmpeg to render your video and make thumbnails.",
      );
      const speech =
        '<p class="st-foot">Speech recognition downloads its model the first time you use it.</p>';
      const meta = `<button type="button" class="btn btn-sm push" data-act="ob-sys-check" data-fk="ob-sys-check"${
        Y.loading ? " disabled" : ""
      }>${Y.loading ? '<i class="spinner" aria-hidden="true"></i>Checking…' : "Check again"}</button>`;
      if (!Y.check)
        return (
          head +
          (Y.error
            ? OVS.failure("Couldn’t run the system check", Y.error, "ob-sys-check") +
              '<p class="st-foot">You can continue; OpenVids will tell you when something it needs is missing.</p>'
            : OVS.loading("the system check")) +
          speech
        );
      return (
        head +
        OVS.noteHtml(Y.error ? "!Couldn’t check again: " + Y.error : "") +
        group("Tools", TOOLS.map(toolRow).join(""), meta) +
        speech
      );
    },
    primary: () => ({ label: "Continue", kind: Y.check && allFound() ? "primary" : "secondary" }),
  };

  CLICK["ob-sys-check"] = () => {
    check();
    return false;
  };
  CLICK["ob-sys-install"] = (t) => install(t.dataset.v);
  CLICK["ob-sys-cancel"] = (t) => cancel(t.dataset.v);
  CLICK["ob-open-brew"] = () => {
    /* Opened by the shell only if it is an https address. */
    api("/api/open-external", { url: brew().url || "https://brew.sh" }).catch(() => {});
  };
  CLICK["ob-copy"] = (t) => {
    const cmd = t.dataset.v;
    const done = (ok) => {
      Y.copied = ok ? cmd : null;
      OVS.render(true);
      setTimeout(() => {
        Y.copied = null;
        if (OVOB.isStep("system")) OVS.render(true);
      }, 1500);
    };
    try {
      navigator.clipboard.writeText(cmd).then(
        () => done(true),
        () => done(false),
      );
    } catch {
      done(false);
    }
  };
})();
