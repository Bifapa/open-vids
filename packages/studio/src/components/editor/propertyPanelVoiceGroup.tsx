/**
 * The inspector's Voiceover module: what a timeline clip that speaks a script line (`data-ov-voice-line`) offers. The
 * line's text (tags as chips) and its dialect findings, its takes to switch between without paying, Regenerate (asking
 * first), the music carve and a way to the Voiceover tab. Everything that writes goes through the script store and the
 * timeline's own writes, so Undo takes it back, and stops while an agent turn runs.
 */

import { VOICE_LINE_ATTRIBUTE } from "@hyperframes/agent-protocol";
import { ArrowSquareOut, ArrowsClockwise, Lock } from "@phosphor-icons/react";
import { isBetaFeatureEnabled } from "../../betaFeatures";
import { Badge, Button } from "../../components/ui";
import { t as translate, useTranslation } from "../../i18n";
import { useVoiceEditLock, useLineIssues, useVoiceScript } from "../../voice/script/useVoiceScript";
import { openVoiceoverTab } from "../../voice/openVoiceoverTab";
import { VoiceCarveButton } from "../../voice/panel/VoiceCarveButton";
import { VoiceGenerate } from "../../voice/panel/VoiceGenerate";
import { VoiceInlineText } from "../../voice/panel/VoiceInlineText";
import { VoiceIssueList } from "../../voice/panel/VoiceIssueList";
import { VoiceTakesList } from "../../voice/panel/VoiceTakesList";
import { useVoiceLineEdits } from "../../voice/panel/useVoiceLineEdits";
import { useVoiceTakeActions } from "../../voice/panel/useVoiceTakeActions";
import type { DomEditSelection } from "./domEditingTypes";
import type { FlatGroupDescriptor } from "./propertyPanelFlatDescriptors";

/** The line a selected clip speaks, or null (not a voice clip, or the beta feature is off). */
export function voiceLineOfSelection(element: DomEditSelection | null | undefined): string | null {
  if (!isBetaFeatureEnabled("voiceover")) return null;
  const id = element?.dataAttributes?.[VOICE_LINE_ATTRIBUTE.slice("data-".length)];
  return id ? id : null;
}

/** The module as a flat-inspector group: absent for a clip that speaks no line. */
export function voiceInspectorGroup(
  element: DomEditSelection,
  projectId: string,
): FlatGroupDescriptor | null {
  const lineId = voiceLineOfSelection(element);
  if (lineId === null) return null;
  return {
    id: "voiceover",
    title: translate("voice.inspector.title"),
    summary: translate("voice.inspector.summary"),
    content: <VoiceClipModule lineId={lineId} projectId={projectId} />,
  };
}

export function VoiceClipModule({ lineId, projectId }: { lineId: string; projectId: string }) {
  const { t } = useTranslation();
  const state = useVoiceScript(projectId);
  const { locked, reason } = useVoiceEditLock();
  const edits = useVoiceLineEdits();
  const actions = useVoiceTakeActions();
  const issues = useLineIssues(lineId);
  const line = state.view?.lines.find((entry) => entry.id === lineId) ?? null;
  const busy = locked || state.writing;

  if (state.view === null) {
    return (
      <p data-testid="voice-clip-loading" className="m-0 py-2 text-xs text-fg-3">
        {state.loadError ?? t("voice.panel.loading")}
      </p>
    );
  }

  if (line === null) {
    return (
      <div data-testid="voice-clip-missing" className="grid gap-2 py-2">
        <p className="m-0 text-xs leading-[15px] text-fg-3">{t("voice.inspector.missingLine")}</p>
        <div>
          <Button
            size="sm"
            variant="secondary"
            icon={<ArrowSquareOut aria-hidden size={12} />}
            onClick={openVoiceoverTab}
          >
            {t("voice.inspector.openTab")}
          </Button>
        </div>
      </div>
    );
  }

  const dialect = state.view.voice ? state.view.dialect : null;
  const lockReason = busy ? (reason ?? t("voice.panel.saving")) : null;
  const error = edits.error ?? actions.error;

  return (
    <div data-testid="voice-clip-module" data-line-id={line.id} className="grid gap-2.5 py-2">
      {locked && (
        <p
          role="status"
          data-testid="voice-clip-locked"
          className="m-0 flex items-start gap-1.5 text-xs leading-[15px] text-fg-2"
        >
          <Lock aria-hidden className="mt-px size-icon-sm shrink-0" />
          {reason}
        </p>
      )}
      {line.textChanged && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="warning" data-testid="voice-clip-text-changed">
            {t("voice.line.textChanged")}
          </Badge>
          <span className="min-w-0 text-xs leading-[15px] text-fg-3">
            {t("voice.inspector.textChangedHint")}
          </span>
        </div>
      )}
      <VoiceInlineText
        label={t("voice.line.speakerText")}
        value={line.speakerText}
        dialect={dialect}
        lockReason={lockReason}
        testId="voice-clip-speaker"
        onCommit={(next) => void edits.setSpeakerText(line.id, next)}
      />
      <VoiceInlineText
        label={t("voice.line.caption")}
        value={line.text}
        lockReason={lockReason}
        testId="voice-clip-caption"
        onCommit={(next) => void edits.setCaption(line.id, next)}
      />
      <VoiceIssueList issues={issues} />
      {error !== null && (
        <p role="alert" className="m-0 text-xs leading-[15px] text-error">
          {error}
        </p>
      )}
      <div className="grid gap-1">
        <span className="text-xs font-medium text-fg-3">{t("voice.take.title")}</span>
        <VoiceTakesList
          line={line}
          projectId={projectId}
          disabled={busy}
          lockReason={reason}
          onUse={(takeId) => void actions.chooseTake(line.id, takeId)}
        />
      </div>
      <div className="flex flex-wrap items-start gap-1.5">
        <VoiceGenerate
          lineIds={[line.id]}
          force
          label={t("voice.line.regenerate")}
          variant={line.textChanged ? "primary" : "secondary"}
          icon={<ArrowsClockwise aria-hidden size={12} />}
          disabledReason={state.view.voice === null ? t("voice.panel.needsVoice") : null}
          onGenerated={actions.followGenerated}
          testId="voice-clip-generate"
        />
        <VoiceCarveButton />
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowSquareOut aria-hidden size={12} />}
          data-testid="voice-clip-open-tab"
          onClick={openVoiceoverTab}
        >
          {t("voice.inspector.openTab")}
        </Button>
      </div>
    </div>
  );
}
