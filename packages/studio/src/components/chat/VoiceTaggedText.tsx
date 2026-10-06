import { Fragment } from "react";
import { voiceTextSegments, type VoiceDialect } from "@hyperframes/agent-protocol";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";

/**
 * Speaker text with the voice dialect's tags drawn as chips (`<sigh>`, `[whispers]` → a small chip), the words around
 * them as text. A tag the dialect does not document is drawn as a warning chip. With no dialect, or no tag in the
 * text, it is the plain string it always was.
 */
export function VoiceTaggedText({ text, dialect }: { text: string; dialect: VoiceDialect | null }) {
  const { t } = useTranslation();
  if (dialect === null) return <>{text}</>;
  const segments = voiceTextSegments(dialect, text);
  if (!segments.some((segment) => segment.kind === "tag")) return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <Fragment key={index}>{segment.text}</Fragment>
        ) : (
          <span
            key={index}
            data-voice-tag={segment.tag}
            data-voice-tag-known={segment.known}
            title={
              segment.known
                ? t("voice.plan.tag", { tag: segment.tag })
                : t("voice.plan.tagUnknown", { tag: segment.tag, dialect: dialect.name })
            }
            className={cn(
              "mx-px inline-flex h-[18px] items-center rounded-xs px-1 align-baseline text-xs font-medium leading-none",
              segment.known
                ? "bg-surface-3 text-fg-2"
                : "border border-dashed border-warning/60 bg-warning-soft text-warning",
            )}
          >
            {segment.tag}
          </span>
        ),
      )}
    </>
  );
}
