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
import { useAgentSettingsEditor } from "./useAgentSettingsEditor";

type BudgetField = (typeof BUDGET_FIELDS)[number]["field"];

const PRESET_OPTIONS = EXECUTION_QUALITY_PRESETS.map((preset) => ({
  value: preset,
  label: EXECUTION_PRESET_LABELS[preset],
}));

const THINKING_OPTIONS = SPECIALIST_THINKING_POLICIES.map((policy) => ({
  value: policy,
  label: THINKING_POLICY_LABELS[policy],
}));

/** QA passes as the prototype's stepper: a value between − and +, held to its range. */
function PassesStepper({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  const { min, max } = EXECUTION_BUDGET_RANGES.qaPasses;
  const step =
    "inline-flex size-[22px] items-center justify-center rounded-sm text-fg-2 enabled:hover:bg-surface-2 enabled:hover:text-fg disabled:text-fg-disabled outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <div
      role="group"
      aria-label="Render QA passes"
      className="inline-flex h-ctl items-center gap-0.5 rounded-md border border-border bg-bg-0 p-0.5"
    >
      <button
        type="button"
        aria-label="Fewer"
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
        aria-label="More"
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
  const qaOff = value.qaPasses === 0;
  const setField = (field: BudgetField, next: number) => {
    const budget = { ...value };
    budget[field] = next;
    onChange(clampExecutionBudget(budget));
  };
  return (
    <>
      <SettingsRow label="Render QA passes" hint={passesHint(value.qaPasses)}>
        <PassesStepper value={value.qaPasses} onChange={(next) => setField("qaPasses", next)} />
      </SettingsRow>
      {BUDGET_FIELDS.filter(({ field }) => field !== "qaPasses").map(({ field, label, hint }) => {
        const { min, max } = EXECUTION_BUDGET_RANGES[field];
        const unused = qaOff && QA_ONLY[field];
        return (
          <SettingsRow
            key={field}
            label={label}
            disabled={Boolean(unused)}
            hint={`${hint} ${min}–${max}.${unused ? " Unused while render QA is off." : ""}`}
          >
            <span data-budget-field={field}>
              <NumberField
                label={label}
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
        label="Specialist thinking"
        hint={THINKING_POLICY_HINTS[value.specialistThinking]}
      >
        <SegmentedControl
          label="Specialist thinking"
          value={value.specialistThinking}
          options={THINKING_OPTIONS}
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
  const editor = useAgentSettingsEditor();
  const quality = editor.settings?.executionQuality;

  if (!quality) {
    return (
      <SettingsPage title="Execution">
        <SettingsUnavailable
          message={
            editor.settingsFailed
              ? "Agent settings are unavailable right now."
              : "Loading execution settings…"
          }
          action={
            editor.settingsFailed ? (
              <Button size="sm" onClick={() => void editor.loadSettings()}>
                Try again
              </Button>
            ) : undefined
          }
        />
      </SettingsPage>
    );
  }

  const save = (executionQuality: ExecutionQuality) => editor.commit({ executionQuality });
  const custom = quality.preset === "custom";
  const blurb =
    quality.preset === "custom"
      ? "Your own budget, field by field."
      : `${EXECUTION_PRESET_LABELS[quality.preset]}: ${EXECUTION_PRESET_BLURBS[quality.preset]}.`;

  return (
    <SettingsPage
      title="Execution"
      meta={<SaveStatus status={editor.status} failed={editor.failed} />}
    >
      <SettingsGroup
        label="Quality"
        footer="How hard the agents work in chats that have no choice of their own. A chat's Execution quality control overrides this."
      >
        <SettingsRow label="Execution quality" hint={blurb}>
          <SegmentedControl
            label="Default execution quality"
            value={quality.preset}
            options={PRESET_OPTIONS}
            onChange={(preset) => save({ preset, custom: quality.custom })}
          />
        </SettingsRow>
        {custom ? (
          <CustomBudgetRows
            value={quality.custom}
            onChange={(next) => save({ preset: "custom", custom: next })}
          />
        ) : (
          <div className="flex items-start gap-4 px-3 py-2 text-xs leading-[15px] text-fg-3">
            <span data-testid="default-quality-detail" className="min-w-0 flex-1 text-pretty">
              {describeBudget(resolveExecutionBudget(quality))}.
            </span>
            <span className="shrink-0">
              <SettingsLink onClick={() => save({ preset: "custom", custom: quality.custom })}>
                Customize
              </SettingsLink>
            </span>
          </div>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
