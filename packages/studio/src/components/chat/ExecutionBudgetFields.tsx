import {
  EXECUTION_BUDGET_RANGES,
  EXECUTION_QUALITY_PRESETS,
  SPECIALIST_THINKING_POLICIES,
  clampExecutionBudget,
  resolveExecutionBudget,
  type ExecutionBudget,
  type ExecutionQuality,
} from "@hyperframes/agent-protocol";
import { NumberField } from "../ui/NumberField";
import { ChoiceChips, type Choice } from "./ChoiceChips";
import { DialogField } from "./ChatDialog";
import {
  BUDGET_FIELDS,
  EXECUTION_PRESET_LABELS,
  THINKING_POLICY_HINTS,
  THINKING_POLICY_LABELS,
  describeBudget,
} from "./qaLabels";

const PASS_RANGE = EXECUTION_BUDGET_RANGES.qaPasses;

const PASS_CHOICES: Choice<string>[] = Array.from(
  { length: PASS_RANGE.max - PASS_RANGE.min + 1 },
  (_, index) => {
    const passes = PASS_RANGE.min + index;
    return { value: String(passes), label: passes === 0 ? "Off" : String(passes) };
  },
);

const THINKING_CHOICES = SPECIALIST_THINKING_POLICIES.map((policy) => ({
  value: policy,
  label: THINKING_POLICY_LABELS[policy],
}));

/** Fields that only matter while render QA runs. */
const QA_ONLY: Partial<Record<keyof ExecutionBudget, true>> = {
  qaFramesPerMinute: true,
  qaMaxFrames: true,
  critiqueRounds: true,
};

function passesHint(passes: number): string {
  if (passes === 0) return "Render QA is off: the agent does not render and check its work.";
  if (passes === 1) return "One render, checked and reported; no automatic correction.";
  const corrections = passes - 1;
  return `Up to ${passes} renders, each checked; at most ${corrections} ${
    corrections === 1 ? "correction" : "corrections"
  } in between.`;
}

/**
 * Every field of an Execution Quality budget, each held to `EXECUTION_BUDGET_RANGES`. Render QA passes lead,
 * as the one most people change. Every change hands back a whole, clamped budget.
 */
export function ExecutionBudgetFields({
  value,
  onChange,
  disabled = false,
}: {
  value: ExecutionBudget;
  onChange: (next: ExecutionBudget) => void;
  disabled?: boolean;
}) {
  const qaOff = value.qaPasses === 0;

  const setField = (field: (typeof BUDGET_FIELDS)[number]["field"], next: number) => {
    const budget = { ...value };
    budget[field] = next;
    onChange(clampExecutionBudget(budget));
  };

  return (
    <div className="flex flex-col gap-3">
      <DialogField label="Render QA passes" hint={passesHint(value.qaPasses)}>
        <ChoiceChips
          label="Render QA passes"
          value={String(value.qaPasses)}
          choices={PASS_CHOICES}
          disabled={disabled}
          onChange={(next) => setField("qaPasses", Number(next))}
        />
      </DialogField>
      <ul className="flex flex-col gap-2">
        {BUDGET_FIELDS.filter(({ field }) => field !== "qaPasses").map(({ field, label, hint }) => {
          const { min, max } = EXECUTION_BUDGET_RANGES[field];
          return (
            <li key={field} className="flex items-start gap-2" data-budget-field={field}>
              <div className="min-w-0 flex-1">
                <p className="text-step-11 text-text-1">{label}</p>
                <p className="text-step-10 leading-snug text-text-4">
                  {hint} {min}–{max}.
                  {qaOff && QA_ONLY[field] ? " Unused while render QA is off." : ""}
                </p>
              </div>
              <NumberField
                label={label}
                value={value[field]}
                min={min}
                max={max}
                step={1}
                disabled={disabled}
                onCommit={(next) => setField(field, next)}
                className="h-ctl-sm w-20 shrink-0"
              />
            </li>
          );
        })}
      </ul>
      <DialogField
        label="Specialist thinking"
        hint={THINKING_POLICY_HINTS[value.specialistThinking]}
      >
        <ChoiceChips
          label="Specialist thinking"
          value={value.specialistThinking}
          choices={THINKING_CHOICES}
          disabled={disabled}
          onChange={(specialistThinking) => onChange({ ...value, specialistThinking })}
        />
      </DialogField>
    </div>
  );
}

const PRESET_CHOICES = EXECUTION_QUALITY_PRESETS.map((preset) => ({
  value: preset,
  label: EXECUTION_PRESET_LABELS[preset],
}));

/**
 * The global default Execution Quality, saved as it changes. Custom shows the whole budget inline; a fixed preset
 * keeps the custom budget, so going back to Custom restores it.
 */
export function ExecutionQualityDefaults({
  value,
  onCommit,
}: {
  value: ExecutionQuality;
  onCommit: (next: ExecutionQuality) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <ChoiceChips
        label="Default execution quality"
        value={value.preset}
        choices={PRESET_CHOICES}
        onChange={(preset) => onCommit({ preset, custom: value.custom })}
      />
      <p className="text-step-10 leading-snug text-text-3" data-testid="default-quality-detail">
        {describeBudget(resolveExecutionBudget(value))}.
      </p>
      {value.preset === "custom" && (
        <div className="rounded-md border border-hairline bg-bg-2 px-2 py-2">
          <ExecutionBudgetFields
            value={value.custom}
            onChange={(custom) => onCommit({ preset: "custom", custom })}
          />
        </div>
      )}
    </div>
  );
}
