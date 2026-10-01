/* Onboarding step 4 — First project: the folder new projects are created in (preferences newProject.location,
   changed with the native picker, POST /api/pick-parent), a review of what the earlier steps found, and Finish. */
(function () {
  "use strict";
  const { ic, esc, api, CLICK, group, tr } = OVS;
  const { OB, title } = OVOB;

  let note = "";
  const prefsOf = () => OB.host.prefs();
  const location = () => (prefsOf().newProject && prefsOf().newProject.location) || "";

  /* what and detail are catalog keys. */
  function review() {
    const m = OVOB.steps.models.done(),
      s = OVOB.steps.system.done();
    const line = (id, ok, what, detail) =>
      `<div class="st-prov"><span class="dot ${ok === true ? "ok" : ok === false ? "warn" : "off"}" aria-hidden="true"></span><div class="st-label"><b>${esc(tr(what))}</b><span>${esc(tr(detail))}</span></div><div class="st-ctl"><button type="button" class="link" data-act="ob-goto" data-v="${id}" data-fk="ob-review:${id}">${esc(
        tr(ok === true ? "onboarding.project.review" : "onboarding.project.setUp"),
      )}</button></div></div>`;
    return group(
      esc(tr("onboarding.project.group.ready")),
      line(
        "models",
        m,
        "onboarding.project.review.model",
        m === true
          ? "onboarding.project.review.model.ready"
          : "onboarding.project.review.model.missing",
      ) +
        line(
          "system",
          s,
          "onboarding.project.review.system",
          s === true
            ? "onboarding.project.review.system.ready"
            : "onboarding.project.review.system.missing",
        ),
    );
  }

  OVOB.steps.project = {
    label: "onboarding.step.project",
    done: () => false,
    view: () =>
      title(tr("onboarding.project.title"), tr("onboarding.project.lede")) +
      group(
        esc(tr("onboarding.project.group.folder")),
        `<div class="st-row"><div class="st-label"><b>${esc(tr("onboarding.project.location"))}</b><span>${esc(tr("onboarding.project.location.hint"))}</span></div><div class="st-ctl"><div class="loc"><span class="path" title="${esc(
          location(),
        )}">${ic("folder")}${esc(location())}</span></div><button type="button" class="btn" data-act="ob-choose" data-fk="ob-choose">${esc(tr("onboarding.project.change"))}</button></div></div>`,
      ) +
      OVS.noteHtml(note) +
      review() +
      `<p class="st-foot">${esc(tr("onboarding.project.foot"))}</p>`,
    primary: () => ({ label: "onboarding.project.finish", kind: "primary" }),
    enter: () => {
      note = "";
    },
  };
  CLICK["ob-choose"] = () => {
    api("/api/pick-parent", {})
      .then((r) => {
        if (r.cancelled) return null;
        return api("/api/preferences", { newProject: { location: r.path } }, "PUT").then((next) =>
          OB.host.setPrefs(next),
        );
      })
      .catch((err) => {
        note = OVS.failMsg("onboarding.project.changeFailed", { message: err.message });
      })
      .finally(() => OVS.render(true));
  };
})();
