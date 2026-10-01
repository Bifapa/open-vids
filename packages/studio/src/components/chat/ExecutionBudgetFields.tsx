import {
  EXECUTION_BUDGET_RANGES,
  SPECIALIST_THINKING_POLICIES,
  clampExecutionBudget,
  type ExecutionBudget,
} from "@hyperframes/agent-protocol";
import { t, useTranslation } from "../../i18n";
import { NumberField } from "../ui/NumberField";
import { ChoiceChips, type Choice } from "./ChoiceChips";
import { DialogField } from "./ChatDialog";
import { BUDGET_FIELDS, THINKING_POLICY_HINTS, THINKING_POLICY_LABELS } from "./qaLabels";

const PASS_RANGE = EXECUTION_BUDGET_RANGES.qaPasses;

const PASS_COUNTS = Array.from(
  { length: PASS_RANGE.max - PASS_RANGE.min + 1 },
  (_, index) => PASS_RANGE.min + index,
);

/** Fields that only matter while render QA runs. */
export const QA_ONLY: Partial<Record<keyof ExecutionBudget, true>> = {
  qaFramesPerMinute: true,
  qaMaxFrames: true,
  critiqueRounds: true,
};

export function passesHint(passes: number): string {
  if (passes === 0) return t("chat.quality.passesHint.off");
  if (passes === 1) return t("chat.quality.passesHint.one");
  return t("chat.quality.passesHint.many", { passes, corrections: passes - 1 });
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
  const { t } = useTranslation();
  const qaOff = value.qaPasses === 0;
  const passChoices: Choice<string>[] = PASS_COUNTS.map((passes) => ({
    value: String(passes),
    label: passes === 0 ? t("chat.quality.passesOff") : String(passes),
  }));
  const thinkingChoices = SPECIALIST_THINKING_POLICIES.map((policy) => ({
    value: policy,
    label: t(THINKING_POLICY_LABELS[policy]),
  }));

  const setField = (field: (typeof BUDGET_FIELDS)[number]["field"], next: number) => {
    const budget = { ...value };
    budget[field] = next;
    onChange(clampExecutionBudget(budget));
  };

  return (
    <div className="flex flex-col gap-3">
      <DialogField label={t("chat.quality.field.qaPasses")} hint={passesHint(value.qaPasses)}>
        <ChoiceChips
          label={t("chat.quality.field.qaPasses")}
          value={String(value.qaPasses)}
          choices={passChoices}
          disabled={disabled}
          onChange={(next) => setField("qaPasses", Number(next))}
        />
      </DialogField>
      <ul className="flex flex-col gap-2">
        {BUDGET_FIELDS.filter(({ field }) => field !== "qaPasses").map(({ field, label, hint }) => {
          const { min, max } = EXECUTION_BUDGET_RANGES[field];
          const unused = qaOff && QA_ONLY[field];
          return (
            <li key={field} className="flex items-start gap-2" data-budget-field={field}>
              <div className="min-w-0 flex-1">
                <p className="text-step-11 text-text-1">{t(label)}</p>
                <p className="text-step-10 leading-snug text-text-4">
                  {t(unused ? "chat.quality.rangeHintUnused" : "chat.quality.rangeHint", {
                    hint: t(hint),
                    min,
                    max,
                  })}
                </p>
              </div>
              <NumberField
                label={t(label)}
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
        label={t("chat.quality.thinking.field")}
        hint={t(THINKING_POLICY_HINTS[value.specialistThinking])}
      >
        <ChoiceChips
          label={t("chat.quality.thinking.field")}
          value={value.specialistThinking}
          choices={thinkingChoices}
          disabled={disabled}
          onChange={(specialistThinking) => onChange({ ...value, specialistThinking })}
        />
      </DialogField>
    </div>
  );
}
