/* Onboarding step 2 — Language & theme: the app language (preference `language`: "system" or a catalog code) and
   the theme (preference `theme`: system / dark / light), the same choices as Settings → General and Appearance.
   Each choice applies at once to the page and is saved with PUT /api/preferences; a failed save puts it back. */
(function () {
  "use strict";
  const { esc, api, CLICK, CHANGE, group, row, select, opts, tr } = OVS;
  const { OB, title } = OVOB;

  let note = "";
  /* Saves are queued so a late answer never replaces a newer choice. */
  let queue = Promise.resolve();
  function save(patch, rollback) {
    note = "";
    queue = queue.then(() =>
      api("/api/preferences", patch, "PUT")
        .then((next) => OB.host.setPrefs(next))
        .catch((err) => {
          rollback();
          note = OVS.failMsg("settings.note.saveFailed", { message: OV.describeError(err) });
        })
        .finally(() => OVS.render(true)),
    );
  }

  function themeTiles() {
    /* What is on screen now (applied before the save returns), not the last saved value. */
    const theme = OV.themePref();
    return ["system", "dark", "light"]
      .map(
        (id) =>
          `<button type="button" class="st-theme" data-v="${id}" aria-pressed="${theme === id}" data-act="ob-theme" data-fk="ob-theme:${id}">${
            id === "system"
              ? '<i class="theme-dark"><span class="theme-light"></span></i>'
              : `<i class="theme-${id}"></i>`
          }${esc(tr(`settings.appearance.theme.${id}`))}</button>`,
      )
      .join("");
  }

  OVOB.steps.appearance = {
    label: "onboarding.step.appearance",
    /* Done once the user has moved past it. */
    done: () => !!OB.seen.appearance && OB.step !== "appearance",
    view: () =>
      title(tr("onboarding.appearance.title"), tr("onboarding.appearance.lede")) +
      group(
        esc(tr("onboarding.appearance.group")),
        row(
          esc(tr("settings.language.label")),
          null,
          select(
            opts(
              [["system", tr("settings.language.system")]].concat(
                OVI18N.languages().map((l) => [l.code, l.name]),
              ),
              OVI18N.preference(),
            ),
            "ob-language",
            tr("settings.language.label"),
          ),
        ) +
          row(
            esc(tr("settings.appearance.theme")),
            null,
            `<div class="st-themes" role="group" aria-label="${esc(tr("settings.appearance.theme"))}">${themeTiles()}</div>`,
          ),
      ) +
      OVS.noteHtml(note) +
      `<p class="st-foot">${esc(tr("onboarding.appearance.foot"))}</p>`,
    primary: () => ({ label: "common.continue", kind: "primary" }),
    enter: () => {
      note = "";
    },
  };

  CHANGE["ob-language"] = (t) => {
    const prev = OVI18N.preference(),
      next = t.value;
    if (next === prev) return;
    /* The language switch redraws the setup (the ov-language listener in onboarding.js). */
    OVI18N.setLanguage(next);
    save({ language: next }, () => OVI18N.setLanguage(prev));
  };
  /* The click redraws the step (settings-core wire), so the pressed tile follows at once. */
  CLICK["ob-theme"] = (t) => {
    const prev = OV.themePref(),
      next = t.dataset.v;
    if (next === prev) return;
    OV.applyTheme(next);
    save({ theme: next }, () => OV.applyTheme(prev));
  };
})();
