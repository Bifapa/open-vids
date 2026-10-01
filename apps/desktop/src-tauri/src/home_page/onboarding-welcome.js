/* Onboarding step 1 — Welcome: what OpenVids is, in three short facts. Nothing to configure. */
(function () {
  "use strict";
  const { ic } = OVS;
  const { OB, title, mark } = OVOB;

  const fact = (icon, name, text) =>
    `<div class="st-row">${ic(icon)}<div class="st-label"><b>${name}</b><span>${text}</span></div></div>`;

  OVOB.steps.welcome = {
    label: "Welcome",
    /* Done once the user has moved past it. */
    done: () => !!OB.seen.welcome && OB.step !== "welcome",
    view: () =>
      mark +
      title(
        "Welcome to OpenVids",
        "A video editor you work in together with AI agents, by chat. Describe what you want; the agents cut, time and review it with you on the timeline.",
      ) +
      `<section class="st-group"><div class="st-box ob-facts">${
        fact(
          "agents",
          "You and the agents, in one chat",
          "Ask for an edit or a whole video. The Director plans it and its specialists do the cutting, titles and audio. You can step in by hand at any point.",
        ) +
        fact(
          "shield",
          "Everything runs on this Mac",
          "The editor, rendering and your files stay local. AI requests go only to the provider you connect.",
        ) +
        fact(
          "folder",
          "A project is a folder",
          "Plain files in a folder you choose: open them in Finder, copy them, back them up.",
        )
      }</div></section>`,
    primary: () => ({ label: "Get started", kind: "primary" }),
  };
})();
