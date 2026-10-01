/* Settings → Execution: the default Execution Quality for chats that haven't chosen their own
   (agents.executionQuality {preset, custom} in the global agent settings, GET/PUT /api/agent/settings) and the
   Autonomy group (agents.autonomy {defaultIntent, askBeforeLockedEdits, askBeforeDownloads}, same route). */
(function () {
  "use strict";
  const { esc, S, PAGES, CLICK, CHANGE, row, group, sw, seg, stepper, head } = OVS;

  /* This page has no build step, so the budget model is restated here. KEEP IN SYNC with
       packages/agent-protocol/src/qa.ts      (EXECUTION_BUDGET_RANGES, EXECUTION_BUDGETS, SPECIALIST_THINKING_POLICIES,
                                               clampExecutionBudget, resolveExecutionBudget)
       packages/studio/src/components/chat/qaLabels.ts (labels, hints, describeBudget)
       packages/studio/src/components/chat/ExecutionBudgetFields.tsx (QA_ONLY, passesHint)
     The runtime clamps and validates every budget it receives, so a drift can only make this page refuse a value
     the runtime would take (or the reverse), never store a bad one. */
  const RANGES = {
    qaPasses: { min: 0, max: 5 },
    qaFramesPerMinute: { min: 2, max: 60 },
    qaMaxFrames: { min: 4, max: 96 },
    critiqueRounds: { min: 1, max: 4 },
    analysisFramesPerSource: { min: 8, max: 120 },
    researchCandidates: { min: 2, max: 24 },
  };
  const PRESETS = {
    fast: {
      qaPasses: 1,
      qaFramesPerMinute: 6,
      qaMaxFrames: 12,
      critiqueRounds: 1,
      analysisFramesPerSource: 16,
      researchCandidates: 4,
      specialistThinking: "economy",
    },
    balanced: {
      qaPasses: 2,
      qaFramesPerMinute: 12,
      qaMaxFrames: 24,
      critiqueRounds: 2,
      analysisFramesPerSource: 40,
      researchCandidates: 8,
      specialistThinking: "configured",
    },
    best: {
      qaPasses: 3,
      qaFramesPerMinute: 24,
      qaMaxFrames: 48,
      critiqueRounds: 3,
      analysisFramesPerSource: 80,
      researchCandidates: 16,
      specialistThinking: "thorough",
    },
  };
  const QUALITY = [
    ["fast", "Fast"],
    ["balanced", "Balanced"],
    ["best", "Best"],
    ["custom", "Custom"],
  ];
  const QUALITY_NOTE = {
    fast: "Quickest. One render check, no correction round.",
    balanced: "The default for most edits. Checks the render and corrects once.",
    best: "Slowest and most thorough. Three QA passes, deeper research.",
    custom: "Your own budget, field by field.",
  };
  const THINKING = [
    ["economy", "Economy"],
    ["configured", "As configured"],
    ["thorough", "Thorough"],
  ];
  const THINKING_HINT = {
    economy: "Specialists think at most Low.",
    configured: "Specialists think as you configured them.",
    thorough: "Specialists think at least High.",
  };
  /* Numeric budget fields as rows, in the order Studio shows them (render QA passes is the stepper above). */
  const FIELDS = [
    {
      field: "qaFramesPerMinute",
      label: "Vision frames per minute",
      hint: "How densely Vision samples the rendered video.",
      qaOnly: true,
    },
    {
      field: "qaMaxFrames",
      label: "Vision frames per pass",
      hint: "The most frames Vision looks at in one pass.",
      qaOnly: true,
    },
    {
      field: "analysisFramesPerSource",
      label: "Analysis frames per source",
      hint: "Frames Vision inspects per source file when analysing long footage.",
    },
    {
      field: "researchCandidates",
      label: "Research candidates",
      hint: "Candidates Research compares per search.",
    },
  ];
  const CRITIQUE_HINT = "How often Vision may ask for a closer look in one pass.";
  /* Autonomy: packages/agent-protocol AutonomySettings. Mode copy matches the composer's Mode chip. */
  const MODES = [
    ["plan", "Plan", "Proposes a plan first"],
    ["edit", "Edit", "Acts on the timeline"],
    ["ask", "Ask", "Answers only"],
  ];
  const AUTONOMY_DEFAULTS = {
    defaultIntent: "plan",
    askBeforeLockedEdits: true,
    askBeforeDownloads: true,
  };

  const clamp = (field, n) =>
    Math.min(RANGES[field].max, Math.max(RANGES[field].min, Math.round(n)));
  function clampBudget(b) {
    const out = Object.assign({}, b);
    Object.keys(RANGES).forEach((f) => {
      out[f] = clamp(f, Number(b[f]));
    });
    return out;
  }
  /* The budget a chat without its own choice runs with. */
  const resolve = (eq) =>
    eq.preset === "custom" ? clampBudget(eq.custom) : Object.assign({}, PRESETS[eq.preset]);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function passesHint(passes) {
    if (passes === 0) return "Render QA is off: the agent does not render and check its work.";
    if (passes === 1) return "One render, checked and reported; no automatic correction.";
    return `Up to ${passes} renders, each checked; at most ${plural(passes - 1, "correction", "corrections")} in between.`;
  }

  function summary(b) {
    const items = [];
    if (b.qaPasses > 0) {
      items.push(`Vision <b>${b.qaFramesPerMinute} frames/min, max ${b.qaMaxFrames}</b>`);
      items.push(`Critique <b>${plural(b.critiqueRounds, "round", "rounds")}</b>`);
    }
    items.push(`Research <b>${plural(b.researchCandidates, "candidate", "candidates")}</b>`);
    const policy = THINKING.find((t) => t[0] === b.specialistThinking);
    items.push(`Thinking <b>${esc(policy ? policy[1] : b.specialistThinking)}</b>`);
    return `<div class="st-sub"><div class="st-summary">${items
      .map((i) => `<span>${i}</span>`)
      .join(
        "",
      )}<button type="button" class="link" data-act="customize" data-fk="customize">Customize</button></div></div>`;
  }
  const field = (name) => FIELDS.find((f) => f.field === name);
  /* Every real budget field in the prototype's custom-rows style (Studio's order; render QA passes is the stepper above). */
  function customRows(b) {
    const qaOff = b.qaPasses === 0;
    return (
      '<div class="st-sub is-flush">' +
      numRow(field("qaFramesPerMinute"), b, qaOff) +
      numRow(field("qaMaxFrames"), b, qaOff) +
      row(
        "Critique rounds",
        `${CRITIQUE_HINT} ${RANGES.critiqueRounds.min}–${RANGES.critiqueRounds.max}.${
          qaOff ? " Unused while render QA is off." : ""
        }`,
        seg(
          [1, 2, 3, 4].map((n) => [n, String(n)]),
          b.critiqueRounds,
          "exec-critique",
          "Critique rounds",
          null,
          qaOff,
        ),
        qaOff ? "is-disabled" : "",
      ) +
      numRow(field("analysisFramesPerSource"), b, false) +
      numRow(field("researchCandidates"), b, false) +
      row(
        "Specialist thinking",
        esc(THINKING_HINT[b.specialistThinking] || ""),
        seg(THINKING, b.specialistThinking, "exec-thinking", "Specialist thinking"),
      ) +
      "</div>"
    );
  }
  function numRow(f, b, qaOff) {
    const unused = qaOff && f.qaOnly;
    const r = RANGES[f.field];
    return row(
      esc(f.label),
      `${esc(f.hint)} ${r.min}–${r.max}.${unused ? " Unused while render QA is off." : ""}`,
      `<input class="input mono st-num" type="number" inputmode="numeric" min="${r.min}" max="${r.max}" step="1" value="${b[f.field]}" aria-label="${esc(
        f.label,
      )}" data-act="exec-num" data-key="${f.field}" data-fk="exec-num:${f.field}"${unused ? " disabled" : ""} />`,
      unused ? "is-disabled" : "",
    );
  }

  PAGES.execution = function () {
    if (!S.agents)
      return (
        head("Execution") +
        (S.agentsError
          ? OVS.failure("The agent runtime is unavailable", S.agentsError, "agents-retry")
          : OVS.loading("execution settings"))
      );
    const eq = S.agents.executionQuality,
      b = resolve(eq),
      custom = eq.preset === "custom";
    const au = Object.assign({}, AUTONOMY_DEFAULTS, S.agents.autonomy);
    return (
      head("Execution") +
      OVS.noteHtml(S.agentsNote) +
      group(
        "Quality",
        row(
          "Execution quality",
          esc(QUALITY_NOTE[eq.preset] || ""),
          seg(QUALITY, eq.preset, "quality", "Default execution quality"),
        ) +
          row(
            "Render QA passes",
            esc(passesHint(b.qaPasses)),
            stepper(
              b.qaPasses,
              RANGES.qaPasses.min,
              RANGES.qaPasses.max,
              "exec-qa",
              "Render QA passes",
            ),
          ) +
          (custom ? customRows(b) : summary(b)),
      ) +
      '<p class="st-foot">How hard agents work in chats that have no choice of their own. A chat’s Execution quality control overrides this.</p>' +
      group(
        "Autonomy",
        row(
          "Default chat mode",
          esc(MODES.find((m) => m[0] === au.defaultIntent)[2]),
          seg(
            MODES.map((m) => [m[0], m[1]]),
            au.defaultIntent,
            "auto-intent",
            "Default chat mode",
          ),
        ) +
          row(
            "Ask before changing locked or hand-edited sections",
            au.askBeforeLockedEdits
              ? "Agents stop and ask before touching them."
              : "Agents leave them as they are, carry on and report what they skipped. Locked material is never changed either way.",
            sw(
              au.askBeforeLockedEdits,
              "auto-sw",
              "Ask before changing locked or hand-edited sections",
              "askBeforeLockedEdits",
            ),
          ) +
          row(
            "Ask before downloading assets",
            au.askBeforeDownloads
              ? "Agents list what they found and wait for your approval."
              : "Agents download what fits without asking.",
            sw(
              au.askBeforeDownloads,
              "auto-sw",
              "Ask before downloading assets",
              "askBeforeDownloads",
            ),
          ),
      )
    );
  };

  /* ---------- actions: each patch is built from the settings as they are when the save runs ---------- */
  const save = (preset) =>
    OVS.saveAgents((a) => ({
      executionQuality: { preset, custom: a.executionQuality.custom },
    }));
  /* Edit one or more budget fields: Custom, starting from what the page shows now (a fixed preset's numbers or
     the saved custom budget). */
  const editBudget = (change) =>
    OVS.saveAgents((a) => {
      const base = resolve(a.executionQuality);
      const next = clampBudget(Object.assign({}, base, change(base)));
      return { executionQuality: { preset: "custom", custom: next } };
    });

  CLICK.quality = (t) => {
    save(t.dataset.v);
  };
  CLICK.customize = () => {
    save("custom");
  };
  CLICK["exec-qa"] = (t) => {
    const d = Number(t.dataset.d);
    editBudget((b) => ({ qaPasses: clamp("qaPasses", b.qaPasses + d) }));
  };
  CLICK["exec-critique"] = (t) => {
    editBudget(() => ({ critiqueRounds: Number(t.dataset.v) }));
  };
  CLICK["exec-thinking"] = (t) => {
    editBudget(() => ({ specialistThinking: t.dataset.v }));
  };
  CHANGE["exec-num"] = (t) => {
    const key = t.dataset.key,
      n = t.value.trim() === "" ? NaN : Number(t.value);
    if (!RANGES[key] || !Number.isFinite(n)) return OVS.render(true); /* back to the saved number */
    editBudget(() => ({ [key]: clamp(key, n) }));
  };
  CLICK["auto-intent"] = (t) => {
    OVS.saveAgents({ autonomy: { defaultIntent: t.dataset.v } });
  };
  CLICK["auto-sw"] = (t) => {
    const key = t.dataset.key;
    if (key !== "askBeforeLockedEdits" && key !== "askBeforeDownloads") return;
    OVS.saveAgents((a) => ({
      autonomy: { [key]: !Object.assign({}, AUTONOMY_DEFAULTS, a.autonomy)[key] },
    }));
  };
})();
