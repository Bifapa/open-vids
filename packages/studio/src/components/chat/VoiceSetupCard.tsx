import { useEffect, useId, useState } from "react";
import { CheckCircle, Clock, Microphone, WarningCircle, XCircle } from "@phosphor-icons/react";
import type {
  AnswerVoiceSetupRequest,
  VoicePreset,
  VoiceSetupRequest,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { useStudioShellContextOptional } from "../../contexts/StudioContext";
import { useTranslation } from "../../i18n";
import { ensureLibraryPreset } from "../../voice/ensureLibraryPreset";
import { useProjectVoice } from "../../voice/useProjectVoice";
import { useVoiceStore, useVoiceStoreApi } from "../../voice/voiceContext";
import { voiceSetupStage } from "../../voice/voiceSetupStage";
import { configuredProviders } from "../../voice/voiceStore";
import { useVoiceUi } from "../../voice/voiceUiStore";
import { VoiceConnectStep } from "../../voice/VoiceConnectStep";
import { VoicePlayButton } from "../../voice/VoicePlayButton";
import { Button, cn } from "../ui";
import { chatAgentName } from "./AgentMonogram";
import { chatMeasureWide, noteBox } from "./chatStyles";

type Busy = "use" | "decline" | "choose";

interface FailedAnswer {
  message: string;
  /** Asks the same thing again: "Try again". */
  retry: () => void;
}

function SettledLine({ setup }: { setup: VoiceSetupRequest }) {
  const { t } = useTranslation();
  if (setup.state === "answered") {
    return (
      <p
        role="status"
        data-testid="voice-setup-status"
        className="flex items-center gap-1 text-xs text-success"
      >
        <CheckCircle aria-hidden weight="fill" className="size-icon-sm shrink-0" />
        {setup.presetName
          ? t("voice.chat.setup.answered", { name: setup.presetName })
          : t("voice.chat.setup.answeredPlain")}
      </p>
    );
  }
  const declined = setup.state === "declined";
  const Glyph = declined ? XCircle : Clock;
  return (
    <p
      role="status"
      data-testid="voice-setup-status"
      className="flex items-center gap-1 text-xs text-fg-3"
    >
      <Glyph aria-hidden weight="fill" className="size-icon-sm shrink-0" />
      {declined ? t("voice.chat.setup.declined") : t("voice.chat.setup.expired")}
    </p>
  );
}

/** The project's voice as one row: its name, where it comes from and a sample to play. */
function ProjectVoiceRow({ voice }: { voice: VoicePreset }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="voice-setup-project-voice"
      className="flex min-w-0 items-center gap-2 rounded-sm bg-surface-1 px-2 py-1.5"
    >
      {voice.sample !== null && (
        <VoicePlayButton
          soundKey="voice-setup:project-voice"
          label={t("voice.chat.setup.play", { name: voice.name })}
          source={() => (voice.sample === null ? null : { url: voice.sample.audio.url })}
        />
      )}
      <span className="grid min-w-0 flex-1 gap-px">
        <span className="truncate text-sm font-medium leading-4 text-fg">{voice.name}</span>
        <span className="truncate text-xs leading-[14px] text-fg-3">
          {[voice.voice.name, voice.model].filter(Boolean).join(" · ")}
        </span>
      </span>
    </div>
  );
}

/**
 * The agent asks the user to pick the project's voice. The card has three faces: the project's own voice with
 * "Use" / "Change" (answering costs nothing), a connect step when no voice service is set up, and else a button that
 * opens the voice setup window, which ends with a saved preset. "Not now" declines. The runtime sets the project's
 * voice from the answer; the chat stream carries the new state and the answer only keeps the card busy.
 */
