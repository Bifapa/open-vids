/* Settings → General and Appearance: the shared app preferences file (GET/PUT /api/preferences).
   Theme and density are applied at once to this window and (by message) to the Projects page underneath. */
(function () {
  "use strict";
  const { ic, esc, api, S, PAGES, CLICK, CHANGE, row, group, sw, seg, select, opts, head } = OVS;

  const FORMATS = [
    ["1920x1080", "1920 × 1080 · 16:9"],
    ["3840x2160", "3840 × 2160 · 16:9"],
    ["1080x1920", "1080 × 1920 · 9:16"],
    ["1080x1080", "1080 × 1080 · 1:1"],
    ["1080x1350", "1080 × 1350 · 4:5"],
  ];
  /* 23.976 and 29.97 are deliberately absent: Studio preview and export cannot honour them. */
  const FPS = [
    [24, "24 fps"],
    [25, "25 fps"],
    [30, "30 fps"],
    [60, "60 fps"],
  ];

  /* Preference saves are queued so a late answer never replaces a newer one. */
  let queue = Promise.resolve();
  function savePrefs(patch, rollback) {
    queue = queue.then(() =>
      api("/api/preferences", patch, "PUT")
        .then((next) => {
          S.prefs = next;
          S.prefsNote = "";
          OVS.post({ type: "ov-prefs", prefs: next });
        })
        .catch((err) => {
          S.prefsNote = "!Couldn’t save: " + err.message;
          if (rollback) rollback();
        })
        .finally(() => OVS.render(true)),
    );
  }
  function loadPrefs() {
    S.prefsError = null;
    return api("/api/preferences")
      .then((p) => {
        S.prefs = p;
        OV.applyDensity(p.density);
      })
      .catch((err) => {
        S.prefsError = err.message;
      })
      .finally(() => OVS.render(true));
  }

  PAGES.general = function () {
    if (!S.prefs)
      return (
        head("General") +
        (S.prefsError
          ? OVS.failure("Couldn’t load preferences", S.prefsError, "prefs-retry")
          : OVS.loading("preferences"))
      );
    const prefs = S.prefs,
      np = prefs.newProject,
      fmt = np.width + "x" + np.height;
    const formats = FORMATS.some((f) => f[0] === fmt)
      ? FORMATS
      : FORMATS.concat([[fmt, np.width + " × " + np.height + " · custom"]]);
    return (
      head("General") +
      OVS.noteHtml(S.prefsNote) +
      group(
        "New projects",
        row(
          "Location",
          null,
          `<div class="loc"><span class="path" title="${esc(np.location)}">${ic("folder")}${esc(
            np.location,
          )}</span></div><button type="button" class="btn" data-act="choose-location" data-fk="choose-location">Choose…</button>`,
        ) +
          row(
            "Open in",
            null,
            seg(
              [
                ["media", "Media"],
                ["story", "Story"],
                ["edit", "Edit"],
              ],
              np.openIn,
              "np",
              "Open new projects in",
              "openIn",
            ),
          ) +
          row("Format", null, select(opts(formats, fmt), "np-format", "Default format")) +
          row("Frame rate", null, select(opts(FPS, np.fps), "np-fps", "Default frame rate")),
        '<span class="note">Changes apply to projects you create next</span>',
      ) +
      group(
        "App",
        row(
          "On launch",
          null,
          select(
            opts(
              [
                ["last", "Reopen last project"],
                ["projects", "Show Projects"],
              ],
              prefs.onLaunch,
            ),
            "launch",
            "On launch",
          ),
        ) +
          row(
            "Confirm before moving projects to Trash",
            null,
            sw(prefs.confirmTrash, "confirm-trash", "Confirm before moving projects to Trash"),
          ) +
          row(
            "Check for updates automatically",
            null,
            sw(
              prefs.updates && prefs.updates.autoCheck,
              "auto-update",
              "Check for updates automatically",
            ),
          ),
      )
    );
  };

  PAGES.appearance = function () {
    /* What is on screen now (applied before the save returns), not the last saved value. */
    const theme = OV.themePref(),
      density = OV.densityPref();
    const tiles = [
      ["system", "Match system"],
      ["dark", "Dark"],
      ["light", "Light"],
    ]
      .map(
        (t) =>
          `<button type="button" class="st-theme" data-v="${t[0]}" aria-pressed="${theme === t[0]}" data-act="theme" data-fk="theme:${t[0]}">${
            t[0] === "system"
              ? '<i class="theme-dark"><span class="theme-light"></span></i>'
              : `<i class="theme-${t[0]}"></i>`
          }${t[1]}</button>`,
      )
      .join("");
    return (
      head("Appearance") +
      OVS.noteHtml(S.prefsNote) +
      group(
        "Interface",
        row(
          "Theme",
          null,
          `<div class="st-themes" role="group" aria-label="Theme">${tiles}</div>`,
        ) +
          row(
            "Density",
            density === "compact"
              ? "Tighter rows in panels, lists and the inspector"
              : "Comfortable rows in panels, lists and the inspector",
            seg(
              [
                ["compact", "Compact"],
                ["default", "Default"],
              ],
              density,
              "density",
              "Interface density",
            ),
          ),
      )
    );
  };

  CLICK["prefs-retry"] = () => {
    loadPrefs();
  };
  CLICK.np = (t) => savePrefs({ newProject: { [t.dataset.key]: t.dataset.v } });
  CLICK["confirm-trash"] = () => {
    if (S.prefs) savePrefs({ confirmTrash: !S.prefs.confirmTrash });
  };
  CLICK["auto-update"] = () => {
    if (S.prefs)
      savePrefs({ updates: { autoCheck: !(S.prefs.updates && S.prefs.updates.autoCheck) } });
  };
  CLICK["choose-location"] = () => {
    api("/api/pick-parent", {})
      .then((r) => {
        if (!r.cancelled) savePrefs({ newProject: { location: r.path } });
      })
      .catch((err) => {
        S.prefsNote = "!" + err.message;
        OVS.render(true);
      });
  };
  CLICK.theme = (t) => {
    const prev = OV.themePref(),
      next = t.dataset.v;
    if (next === prev) return;
    OV.applyTheme(next);
    OVS.post({ type: "ov-theme", pref: next });
    savePrefs({ theme: next }, () => {
      OV.applyTheme(prev);
      OVS.post({ type: "ov-theme", pref: prev });
    });
  };
  CLICK.density = (t) => {
    const prev = OV.densityPref(),
      next = t.dataset.v;
    if (next === prev) return;
    OV.applyDensity(next);
    OVS.post({ type: "ov-density", pref: next });
    savePrefs({ density: next }, () => {
      OV.applyDensity(prev);
      OVS.post({ type: "ov-density", pref: prev });
    });
  };
  CHANGE["np-format"] = (t) => {
    const [w, h] = t.value.split("x").map(Number);
    savePrefs({ newProject: { width: w, height: h } });
  };
  CHANGE["np-fps"] = (t) => savePrefs({ newProject: { fps: Number(t.value) } });
  CHANGE.launch = (t) => savePrefs({ onLaunch: t.value });

  OVS.loadPrefs = loadPrefs;
})();
