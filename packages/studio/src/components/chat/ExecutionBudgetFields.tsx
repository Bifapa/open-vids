import {
  EXECUTION_BUDGET_RANGES,
  SPECIALIST_THINKING_POLICIES,
  clampExecutionBudget,
  type ExecutionBudget,
} from "@hyperframes/agent-protocol";
import { NumberField } from "../ui/NumberField";
import { ChoiceChips, type Choice } from "./ChoiceChips";
import { DialogField } from "./ChatDialog";
import { BUDGET_FIELDS, THINKING_POLICY_HINTS, THINKING_POLICY_LABELS } from "./qaLabels";

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
export const QA_ONLY: Partial<Record<keyof ExecutionBudget, true>> = {
  qaFramesPerMinute: true,
  qaMaxFrames: true,
  critiqueRounds: true,
};

export function passesHint(passes: number): string {
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
