import { useId, useState, type FormEvent } from "react";
import { ChatCircleDots, CheckCircle, Clock, WarningCircle } from "@phosphor-icons/react";
import { LIMITS, type QuestionRequest } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { useTranslation } from "../../i18n";
import { Button, cn, fieldBase, fieldText } from "../ui";
import { chatAgentName } from "./AgentMonogram";
import { chatMeasureWide, noteBox, noteBoxWarn } from "./chatStyles";

interface FailedAnswer {
  answer: string;
  message: string;
}

/**
 * Something an agent asked the user mid-turn (`request_input`): the question, its suggested answers as buttons, and a
 * field for an answer of their own, while the tool call waits. Once answered (or expired because the turn ended
 * first) it is a one-line record. The chat stream carries the new state; the answer only keeps the card busy until
 * the runtime has taken it.
 */
export function QuestionCard({ turnId, question }: { turnId: string; question: QuestionRequest }) {
  const { t } = useTranslation();
  const answerQuestion = useAgentStore((state) => state.answerQuestion);
  const titleId = useId();
  const fieldId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<FailedAnswer | null>(null);
  // The runtime's answer stands in until the stream delivers the same state (it is not replayed after a drop).
  const [answered, setAnswered] = useState<QuestionRequest | null>(null);

  const current =
    question.state === "pending" && answered?.id === question.id ? answered : question;
  const open = current.state === "pending";

  const answer = async (text: string) => {
    const trimmed = text.trim();
    if (busy !== null || trimmed === "") return;
    setBusy(trimmed);
    setFailed(null);
    const result = await answerQuestion(turnId, question.id, trimmed);
    setBusy(null);
    if (result.ok) setAnswered(result.question);
    else setFailed({ answer: trimmed, message: result.message });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void answer(typed);
  };

  return (
    <section
      aria-labelledby={titleId}
      data-testid="question-card"
      data-question-state={current.state}
      className={cn("mt-1.5", open ? noteBoxWarn : noteBox, chatMeasureWide)}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <ChatCircleDots
          aria-hidden
          weight={open ? "fill" : "regular"}
          className={cn("size-icon-sm shrink-0", open ? "text-warning" : "text-fg-3")}
        />
        <span id={titleId} className="min-w-0 font-semibold text-fg">
          {t("chat.question.title", { agent: chatAgentName(current.agent) })}
        </span>
      </div>
      <p
        data-testid="question-text"
        className="text-sm leading-[17px] whitespace-pre-wrap text-fg [overflow-wrap:anywhere]"
      >
        {current.text}
      </p>
      {open ? (
        <div className="grid gap-1.5">
          {current.options.length > 0 && (
            <div
              role="group"
              aria-label={t("chat.question.options")}
              className="flex flex-wrap items-center gap-1.5"
            >
              {current.options.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant="secondary"
                  title={option}
                  loading={busy === option}
                  disabled={busy !== null}
                  onClick={() => void answer(option)}
                  className="max-w-full"
                >
                  <span className="truncate">{option}</span>
                </Button>
              ))}
            </div>
          )}
          <form onSubmit={submit} className="flex items-center gap-1.5">
            <label htmlFor={fieldId} className="sr-only">
              {t("chat.question.field")}
            </label>
            <div className={cn(fieldBase, "flex-1")}>
              <input
                id={fieldId}
                type="text"
                value={typed}
                maxLength={LIMITS.answerChars}
                disabled={busy !== null}
                placeholder={
                  current.options.length > 0
                    ? t("chat.question.fieldWithOptions")
                    : t("chat.question.fieldPlaceholder")
                }
                onChange={(event) => setTyped(event.target.value)}
                className={fieldText}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={busy !== null && busy === typed.trim()}
              disabled={busy !== null || typed.trim() === ""}
            >
              {t("chat.question.send")}
            </Button>
          </form>
          {failed && (
            <div
              role="alert"
              data-testid="question-error"
              className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-[15px] text-error"
            >
              <WarningCircle aria-hidden className="size-icon-sm shrink-0" />
              <span className="min-w-0 flex-1 [text-wrap:pretty]">
                {t("chat.question.error", { message: failed.message })}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void answer(failed.answer)}
              >
                {t("common.tryAgain")}
              </Button>
            </div>
          )}
        </div>
      ) : current.state === "answered" ? (
        <p
          role="status"
          data-testid="question-status"
          className="flex items-start gap-1 text-xs text-success"
        >
          <CheckCircle aria-hidden weight="fill" className="mt-px size-icon-sm shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {t("chat.question.answered", { answer: current.answer ?? "" })}
          </span>
        </p>
      ) : (
        <p
          role="status"
          data-testid="question-status"
          className="flex items-center gap-1 text-xs text-fg-3"
        >
          <Clock aria-hidden weight="fill" className="size-icon-sm shrink-0" />
          {t("chat.question.expired")}
        </p>
      )}
    </section>
  );
}
