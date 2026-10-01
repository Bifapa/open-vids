/* Settings → Agents: the global defaults for new chats (GET/PUT /api/agent/settings: director, specialists)
   against the model catalog (GET /api/agent/models). A model whose provider is not usable gets the provider's
   own warning with a Fix link (the provider list, GET /api/agent/providers, is loaded by Models & Providers). */
(function () {
  "use strict";
  const { ic, esc, S, PAGES, CLICK, CHANGE, AGENTS, sw, seg, select, head } = OVS;

  /* null is a real state ("Default": the model's own effort), "off" switches thinking off. */
  const EFFORTS = [
    ["", "Default"],
    ["off", "Off"],
    ["low", "Low"],
    ["medium", "Med"],
    ["high", "High"],
  ];
  const EXTRA_EFFORT_LABEL = { minimal: "Min", xhigh: "XHigh", max: "Max" };

  function modelOptions(value, inherit) {
    const sel = (on) => (on ? " selected" : "");
    let html = `<option value=""${sel(!value)}>${inherit ? "Same as Director" : "Runtime default"}</option>`;
    const models = (S.catalog && S.catalog.models) || [];
    [...new Set(models.map((m) => m.provider))].forEach((p) => {
      html += `<optgroup label="${esc(OVS.providerName(p))}">${models
        .filter((m) => m.provider === p)
        .map(
          (m) =>
            `<option value="${esc(OVS.modelKey(m))}"${sel(OVS.sameModel(m, value))}>${esc(m.name)}</option>`,
        )
        .join("")}</optgroup>`;
    });
    if (value && !models.some((m) => OVS.sameModel(m, value)))
      html += `<optgroup label="${esc(OVS.providerName(value.provider))} — unavailable"><option value="${esc(
        OVS.modelKey(value),
      )}" selected>${esc(value.modelId)}</option></optgroup>`;
    return html;
  }
  const efforts = (current) =>
    current && !EFFORTS.some((e) => e[0] === current)
      ? EFFORTS.concat([[current, EXTRA_EFFORT_LABEL[current] || current]])
      : EFFORTS;

  PAGES.agents = function () {
    if (!S.agents)
      return (
        head("Agents") +
        (S.agentsError
          ? OVS.failure("The agent runtime is unavailable", S.agentsError, "agents-retry")
          : OVS.loading("agent defaults"))
      );
    const rows = AGENTS.map((ag) => {
      const dir = ag.id === "director",
        cfg = dir ? S.agents.director : S.agents.specialists[ag.id],
        on = dir || cfg.enabledByDefault;
      const provider = cfg.model ? OVS.providerById(cfg.model.provider) : null;
      const missing =
        cfg.model && S.catalog && !S.catalog.models.some((m) => OVS.sameModel(m, cfg.model));
      /* The provider's state names the problem; without it the model is just gone from the catalog. */
      const bad = OVS.providerBad(provider);
      const warn = bad
        ? OVS.providerWarn(provider)
        : missing
          ? `<span class="status warning">${ic("alert")}Model unavailable</span>`
          : "";
      return `<div class="st-row${on ? "" : " is-off"}"><div class="st-agent"><span class="st-mono" aria-hidden="true">${
        ag.mono
      }</span><div class="st-label"><b>${esc(ag.name)}</b><span>${esc(ag.role)}</span></div></div><div class="st-model-cell">${select(
        modelOptions(cfg.model, !dir),
        "agent-model",
        ag.name + " model",
        ag.id,
        bad || missing ? "is-warn" : "",
      )}${warn}</div>${seg(efforts(cfg.thinking), cfg.thinking || "", "agent-effort", ag.name + " thinking effort", ag.id)}${
        dir
          ? `<span data-tip="Director is always on" data-tip-align="end">${sw(true, "agent-on", "Director, always on", ag.id, true)}</span>`
          : sw(cfg.enabledByDefault, "agent-on", ag.name + " on by default", ag.id)
      }</div>`;
    }).join("");
    return (
      head("Agents") +
      OVS.noteHtml(S.agentsNote) +
      `<section class="st-group st-agents"><div class="sect-label"><span>Defaults for new chats</span><button type="button" class="link push" data-act="agents-reset" data-fk="agents-reset">Reset to defaults</button></div><div class="st-box"><div class="st-row st-th list-head" aria-hidden="true"><span>Agent</span><span>Model</span><span>Thinking effort</span><span>On</span></div>${rows}</div><p class="st-foot">Per-chat changes in the Chat panel override these. Models come from connected providers.</p></section>`
    );
  };

  /* Patches are built from the settings as they are when the save runs (see OVS.saveAgents). */
  const specialistPatch = (a, id, change) => ({
    specialists: { [id]: Object.assign({}, a.specialists[id], change) },
  });
  const configPatch = (a, id, change) =>
    id === "director"
      ? { director: Object.assign({}, a.director, change) }
      : specialistPatch(a, id, change);
  function parseModel(value) {
    const m = ((S.catalog && S.catalog.models) || []).find((x) => OVS.modelKey(x) === value);
    return m ? { provider: m.provider, modelId: m.modelId } : null;
  }

  CLICK["agents-retry"] = () => {
    S.agentsError = null;
    OVS.loadAgents();
  };
  CLICK["agent-effort"] = (t) => {
    const v = t.dataset.v || null,
      id = t.dataset.key;
    OVS.saveAgents((a) => configPatch(a, id, { thinking: v }));
  };
  CLICK["agent-on"] = (t) => {
    const id = t.dataset.key;
    OVS.saveAgents((a) =>
      specialistPatch(a, id, { enabledByDefault: !a.specialists[id].enabledByDefault }),
    );
  };
  CLICK["agents-reset"] = () => {
    OVS.saveAgents((a) => {
      const specialists = {};
      AGENTS.slice(1).forEach((ag) => {
        specialists[ag.id] = Object.assign({}, a.specialists[ag.id], {
          model: null,
          thinking: null,
          allowedModels: [],
          enabledByDefault: true,
        });
      });
      return { director: { model: null, thinking: null }, specialists };
    }, "Agent defaults reset.");
  };
  CHANGE["agent-model"] = (t) => {
    const model = t.value ? parseModel(t.value) : null,
      id = t.dataset.key;
    /* An unavailable model keeps its option only to show the current value; picking it again changes nothing. */
    if (t.value && !model) return;
    OVS.saveAgents((a) => configPatch(a, id, { model }));
  };
})();
