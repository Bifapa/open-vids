import { useId, useState } from "react";
import { CheckCircle, Clock, PencilSimple, WarningCircle } from "@phosphor-icons/react";
import type {
  AnswerVoicePilotRequest,
  VoicePilotRequest,
  VoicePilotState,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { useStudioShellContextOptional } from "../../contexts/StudioContext";
import { formatDuration, useTranslation } from "../../i18n";
import { resolveMediaPreviewUrl } from "../../player/components/thumbnailUtils";
import { useProjectVoice } from "../../voice/useProjectVoice";
import { usdOrUnknown } from "../../voice/voiceLabels";
import { VoicePlayButton } from "../../voice/VoicePlayButton";
import { Button, cn } from "../ui";
import { chatAgentName } from "./AgentMonogram";
import { VoiceTaggedText } from "./VoiceTaggedText";
import { chatMeasureWide, noteBox } from "./chatStyles";

type Verdict = "approve" | "change";

interface FailedAnswer {
  message: string;
  retry: () => void;
}

const SETTLED_KEYS = {
  approved: "voice.chat.pilot.state.approved",
  changes: "voice.chat.pilot.state.changes",
  expired: "voice.chat.pilot.state.expired",
} as const satisfies Record<Exclude<VoicePilotState, "pending">, string>;

/**
 * The first line of a voiceover, generated alone so the user can hear the voice on the real script before the rest is
 * paid for. The card plays the take's range from the project's own file, and asks: "Continue" generates the remaining
 * lines (with their estimated cost), "Change" sends a note to the agent. Once answered it is a short record.
 */
export function VoicePilotCard({ turnId, pilot }: { turnId: string; pilot: VoicePilotRequest }) {
  const { t } = useTranslation();
  const answerVoicePilot = useAgentStore((state) => state.answerVoicePilot);
  const projectId = useStudioShellContextOptional()?.projectId;
  const titleId = useId();
  const noteId = useId();
  const [busy, setBusy] = useState<Verdict | null>(null);
  const [failed, setFailed] = useState<FailedAnswer | null>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  // The runtime's answer stands in until the stream delivers the same state (it is not replayed after a drop).
  const [answered, setAnswered] = useState<VoicePilotRequest | null>(null);

  const current = pilot.state === "pending" && answered?.id === pilot.id ? answered : pilot;
  const open = current.state === "pending";
  const playUrl = projectId === undefined ? null : resolveMediaPreviewUrl(current.file, projectId);
  // The pilot's text is the speaker text, tags included: the project voice's dialect draws them as chips.
  const project = useProjectVoice(projectId, true);

  const answer = async (body: AnswerVoicePilotRequest, verdict: Verdict) => {
    if (busy) return;
    setBusy(verdict);
    setFailed(null);
    const result = await answerVoicePilot(turnId, pilot.id, body);
    setBusy(null);
    if (result.ok) setAnswered(result.pilot);
    else setFailed({ message: result.message, retry: () => void answer(body, verdict) });
  };

  const sendNote = () => {
    const feedback = note.trim();
    if (feedback !== "") void answer({ decision: "change", feedback }, "change");
  };

  const settled = current.state === "pending" ? null : current.state;

  return (
    <section
      aria-labelledby={titleId}
      data-testid="voice-pilot-card"
      data-voice-pilot-state={current.state}
      className={cn("mt-1.5", noteBox, chatMeasureWide)}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <span id={titleId} className="min-w-0 font-semibold text-fg">
          {t("voice.chat.pilot.title")}
        </span>
        <span className="text-xs text-fg-3">{chatAgentName(current.agent)}</span>
      </div>
      <div className="flex min-w-0 items-start gap-2 rounded-sm bg-surface-1 px-2 py-1.5">
        {playUrl !== null && (
          <VoicePlayButton
            soundKey={`voice-pilot:${current.id}`}
            label={t("voice.chat.pilot.play")}
            source={() => ({ url: playUrl, range: { start: current.start, end: current.end } })}
          />
        )}
        <p
          data-testid="voice-pilot-text"
          className="m-0 min-w-0 flex-1 text-sm leading-[17px] text-fg [overflow-wrap:anywhere] [text-wrap:pretty]"
        >
          <VoiceTaggedText
            text={current.text}
            dialect={project.script?.voice ? project.script.dialect : null}
          />
        </p>
        <span className="shrink-0 text-xs tabular-nums text-fg-3">
          {formatDuration(Math.max(0, current.end - current.start))}
        </span>
      </div>
      {open && (
        <>
          <p data-testid="voice-pilot-remaining" className="text-xs leading-[15px] text-fg-3">
            {current.remainingLines > 0
              ? t("voice.chat.pilot.remaining", {
                  count: current.remainingLines,
                  cost: usdOrUnknown(current.remainingUsdCost),
                })
              : t("voice.chat.pilot.noneLeft")}
          </p>
          {noting ? (
            <div className="grid gap-1.5">
              <label htmlFor={noteId} className="text-xs font-medium text-fg-2">
                {t("voice.chat.pilot.noteLabel")}
              </label>
              <textarea
                id={noteId}
                value={note}
                rows={2}
                maxLength={2000}
                placeholder={t("voice.chat.pilot.notePlaceholder")}
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    sendNote();
                  }
                }}
                className={cn(
                  "min-h-10 w-full resize-y rounded-sm border border-border bg-surface-1 px-2 py-[5px] text-sm leading-4 text-fg outline-hidden",
                  "placeholder:text-fg-disabled hover:border-border-strong",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                )}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  data-testid="voice-pilot-send"
                  loading={busy === "change"}
                  disabled={busy !== null || note.trim() === ""}
                  onClick={sendNote}
                >
                  {t("voice.chat.pilot.send")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => setNoting(false)}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="primary"
                data-testid="voice-pilot-continue"
                loading={busy === "approve"}
                disabled={busy !== null}
                onClick={() => void answer({ decision: "approve" }, "approve")}
              >
                {t("voice.chat.pilot.continue")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={<PencilSimple size={12} aria-hidden />}
                data-testid="voice-pilot-change"
                disabled={busy !== null}
                onClick={() => setNoting(true)}
              >
                {t("voice.chat.pilot.change")}
              </Button>
            </div>
          )}
          {failed && (
            <div
              role="alert"
              data-testid="voice-pilot-error"
              className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-[15px] text-error"
            >
              <WarningCircle aria-hidden className="size-icon-sm shrink-0" />
              <span className="min-w-0 flex-1 [text-wrap:pretty]">
                {t("voice.chat.pilot.error", { message: failed.message })}
              </span>
              <Button size="xs" variant="ghost" disabled={busy !== null} onClick={failed.retry}>
                {t("common.tryAgain")}
              </Button>
            </div>
          )}
        </>
      )}
      {settled !== null && (
        <div className="grid gap-0.5">
          <p
            role="status"
            data-testid="voice-pilot-status"
            className={cn(
              "flex items-center gap-1 text-xs",
              settled === "approved" ? "text-success" : "text-fg-3",
            )}
          >
            {settled === "approved" ? (
              <CheckCircle aria-hidden weight="fill" className="size-icon-sm shrink-0" />
            ) : (
              <Clock aria-hidden weight="fill" className="size-icon-sm shrink-0" />
            )}
            {t(SETTLED_KEYS[settled])}
          </p>
          {settled === "changes" && current.feedback && (
            <p
              data-testid="voice-pilot-feedback"
              className="m-0 text-xs leading-[15px] text-fg-2 [overflow-wrap:anywhere]"
            >
              {current.feedback}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