export function VoiceSetupCard({ turnId, setup }: { turnId: string; setup: VoiceSetupRequest }) {
  const { t } = useTranslation();
  const answerVoiceSetup = useAgentStore((state) => state.answerVoiceSetup);
  const voiceStore = useVoiceStoreApi();
  const providers = useVoiceStore((state) => state.providers);
  const projectId = useStudioShellContextOptional()?.projectId;
  const titleId = useId();
  const [busy, setBusy] = useState<Busy | null>(null);
  const [failed, setFailed] = useState<FailedAnswer | null>(null);
  const [changing, setChanging] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // The runtime's answer stands in until the stream delivers the same state (it is not replayed after a drop).
  const [answered, setAnswered] = useState<VoiceSetupRequest | null>(null);

  const current = setup.state === "pending" && answered?.id === setup.id ? answered : setup;
  const open = current.state === "pending";
  const project = useProjectVoice(projectId, open);
  const projectVoice = project.script?.voice ?? null;
  const configured = configuredProviders(providers);

  useEffect(() => {
    if (open) void voiceStore.getState().refresh();
  }, [open, voiceStore]);

  // With no service set up the connect step opens, and stays until the user goes on from it.
  const noService = providers !== null && configured.length === 0;
  useEffect(() => {
    if (open && noService) setConnecting(true);
  }, [open, noService]);

  const stage = voiceSetupStage({
    projectLoaded: projectId === undefined || project.loaded,
    hasProjectVoice: projectVoice !== null,
    changing,
    providersLoaded: providers !== null,
    configuredCount: configured.length,
    connecting,
  });

  const answer = async (body: AnswerVoiceSetupRequest, as: Busy) => {
    if (busy) return;
    setBusy(as);
    setFailed(null);
    const result = await answerVoiceSetup(turnId, setup.id, body);
    setBusy(null);
    if (result.ok) setAnswered(result.setup);
    else setFailed({ message: result.message, retry: () => void answer(body, as) });
  };

  const openWindow = () =>
    useVoiceUi.getState().openSetup({
      language: setup.language,
      sampleText: setup.sampleText,
      suggestion: setup.suggestion,
      startFrom: projectVoice,
      // A saved voice is the answer: the window ends with the preset, the runtime sets it on the project.
      onSaved: (preset) => void answer({ presetId: preset.id }, "choose"),
    });

  const acceptProjectVoice = async (): Promise<void> => {
    if (projectVoice === null || busy) return;
    setBusy("use");
    setFailed(null);
    const library = await ensureLibraryPreset(voiceStore, projectVoice);
    setBusy(null);
    if (!library.ok)
      return setFailed({ message: library.message, retry: () => void acceptProjectVoice() });
    await answer({ presetId: library.presetId }, "use");
  };

  const change = () => {
    if (configured.length > 0) return openWindow();
    setChanging(true);
    setConnecting(true);
  };

  return (
    <section
      aria-labelledby={titleId}
      data-testid="voice-setup-card"
      data-voice-setup-state={current.state}
      data-voice-setup-stage={open ? stage : undefined}
      className={cn("mt-1.5", noteBox, chatMeasureWide)}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <Microphone
          aria-hidden
          weight={open ? "fill" : "regular"}
          className={cn("size-icon-sm shrink-0", open ? "text-accent" : "text-fg-3")}
        />
        <span id={titleId} className="min-w-0 font-semibold text-fg">
          {t("voice.chat.setup.title")}
        </span>
      </div>
      {open ? (
        <>
          <p className="text-sm leading-[17px] text-fg-2">
            {setup.suggestion.trim() === ""
              ? t("voice.chat.setup.ask", { agent: chatAgentName(setup.agent) })
              : t("voice.chat.setup.askSuggest", {
                  agent: chatAgentName(setup.agent),
                  suggestion: setup.suggestion.trim(),
                })}
          </p>
          {stage === "project-voice" && projectVoice !== null && (
            <>
              <ProjectVoiceRow voice={projectVoice} />
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy === "use"}
                  disabled={busy !== null}
                  onClick={() => void acceptProjectVoice()}
                >
                  {t("voice.chat.setup.use")}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={change}>
                  {t("voice.chat.setup.change")}
                </Button>
                <DeclineButton
                  busy={busy}
                  onDecline={() => void answer({ decline: true }, "decline")}
                />
              </div>
            </>
          )}
          {stage === "connect" && (
            <>
              <VoiceConnectStep
                onReady={() => {
                  setConnecting(false);
                  openWindow();
                }}
              />
              <div>
                <DeclineButton
                  busy={busy}
                  onDecline={() => void answer({ decline: true }, "decline")}
                />
              </div>
            </>
          )}
          {stage === "choose" && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="primary"
                icon={<Microphone size={12} aria-hidden />}
                data-testid="voice-setup-choose"
                disabled={busy !== null}
                onClick={openWindow}
              >
                {t("voice.chat.setup.choose")}
              </Button>
              <DeclineButton
                busy={busy}
                onDecline={() => void answer({ decline: true }, "decline")}
              />
            </div>
          )}
          {failed && (
            <div
              role="alert"
              data-testid="voice-setup-error"
              className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-[15px] text-error"
            >
              <WarningCircle aria-hidden className="size-icon-sm shrink-0" />
              <span className="min-w-0 flex-1 [text-wrap:pretty]">
                {t("voice.chat.setup.error", { message: failed.message })}
              </span>
              <Button size="xs" variant="ghost" disabled={busy !== null} onClick={failed.retry}>
                {t("common.tryAgain")}
              </Button>
            </div>
          )}
        </>
      ) : (
        <SettledLine setup={current} />
      )}
    </section>
  );
}

function DeclineButton({ busy, onDecline }: { busy: Busy | null; onDecline: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      size="sm"
      variant="ghost"
      data-testid="voice-setup-decline"
      loading={busy === "decline"}
      disabled={busy !== null}
      onClick={onDecline}
    >
      {t("voice.chat.setup.decline")}
    </Button>
  );
}
