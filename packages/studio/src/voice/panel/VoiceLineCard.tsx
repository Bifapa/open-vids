import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CaretDown,
  CaretRight,
  Crosshair,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import type { VoiceDialect, VoiceLineView } from "@hyperframes/agent-protocol";
import { Badge, Button, IconButton, Tooltip } from "../../components/ui";
import { formatNumber, useTranslation } from "../../i18n";
import { usePlayerStore } from "../../player";
import { selectAndRevealTimelineElement } from "../../player/components/timelineDropReveal";
import { resolveMediaPreviewUrl } from "../../player/components/thumbnailUtils";
import { voiceClipsOfLine } from "../clip/voiceClipPatch";
import { useVoiceClipOpsContext } from "../clip/voiceClipOpsContext";
import { selectedTakeOf } from "../script/voiceScriptStore";
import { useLineIssues, useVoiceEditLock } from "../script/useVoiceScript";
import { VoicePlayButton } from "../VoicePlayButton";
import { VoiceGenerate } from "./VoiceGenerate";
import { VoiceInlineText } from "./VoiceInlineText";
import { VoiceIssueList } from "./VoiceIssueList";
import { VoiceTakesList } from "./VoiceTakesList";
import { useVoiceLineEdits } from "./useVoiceLineEdits";
import { useVoiceTakeActions } from "./useVoiceTakeActions";

interface VoiceLineCardProps {
  line: VoiceLineView;
  index: number;
  count: number;
  projectId: string;
  dialect: VoiceDialect | null;
  /** The project has a voice: without one nothing can be generated. */
  hasVoice: boolean;
  /** A script write is on its way. */
  writing: boolean;
}

/**
 * One line of the script in the Voiceover tab: what is read (tags as chips), what the captions say, its takes, and
 * the actions that belong to it — generate or regenerate (asking first), place on the timeline, move, remove. Every
 * action that writes is off while an agent turn runs.
 */
