import { Minus, Plus } from "@phosphor-icons/react";
import {
  EXECUTION_BUDGET_RANGES,
  EXECUTION_QUALITY_PRESETS,
  SPECIALIST_THINKING_POLICIES,
  clampExecutionBudget,
  resolveExecutionBudget,
  type ExecutionBudget,
  type ExecutionQuality,
} from "@hyperframes/agent-protocol";
import { useTranslation } from "../../i18n";
import { QA_ONLY, passesHint } from "../chat/ExecutionBudgetFields";
import {
  BUDGET_FIELDS,
  EXECUTION_PRESET_BLURBS,
  EXECUTION_PRESET_LABELS,
  THINKING_POLICY_HINTS,
  THINKING_POLICY_LABELS,
  describeBudget,
} from "../chat/qaLabels";
import { Button } from "../ui/Button";
import { NumberField } from "../ui/NumberField";
import { SegmentedControl } from "../ui/SegmentedControl";
import {
  SaveStatus,
  SettingsGroup,
  SettingsLink,
  SettingsPage,
  SettingsRow,
  SettingsUnavailable,
} from "./settingsLayout";
import { AutonomyGroup } from "./AutonomyGroup";
import { useAgentSettingsEditor } from "./useAgentSettingsEditor";

type BudgetField = (typeof BUDGET_FIELDS)[number]["field"];

/** QA passes as the prototype's stepper: a value between − and +, held to its range. */
function PassesStepper({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  const { t } = useTranslation();
  const { min, max } = EXECUTION_BUDGET_RANGES.qaPasses;
  const step =
    "inline-flex size-[22px] items-center justify-center rounded-sm text-fg-2 enabled:hover:bg-surface-2 enabled:hover:text-fg disabled:text-fg-disabled outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <div
      role="group"
      aria-label={t("settings.studio.ex.passes")}
      className="inline-flex h-ctl items-center gap-0.5 rounded-md border border-border bg-bg-0 p-0.5"
    >
      <button
        type="button"
        aria-label={t("settings.stepper.fewer")}
        className={step}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        <Minus aria-hidden className="size-icon-sm" />
      </button>
      <output
        aria-live="polite"
        className="min-w-6 text-center font-mono text-sm font-medium text-fg"
      >
        {value}
      </output>
      <button
        type="button"
        aria-label={t("settings.stepper.more")}
        className={step}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        <Plus aria-hidden className="size-icon-sm" />
      </button>
    </div>
  );
}

function CustomBudgetRows({
  value,
  onChange,
}: {
  value: ExecutionBudget;
  onChange: (next: ExecutionBudget) => void;
}) {
  const { t } = useTranslation();
  const qaOff = value.qaPasses === 0;
  const thinkingOptions = SPECIALIST_THINKING_POLICIES.map((policy) => ({
    value: policy,
    label: t(THINKING_POLICY_LABELS[policy]),
  }));
  const setField = (field: BudgetField, next: number) => {
    const budget = { ...value };
    budget[field] = next;
    onChange(clampExecutionBudget(budget));
  };
  return (
    <>
      {BUDGET_FIELDS.filter(({ field }) => field !== "qaPasses").map(({ field, label, hint }) => {
        const { min, max } = EXECUTION_BUDGET_RANGES[field];
        const unused = qaOff && QA_ONLY[field];
        return (
          <SettingsRow
            key={field}
            label={t(label)}
            disabled={Boolean(unused)}
            hint={t(unused ? "settings.studio.ex.rangeUnused" : "settings.studio.ex.range", {
              hint: t(hint),
              min,
              max,
            })}
          >
            <span data-budget-field={field}>
              <NumberField
                label={t(label)}
                value={value[field]}
                min={min}
                max={max}
                step={1}
                onCommit={(next) => setField(field, next)}
                className="h-ctl w-20"
              />
            </span>
          </SettingsRow>
        );
      })}
      <SettingsRow
        label={t("settings.execution.specialistThinking")}
        hint={t(THINKING_POLICY_HINTS[value.specialistThinking])}
      >
        <SegmentedControl
          label={t("settings.execution.specialistThinking")}
          value={value.specialistThinking}
          options={thinkingOptions}
          onChange={(specialistThinking) => onChange({ ...value, specialistThinking })}
        />
      </SettingsRow>
    </>
  );
}

/**
 * The global default Execution Quality, for chats with no choice of their own. A fixed preset shows its budget;
 * Custom shows every field. A fixed preset keeps the saved custom budget, so going back to Custom restores it.
 */
export function ExecutionSection() {
  const { t } = useTranslation();
  const editor = useAgentSettingsEditor();
  const settings = editor.settings;

  if (!settings) {
    return (
      <SettingsPage title={t("settings.section.execution")}>
        <SettingsUnavailable
          message={
            editor.settingsFailed
              ? t("settings.studio.ag.unavailable")
              : t("settings.loading.execution")
          }
          action={
            editor.settingsFailed ? (
              <Button size="sm" onClick={() => void editor.loadSettings()}>
                {t("common.tryAgain")}
              </Button>
            ) : undefined
          }
        />
      </SettingsPage>
    );
  }

  const { executionQuality: quality, autonomy } = settings;
  const save = (executionQuality: ExecutionQuality) => editor.commit({ executionQuality });
  const custom = quality.preset === "custom";
  const budget = resolveExecutionBudget(quality);
  const blurb =
    quality.preset === "custom"
      ? t("settings.execution.quality.custom.note")
      : t("settings.studio.ex.presetBlurb", {
          label: t(EXECUTION_PRESET_LABELS[quality.preset]),
          blurb: t(EXECUTION_PRESET_BLURBS[quality.preset]),
        });
  const presetOptions = EXECUTION_QUALITY_PRESETS.map((preset) => ({
    value: preset,
    label: t(EXECUTION_PRESET_LABELS[preset]),
  }));
  // Changing the passes of a fixed preset makes it Custom, started from that preset's budget.
  const setPasses = (qaPasses: number) =>
    save({ preset: "custom", custom: clampExecutionBudget({ ...budget, qaPasses }) });

  return (
    <SettingsPage
      title={t("settings.section.execution")}
      meta={<SaveStatus status={editor.status} failed={editor.failed} />}
    >
      <SettingsGroup
        label={t("settings.execution.group.quality")}
        footer={t("settings.studio.ex.qualityFoot")}
      >
        <SettingsRow label={t("settings.execution.quality")} hint={blurb}>
          <SegmentedControl
            label={t("settings.execution.quality.aria")}
            value={quality.preset}
            options={presetOptions}
            onChange={(preset) => save({ preset, custom: quality.custom })}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.studio.ex.passes")} hint={passesHint(budget.qaPasses)}>
          <PassesStepper value={budget.qaPasses} onChange={setPasses} />
        </SettingsRow>
        {custom ? (
          <CustomBudgetRows
            value={quality.custom}
            onChange={(next) => save({ preset: "custom", custom: next })}
          />
        ) : (
          <div className="flex items-start gap-4 px-3 py-2 text-xs leading-[15px] text-fg-3">
            <span data-testid="default-quality-detail" className="min-w-0 flex-1 text-pretty">
              {t("settings.studio.ex.summary", { summary: describeBudget(budget) })}
            </span>
            <span className="shrink-0">
              <SettingsLink onClick={() => save({ preset: "custom", custom: quality.custom })}>
                {t("settings.execution.customize")}
              </SettingsLink>
            </span>
          </div>
        )}
      </SettingsGroup>
      <AutonomyGroup autonomy={autonomy} onChange={(autonomy) => editor.commit({ autonomy })} />
    </SettingsPage>
  );
}
