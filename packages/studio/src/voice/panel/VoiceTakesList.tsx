import { CheckCircle } from "@phosphor-icons/react";
import type { VoiceLineView } from "@hyperframes/agent-protocol";
import { Badge, Button, cn } from "../../components/ui";
import { formatNumber, useTranslation } from "../../i18n";
import { resolveMediaPreviewUrl } from "../../player/components/thumbnailUtils";
import { VoicePlayButton } from "../VoicePlayButton";

/** A take's length as the list shows it: tenths of a second, the length a short line needs. */
function seconds(take: { start: number; end: number }): string {
  return formatNumber(Math.max(0, take.end - take.start), { maximumFractionDigits: 1 });
}

/**
 * The takes of a line, newest last as they were made. Each can be played (its range of its file, straight from the
 * project) and the one that is not in use can be switched to: nothing is paid, the take already exists.
 */
export function VoiceTakesList({
  line,
  projectId,
  disabled,
  lockReason,
  onUse,
}: {
  line: VoiceLineView;
  projectId: string;
  /** Switching is refused right now (a write is on its way, or an agent turn runs). */
  disabled: boolean;
  lockReason: string | null;
  onUse: (takeId: string) => void;
}) {
  const { t } = useTranslation();
  if (line.takes.length === 0) {
    return (
      <p data-testid="voice-takes-empty" className="m-0 text-xs text-fg-3">
        {t("voice.take.none")}
      </p>
    );
  }
  return (
    <ol data-testid="voice-takes" className="m-0 grid list-none gap-1 p-0">
      {line.takes.map((take, index) => {
        const selected = take.id === line.selectedTakeId;
        const olderText = take.speakerText !== line.speakerText || take.style !== line.style;
        return (
          <li
            key={take.id}
            data-testid="voice-take"
            data-take-id={take.id}
            data-selected={selected || undefined}
            className={cn(
              "flex min-w-0 items-center gap-1.5 rounded-sm border px-1.5 py-1",
              selected ? "border-accent-line bg-accent-soft" : "border-border-subtle bg-surface-1",
            )}
          >
            <VoicePlayButton
              soundKey={`voice-take:${line.id}:${take.id}`}
              label={t("voice.take.play", { number: index + 1 })}
              size="xs"
              source={() => ({
                url: resolveMediaPreviewUrl(take.file, projectId),
                range: { start: take.start, end: take.end },
              })}
            />
            <span className="grid min-w-0 flex-1 gap-px">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-fg">
                <span className="font-medium">{t("voice.take.number", { number: index + 1 })}</span>
                <span className="text-xs tabular-nums text-fg-3">
                  {t("voice.take.length", { seconds: seconds(take) })}
                </span>
                {olderText && (
                  <Badge size="sm" tone="warning" title={take.speakerText}>
                    {t("voice.take.olderText")}
                  </Badge>
                )}
              </span>
              <span
                className="truncate text-xs text-fg-3"
                title={`${take.voiceId} · ${take.model}`}
              >
                {take.voiceId} · {take.model}
              </span>
            </span>
            {selected ? (
              <span
                data-testid="voice-take-selected"
                className="flex shrink-0 items-center gap-1 text-xs font-medium text-fg-2"
              >
                <CheckCircle aria-hidden weight="fill" className="size-icon-sm text-accent" />
                {t("voice.take.inUse")}
              </span>
            ) : (
              <Button
                size="xs"
                variant="secondary"
                data-testid="voice-take-use"
                disabled={disabled}
                title={lockReason ?? undefined}
                aria-label={t("voice.take.useAria", { number: index + 1 })}
                onClick={() => onUse(take.id)}
              >
                {t("voice.take.use")}
              </Button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