export function VoiceLineCard({
  line,
  index,
  count,
  projectId,
  dialect,
  hasVoice,
  writing,
}: VoiceLineCardProps) {
  const { t } = useTranslation();
  const { locked, reason } = useVoiceEditLock();
  const edits = useVoiceLineEdits();
  const actions = useVoiceTakeActions();
  const clips = useVoiceClipOpsContext();
  const issues = useLineIssues(line.id);
  const elements = usePlayerStore((state) => state.elements);
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const take = selectedTakeOf(line);
  const placed = voiceClipsOfLine(elements, line.id);
  const first = placed[0];
  const onTimeline = placed.length > 0 || line.clipIds.length > 0;
  const busy = writing || locked;
  const error = edits.error ?? actions.error;

  const status = take
    ? t("voice.line.takeStatus", {
        number: line.takes.findIndex((entry) => entry.id === take.id) + 1,
        total: line.takes.length,
        seconds: formatNumber(line.durationSeconds ?? take.end - take.start, {
          maximumFractionDigits: 1,
        }),
      })
    : t("voice.line.noTake");

  return (
    <li
      data-testid="voice-line"
      data-line-id={line.id}
      className="grid gap-1.5 border-b border-border-subtle px-3 py-2.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {take ? (
          <VoicePlayButton
            soundKey={`voice-line:${line.id}`}
            label={t("voice.line.play", { number: index + 1 })}
            size="xs"
            source={() => ({
              url: resolveMediaPreviewUrl(take.file, projectId),
              range: { start: take.start, end: take.end },
            })}
          />
        ) : null}
        <span className="text-xs font-medium tabular-nums text-fg-3">{index + 1}</span>
        <span data-testid="voice-line-status" className="min-w-0 text-xs text-fg-3">
          {status}
        </span>
        {line.textChanged && (
          <Badge tone="warning" size="sm" data-testid="voice-line-text-changed">
            {t("voice.line.textChanged")}
          </Badge>
        )}
        {onTimeline && (
          <Badge size="sm" data-testid="voice-line-on-timeline">
            {t("voice.line.onTimeline")}
          </Badge>
        )}
      </div>

      <VoiceInlineText
        label={t("voice.line.speakerText")}
        value={line.speakerText}
        dialect={dialect}
        lockReason={busy ? (reason ?? t("voice.panel.saving")) : null}
        testId="voice-line-speaker"
        onCommit={(next) => void edits.setSpeakerText(line.id, next)}
      />
      <VoiceIssueList issues={issues} />
      {error !== null && (
        <p role="alert" className="m-0 text-xs leading-[15px] text-error">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-start gap-1.5">
        <VoiceGenerate
          lineIds={[line.id]}
          force
          label={take ? t("voice.line.regenerate") : t("voice.line.generate")}
          variant={take && !line.textChanged ? "secondary" : "primary"}
          disabledReason={hasVoice ? null : t("voice.panel.needsVoice")}
          onGenerated={actions.followGenerated}
          testId="voice-line-generate"
        />
        {take && !onTimeline && clips !== null && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus aria-hidden size={12} />}
            data-testid="voice-line-add"
            disabled={busy}
            title={reason ?? undefined}
            onClick={() => void clips.addLines([{ lineId: line.id, take }])}
          >
            {t("voice.line.addToTimeline")}
          </Button>
        )}
        {first && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Crosshair aria-hidden size={12} />}
            data-testid="voice-line-show"
            onClick={() => selectAndRevealTimelineElement(first.key ?? first.id)}
          >
            {t("voice.line.showOnTimeline")}
          </Button>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          <Tooltip label={t("voice.line.moveUp")}>
            <IconButton
              size="sm"
              aria-label={t("voice.line.moveUp")}
              icon={<ArrowUp aria-hidden size={12} />}
              disabled={busy || index === 0}
              onClick={() => void edits.moveLine(line.id, -1)}
            />
          </Tooltip>
          <Tooltip label={t("voice.line.moveDown")}>
            <IconButton
              size="sm"
              aria-label={t("voice.line.moveDown")}
              icon={<ArrowDown aria-hidden size={12} />}
              disabled={busy || index === count - 1}
              onClick={() => void edits.moveLine(line.id, 1)}
            />
          </Tooltip>
          <Tooltip label={t("voice.line.remove")}>
            <IconButton
              size="sm"
              aria-label={t("voice.line.remove")}
              data-testid="voice-line-remove"
              icon={<Trash aria-hidden size={12} />}
              disabled={busy}
              onClick={() => {
                if (line.takes.length === 0 && !onTimeline) void edits.removeLine(line.id);
                else setRemoving(true);
              }}
            />
          </Tooltip>
        </span>
      </div>

      {removing && (
        <div
          role="alertdialog"
          aria-label={t("voice.line.removeConfirmTitle")}
          data-testid="voice-line-remove-confirm"
          className="grid gap-1.5 rounded-sm border border-border bg-surface-1 p-2"
        >
          <p className="m-0 text-xs leading-[15px] text-fg-2">
            {onTimeline
              ? t("voice.line.removeOnTimeline", {
                  count: Math.max(placed.length, line.clipIds.length),
                })
              : t("voice.line.removeTakes", { count: line.takes.length })}
          </p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="danger"
              data-testid="voice-line-remove-yes"
              disabled={busy}
              onClick={() => {
                setRemoving(false);
                void edits.removeLine(line.id);
              }}
            >
              {t("common.remove")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRemoving(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}

      <button
        type="button"
        data-testid="voice-line-details"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-fit items-center gap-1 rounded-sm text-xs text-fg-3 outline-hidden hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {open ? <CaretDown aria-hidden size={10} /> : <CaretRight aria-hidden size={10} />}
        {t("voice.line.details")}
      </button>
      {open && (
        <div data-testid="voice-line-details-body" className="grid gap-2">
          <VoiceInlineText
            label={t("voice.line.caption")}
            value={line.text}
            lockReason={busy ? (reason ?? t("voice.panel.saving")) : null}
            testId="voice-line-caption"
            onCommit={(next) => void edits.setCaption(line.id, next)}
          />
          <VoiceInlineText
            label={t("voice.line.style")}
            value={line.style}
            required={false}
            placeholder={t("voice.line.stylePlaceholder")}
            lockReason={busy ? (reason ?? t("voice.panel.saving")) : null}
            testId="voice-line-style"
            onCommit={(next) => void edits.setStyle(line.id, next)}
          />
          <VoiceTakesList
            line={line}
            projectId={projectId}
            disabled={busy}
            lockReason={reason}
            onUse={(takeId) => void actions.chooseTake(line.id, takeId)}
          />
        </div>
      )}
    </li>
  );
}
