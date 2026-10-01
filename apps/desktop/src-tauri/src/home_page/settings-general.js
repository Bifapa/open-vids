/* Settings → General and Appearance: the shared app preferences file (GET/PUT /api/preferences).
   Theme and density are applied at once to this window and (by message) to the Projects page underneath. */
(function () {
  "use strict";
  const { ic, esc, api, S, PAGES, CLICK, CHANGE, tr, row, group, sw, seg, select, opts, head } =
    OVS;
  /* Escaped text of a catalog message, for the helpers that take markup. */
  const te = (key, params) => esc(tr(key, params));

  /* Sizes are data (width × height · ratio); every word around them is a message. */
  const FORMATS = [
    ["1920x1080", "1920 × 1080 · 16:9"],
    ["3840x2160", "3840 × 2160 · 16:9"],
    ["1080x1920", "1080 × 1920 · 9:16"],
    ["1080x1080", "1080 × 1080 · 1:1"],
    ["1080x1350", "1080 × 1350 · 4:5"],
  ];
  /* 23.976 and 29.97 are deliberately absent: Studio preview and export cannot honour them. */
  const FPS = [24, 25, 30, 60];

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
          S.prefsNote = OVS.failMsg("settings.note.saveFailed", { message: err.message });
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
    const title = tr("settings.section.general");
    if (!S.prefs)
      return (
        head(title) +
        (S.prefsError
          ? OVS.failure("settings.failure.preferences", S.prefsError, "prefs-retry")
          : OVS.loading("settings.loading.preferences"))
      );
    const prefs = S.prefs,
      np = prefs.newProject,
      fmt = np.width + "x" + np.height;
    const formats = FORMATS.some((f) => f[0] === fmt)
      ? FORMATS
      : FORMATS.concat([
          [
            fmt,
            tr("settings.general.format.custom", {
              width: String(np.width),
              height: String(np.height),
            }),
          ],
        ]);
    const fpsOptions = FPS.map((n) => [n, tr("settings.general.fps", { fps: n })]);
    return (
      head(title) +
      OVS.noteHtml(S.prefsNote) +
      group(
        te("settings.general.group.newProjects"),
        row(
          te("settings.general.location"),
          null,
          `<div class="loc"><span class="path" title="${esc(np.location)}">${ic("folder")}${esc(
            np.location,
          )}</span></div><button type="button" class="btn" data-act="choose-location" data-fk="choose-location">${te(
            "settings.general.chooseLocation",
          )}</button>`,
        ) +
          row(
            te("settings.general.openIn"),
            null,
            seg(
              [
                ["media", tr("settings.general.openIn.media")],
                ["story", tr("settings.general.openIn.story")],
                ["edit", tr("settings.general.openIn.edit")],
              ],
              np.openIn,
              "np",
              tr("settings.general.openIn.aria"),
              "openIn",
            ),
          ) +
          row(
            te("settings.general.format"),
            null,
            select(opts(formats, fmt), "np-format", tr("settings.general.format.aria")),
          ) +
          row(
            te("settings.general.frameRate"),
            null,
            select(opts(fpsOptions, np.fps), "np-fps", tr("settings.general.frameRate.aria")),
          ),
        `<span class="note">${te("settings.general.newProjectsNote")}</span>`,
      ) +
      group(
        te("settings.general.group.app"),
        row(
          OVI18N.t("settings.language.label"),
          null,
          select(
            opts(
              [["system", OVI18N.t("settings.language.system")]].concat(
                OVI18N.languages().map((l) => [l.code, l.name]),
              ),
              prefs.language || "system",
            ),
            "language",
            OVI18N.t("settings.language.label"),
          ),
        ) +
          row(
            te("settings.general.onLaunch"),
            null,
            select(
              opts(
                [
                  ["last", tr("settings.general.onLaunch.last")],
                  ["projects", tr("settings.general.onLaunch.projects")],
                ],
                prefs.onLaunch,
              ),
              "launch",
              tr("settings.general.onLaunch"),
            ),
          ) +
          row(
            te("settings.general.confirmTrash"),
            null,
            sw(prefs.confirmTrash, "confirm-trash", tr("settings.general.confirmTrash")),
          ) +
          row(
            te("settings.general.autoUpdate"),
            null,
            sw(
              prefs.updates && prefs.updates.autoCheck,
              "auto-update",
              tr("settings.general.autoUpdate"),
            ),
          ),
      )
    );
  };

  PAGES.appearance = function () {
    /* What is on screen now (applied before the save returns), not the last saved value. */
    const theme = OV.themePref(),
      density = OV.densityPref();
    const tiles = ["system", "dark", "light"]
      .map(
        (id) =>
          `<button type="button" class="st-theme" data-v="${id}" aria-pressed="${theme === id}" data-act="theme" data-fk="theme:${id}">${
            id === "system"
              ? '<i class="theme-dark"><span class="theme-light"></span></i>'
              : `<i class="theme-${id}"></i>`
          }${te(`settings.appearance.theme.${id}`)}</button>`,
      )
      .join("");
    return (
      head(tr("settings.section.appearance")) +
      OVS.noteHtml(S.prefsNote) +
      group(
        te("settings.appearance.group.interface"),
        row(
          te("settings.appearance.theme"),
          null,
          `<div class="st-themes" role="group" aria-label="${te("settings.appearance.theme")}">${tiles}</div>`,
        ) +
          row(
            te("settings.appearance.density"),
            density === "compact"
              ? te("settings.appearance.density.hint.compact")
              : te("settings.appearance.density.hint.default"),
            seg(
              [
                ["compact", tr("settings.appearance.density.compact")],
                ["default", tr("settings.appearance.density.default")],
              ],
              density,
              "density",
              tr("settings.appearance.density.aria"),
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
  CHANGE.language = (t) => {
    const prev = (S.prefs && S.prefs.language) || "system";
    if (t.value === prev) return;
    OVI18N.setLanguage(t.value);
    OVS.post({ type: "ov-language", pref: t.value });
    savePrefs({ language: t.value }, () => {
      OVI18N.setLanguage(prev);
      OVS.post({ type: "ov-language", pref: prev });
    });
  };
  /* The catalog loaded or the language changed: the General page's language row follows. */
  window.addEventListener("ov-language", () => OVS.render(true));

  OVS.loadPrefs = loadPrefs;
})();
