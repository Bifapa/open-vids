/* Onboarding step 2 — Connect a model. The provider rows, key form and sign-in panel are the Models & Providers
   ones (settings-providers.js / settings-signin.js), drawn here as they are in Settings; this file only decides
   which providers show and what the step says. A model is optional: the manual editor works without one. */
(function () {
  "use strict";
  const { esc, ui, S, CLICK, group } = OVS;
  const { title } = OVOB;

  /* The well-known providers that lead the list; every other one is behind "Show all providers". */
  const FEATURED = ["anthropic", "openai", "google", "openrouter"];

  /* Connected and usable. A local provider (Ollama) answers "connected" with nothing to use, so it counts only
     once it lists models. */
  const connected = () =>
    (S.providers || []).filter((p) => p.status === "connected" && (!p.keyless || p.modelCount > 0));

  function list() {
    const all = OVS.providerList();
    const lead = FEATURED.map((id) => all.find((p) => p.id === id)).filter(Boolean);
    const rest = all.filter((p) => !FEATURED.includes(p.id));
    const showAll = !!ui.flags.showAllProviders;
    const more = rest.length
      ? `<div class="st-sub"><button type="button" class="link" data-act="providers-all" aria-expanded="${showAll}" data-fk="providers-all">${
          showAll ? "Hide other providers" : `Show all providers (${rest.length} more)`
        }</button></div>`
      : "";
    return group(
      "Providers",
      lead.map(OVS.providerRow).join("") +
        more +
        (showAll ? rest.map(OVS.providerRow).join("") : ""),
    );
  }

  OVOB.steps.models = {
    label: "Model",
    skipWhenDone: true,
    done: () => (S.providers ? connected().length > 0 : null),
    load: () => {
      OVS.loadProviders();
    },
    enter: () => {
      OVS.signin.onEnter();
    },
    leave: () => OVS.signin.stop(),
    stop: () => OVS.signin.stop(),
    view() {
      const head = title(
        "Connect a model",
        "The agents need a model from an AI provider. Sign in to one, or add an API key.",
      );
      const foot =
        '<p class="st-foot">Your key or sign-in is stored on this Mac. The frames and transcripts the agents look at are sent to the provider you choose.</p>';
      if (!S.providers)
        return (
          head +
          (S.providersError
            ? OVS.failure(
                "The agent runtime is unavailable",
                S.providersError,
                "ob-providers-retry",
              )
            : OVS.loading("providers")) +
          '<p class="st-foot">You can skip this step: the editor works by hand without a model.</p>'
        );
      const names = connected().map((p) => `<span class="ob-names">${esc(p.name)}</span>`);
      const show = names.length === 0 || ui.flags.obMore;
      return (
        head +
        (names.length
          ? group(
              "Connected",
              `<div class="st-prov" data-ob-connected><span class="dot ok" aria-hidden="true"></span><div class="st-label"><b>Already connected: ${names.join(", ")}</b><span>The agents can use ${
                names.length === 1 ? "its" : "their"
              } models.</span></div>${
                show
                  ? ""
                  : '<div class="st-ctl"><button type="button" class="btn" data-act="ob-more" data-fk="ob-more">Connect another</button></div>'
              }</div>`,
            )
          : "") +
        (show ? list() : "") +
        OVS.noteHtml(ui.flags.providersNote) +
        foot +
        (names.length
          ? ""
          : '<p class="st-foot">You can skip this step: the editor works by hand without a model, and you can connect one later in Settings.</p>')
      );
    },
    primary: () =>
      connected().length
        ? { label: "Continue", kind: "primary" }
        : { label: "Continue without a model", kind: "secondary" },
  };
  CLICK["ob-providers-retry"] = () => {
    OVS.loadProviders();
  };
  CLICK["ob-more"] = () => {
    ui.flags.obMore = true;
  };
})();
