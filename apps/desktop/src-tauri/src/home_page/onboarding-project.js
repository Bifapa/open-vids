/* Onboarding step 4 — First project: the folder new projects are created in (preferences newProject.location,
   changed with the native picker, POST /api/pick-parent), a review of what the earlier steps found, and Finish. */
(function () {
  "use strict";
  const { ic, esc, api, CLICK, group } = OVS;
  const { OB, title } = OVOB;

  let note = "";
  const prefsOf = () => OB.host.prefs();
  const location = () => (prefsOf().newProject && prefsOf().newProject.location) || "";

  function review() {
    const m = OVOB.steps.models.done(),
      s = OVOB.steps.system.done();
    const line = (id, ok, what, detail) =>
      `<div class="st-prov"><span class="dot ${ok === true ? "ok" : ok === false ? "warn" : "off"}" aria-hidden="true"></span><div class="st-label"><b>${what}</b><span>${detail}</span></div><div class="st-ctl"><button type="button" class="link" data-act="ob-goto" data-v="${id}" data-fk="ob-review:${id}">${
        ok === true ? "Review" : "Set up"
      }</button></div></div>`;
    return group(
      "What’s ready",
      line(
        "models",
        m,
        "Model",
        m === true
          ? "Connected. The agents are ready."
          : "Not connected. The editor works by hand; connect one in Settings to use the agents.",
      ) +
        line(
          "system",
          s,
          "Chrome and FFmpeg",
          s === true
            ? "Found. Rendering and thumbnails will work."
            : "Not all found. Rendering may not work until they are installed.",
        ),
    );
  }

  OVOB.steps.project = {
    label: "Project",
    done: () => false,
    view: () =>
      title(
        "Your first project",
        "Every project is a folder of plain files. New ones are created in the folder below.",
      ) +
      group(
        "Projects folder",
        `<div class="st-row"><div class="st-label"><b>Location</b><span>Change it any time in Settings → General.</span></div><div class="st-ctl"><div class="loc"><span class="path" title="${esc(
          location(),
        )}">${ic("folder")}${esc(location())}</span></div><button type="button" class="btn" data-act="ob-choose" data-fk="ob-choose">Change…</button></div></div>`,
      ) +
      OVS.noteHtml(note) +
      review() +
      '<p class="st-foot">Finish opens Projects with the start box ready. You can reopen this from Help → Welcome to OpenVids.</p>',
    primary: () => ({ label: "Finish", kind: "primary" }),
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
        note = "!Couldn’t change the folder: " + err.message;
      })
      .finally(() => OVS.render(true));
  };
})();
