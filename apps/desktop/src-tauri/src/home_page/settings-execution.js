/* Settings → Execution: the default Execution Quality for chats that haven't chosen their own
   (agents.executionQuality {preset, custom} in the global agent settings, GET/PUT /api/agent/settings) and the
   Autonomy group (agents.autonomy {planApproval, askBeforeLockedEdits, askBeforeDownloads}, same route). */
(function () {
  "use strict";
  const { esc, S, PAGES, CLICK, CHANGE, tr, row, group, sw, seg, stepper, head } = OVS;
  /* Escaped text of a catalog message, for the helpers that take markup. */
  const te = (key, params) => esc(tr(key, params));

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
  /* Labels, hints and the other words on this page are catalog keys, read when drawn. */
  const QUALITY = [
    ["fast", "settings.execution.quality.fast"],
    ["balanced", "settings.execution.quality.balanced"],
    ["best", "settings.execution.quality.best"],
    ["custom", "settings.execution.quality.custom"],
  ];
  const QUALITY_NOTE = {
    fast: "settings.execution.quality.fast.note",
    balanced: "settings.execution.quality.balanced.note",
    best: "settings.execution.quality.best.note",
    custom: "settings.execution.quality.custom.note",
  };
  const THINKING = [
    ["economy", "settings.execution.thinking.economy"],
    ["configured", "settings.execution.thinking.configured"],
    ["thorough", "settings.execution.thinking.thorough"],
  ];
  const THINKING_HINT = {
    economy: "settings.execution.thinking.economy.hint",
    configured: "settings.execution.thinking.configured.hint",
    thorough: "settings.execution.thinking.thorough.hint",
  };
  /* [value, translated label] pairs for a segmented control. */
  const labelled = (list) => list.map((e) => [e[0], tr(e[1])]);
  /* Numeric budget fields as rows, in the order Studio shows them (render QA passes is the stepper above). */
  /* hint and unusedHint carry the range ({min}–{max}); unusedHint (qaOnly fields) adds that the field is
     idle while render QA is off. */
  const FIELDS = [
    {
      field: "qaFramesPerMinute",
      label: "settings.execution.field.qaFramesPerMinute",
      hint: "settings.execution.field.qaFramesPerMinute.hint",
      unusedHint: "settings.execution.field.qaFramesPerMinute.hintUnused",
      qaOnly: true,
    },
    {
      field: "qaMaxFrames",
      label: "settings.execution.field.qaMaxFrames",
      hint: "settings.execution.field.qaMaxFrames.hint",
      unusedHint: "settings.execution.field.qaMaxFrames.hintUnused",
      qaOnly: true,
    },
    {
      field: "analysisFramesPerSource",
      label: "settings.execution.field.analysisFramesPerSource",
      hint: "settings.execution.field.analysisFramesPerSource.hint",
    },
    {
      field: "researchCandidates",
      label: "settings.execution.field.researchCandidates",
      hint: "settings.execution.field.researchCandidates.hint",
    },
  ];
  /* Autonomy: packages/agent-protocol AutonomySettings. Plan approval copy matches the Director's plan proposals. */
  const APPROVALS = [
    ["big", "settings.execution.planApproval.big", "settings.execution.planApproval.big.hint"],
    [
      "always",
      "settings.execution.planApproval.always",
      "settings.execution.planApproval.always.hint",
    ],
    [
      "never",
      "settings.execution.planApproval.never",
      "settings.execution.planApproval.never.hint",
    ],
  ];
  const AUTONOMY_DEFAULTS = {
    planApproval: "big",
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
  function passesHint(passes) {
    if (passes === 0) return tr("settings.execution.passes.off");
    if (passes === 1) return tr("settings.execution.passes.one");
    return tr("settings.execution.passes.many", { passes, corrections: passes - 1 });
  }

  function summary(b) {
    const bold = { b: (inner) => `<b>${inner}</b>` };
    const items = [];
    if (b.qaPasses > 0) {
      items.push(
        OVI18N.rich(
          "settings.execution.summary.vision",
          { perMinute: b.qaFramesPerMinute, max: b.qaMaxFrames },
          bold,
        ),
      );
      items.push(
        OVI18N.rich("settings.execution.summary.critique", { count: b.critiqueRounds }, bold),
      );
    }
    items.push(
      OVI18N.rich("settings.execution.summary.research", { count: b.researchCandidates }, bold),
    );
    const policy = THINKING.find((t) => t[0] === b.specialistThinking);
    items.push(
      OVI18N.rich(
        "settings.execution.summary.thinking",
        { policy: policy ? tr(policy[1]) : b.specialistThinking },
        bold,
      ),
    );
    return `<div class="st-sub"><div class="st-summary">${items
      .map((i) => `<span>${i}</span>`)
      .join(
        "",
      )}<button type="button" class="link" data-act="customize" data-fk="customize">${te("settings.execution.customize")}</button></div></div>`;
  }
  const field = (name) => FIELDS.find((f) => f.field === name);
  /* Every real budget field in the prototype's custom-rows style (Studio's order; render QA passes is the stepper above). */
  function customRows(b) {
    const qaOff = b.qaPasses === 0;
    const range = { min: RANGES.critiqueRounds.min, max: RANGES.critiqueRounds.max };
    return (
      '<div class="st-sub is-flush">' +
      numRow(field("qaFramesPerMinute"), b, qaOff) +
      numRow(field("qaMaxFrames"), b, qaOff) +
      row(
        te("settings.execution.critique"),
        te(
          qaOff ? "settings.execution.critique.hintUnused" : "settings.execution.critique.hint",
          range,
        ),
        seg(
          [1, 2, 3, 4].map((n) => [n, String(n)]),
          b.critiqueRounds,
          "exec-critique",
          tr("settings.execution.critique"),
          null,
          qaOff,
        ),
        qaOff ? "is-disabled" : "",
      ) +
      numRow(field("analysisFramesPerSource"), b, false) +
      numRow(field("researchCandidates"), b, false) +
      row(
        te("settings.execution.specialistThinking"),
        THINKING_HINT[b.specialistThinking] ? te(THINKING_HINT[b.specialistThinking]) : "",
        seg(
          labelled(THINKING),
          b.specialistThinking,
          "exec-thinking",
          tr("settings.execution.specialistThinking"),
        ),
      ) +
      "</div>"
    );
  }
  function numRow(f, b, qaOff) {
    const unused = qaOff && f.qaOnly;
    const r = RANGES[f.field];
    return row(
      te(f.label),
      te(unused ? f.unusedHint : f.hint, { min: r.min, max: r.max }),
      `<input class="input mono st-num" type="number" inputmode="numeric" min="${r.min}" max="${r.max}" step="1" value="${b[f.field]}" aria-label="${te(
        f.label,
      )}" data-act="exec-num" data-key="${f.field}" data-fk="exec-num:${f.field}"${unused ? " disabled" : ""} />`,
      unused ? "is-disabled" : "",
    );
  }

  PAGES.execution = function () {
    if (!S.agents)
      return (
        head(tr("settings.section.execution")) +
        (S.agentsError
          ? OVS.failure("settings.failure.agentRuntime", S.agentsError, "agents-retry")
          : OVS.loading("settings.loading.execution"))
      );
    const eq = S.agents.executionQuality,
      b = resolve(eq),
      custom = eq.preset === "custom";
    const au = Object.assign({}, AUTONOMY_DEFAULTS, S.agents.autonomy);
    return (
      head(tr("settings.section.execution")) +
      OVS.noteHtml(S.agentsNote) +
      group(
        te("settings.execution.group.quality"),
        row(
          te("settings.execution.quality"),
          QUALITY_NOTE[eq.preset] ? te(QUALITY_NOTE[eq.preset]) : "",
          seg(labelled(QUALITY), eq.preset, "quality", tr("settings.execution.quality.aria")),
        ) +
          row(
            te("settings.execution.passes"),
            esc(passesHint(b.qaPasses)),
            stepper(
              b.qaPasses,
              RANGES.qaPasses.min,
              RANGES.qaPasses.max,
              "exec-qa",
              tr("settings.execution.passes"),
            ),
          ) +
          (custom ? customRows(b) : summary(b)),
      ) +
      `<p class="st-foot">${te("settings.execution.foot")}</p>` +
      group(
        te("settings.execution.group.autonomy"),
        row(
          te("settings.execution.planApproval"),
          esc(tr(APPROVALS.find((a) => a[0] === au.planApproval)[2])),
          seg(
            APPROVALS.map((a) => [a[0], tr(a[1])]),
            au.planApproval,
            "auto-plan",
            tr("settings.execution.planApproval"),
          ),
        ) +
          row(
            te("settings.execution.askLocked"),
            te(
              au.askBeforeLockedEdits
                ? "settings.execution.askLocked.hintOn"
                : "settings.execution.askLocked.hintOff",
            ),
            sw(
              au.askBeforeLockedEdits,
              "auto-sw",
              tr("settings.execution.askLocked"),
              "askBeforeLockedEdits",
            ),
          ) +
          row(
            te("settings.execution.askDownloads"),
            te(
              au.askBeforeDownloads
                ? "settings.execution.askDownloads.hintOn"
                : "settings.execution.askDownloads.hintOff",
            ),
            sw(
              au.askBeforeDownloads,
              "auto-sw",
              tr("settings.execution.askDownloads"),
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
  CLICK["auto-plan"] = (t) => {
    OVS.saveAgents({ autonomy: { planApproval: t.dataset.v } });
  };
  CLICK["auto-sw"] = (t) => {
    const key = t.dataset.key;
    if (key !== "askBeforeLockedEdits" && key !== "askBeforeDownloads") return;
    OVS.saveAgents((a) => ({
      autonomy: { [key]: !Object.assign({}, AUTONOMY_DEFAULTS, a.autonomy)[key] },
    }));
  };
})();
