import type { Activity, ChatState, PlanStep, TurnSummary } from "@hyperframes/agent-protocol";
import { formatPercent, t } from "../../i18n";
import { runningTurn } from "../../agent/agentSelectors";
import { activityText } from "./ActivityRow";
import { QA_PASS_PHASE_LABELS } from "./qaLabels";

/** The newest running activity of the turn that reports progress (a render, an analysis), whoever runs it. */
function progressingActivity(chat: ChatState, turn: TurnSummary): Activity | null {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index];
    if (message?.role !== "assistant" || message.turnId !== turn.id) continue;
    for (let at = message.parts.length - 1; at >= 0; at -= 1) {
      const part = message.parts[at];
      if (part?.type === "activity" && part.activity.status === "running") {
        if (part.activity.progress !== undefined) return part.activity;
      }
    }
  }
  return null;
}

function currentStep(steps: readonly PlanStep[]): { index: number; step: PlanStep } | null {
  const index = steps.findIndex((step) => step.status === "running");
  const step = steps[index];
  return step ? { index, step } : null;
}

/**
 * One line about where a long turn is, for the chat header while it runs: the Render QA pass and what it is doing,
 * else the progress of a running render or analysis, else the Director's current plan step ("Step 2 of 4 · …").
 * Null when the turn has nothing more specific to say than "working".
 */
export function phaseLine(chat: ChatState): string | null {
  const turn = runningTurn(chat);
  if (!turn) return null;

  const qa = turn.qa;
  if (qa?.status === "running") {
    const pass = qa.passes.at(-1);
    if (pass) {
      return t("chat.phase.qa", {
        pass: pass.pass,
        total: qa.passLimit,
        phase: t(QA_PASS_PHASE_LABELS[pass.phase]),
      });
    }
  }

  const activity = progressingActivity(chat, turn);
  if (activity?.progress !== undefined) {
    return t("chat.phase.progress", {
      label: activityText(activity.label, activity.labelCode, activity.labelParams),
      percent: formatPercent(Math.min(100, Math.max(0, activity.progress)) / 100),
    });
  }

  const step = turn.plan ? currentStep(turn.plan.steps) : null;
  if (turn.plan && step) {
    return t("chat.phase.step", {
      step: step.index + 1,
      total: turn.plan.steps.length,
      title: step.step.title,
    });
  }
  return null;
}
