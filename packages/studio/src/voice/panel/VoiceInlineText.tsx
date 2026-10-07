import { useId, useRef, useState } from "react";
import type { VoiceDialect } from "@hyperframes/agent-protocol";
import { VoiceTaggedText } from "../../components/chat/VoiceTaggedText";
import { cn } from "../../components/ui";
import { useTranslation } from "../../i18n";

const FIELD =
  "w-full resize-y rounded-sm border border-border bg-surface-1 px-2 py-[5px] text-sm leading-4 text-fg outline-hidden " +
  "placeholder:text-fg-disabled hover:border-border-strong " +
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

interface VoiceInlineTextProps {
  /** The field's name: its label, and the button's accessible name. */
  label: string;
  value: string;
  /** Draws the dialect's tags as chips in the resting text. */
  dialect?: VoiceDialect | null;
  placeholder?: string;
  /** The write is refused: why (shown as the tooltip) — the text is then read-only. */
  lockReason?: string | null;
  /** The text may not be empty (the service refuses an empty line). */
  required?: boolean;
  testId: string;
  /** Called with the new text when the user commits it (blur or ⌘/Ctrl+Enter) and it changed. */
  onCommit: (next: string) => void;
}

/**
 * A line of the script as text: the words with the dialect's tags drawn as chips, and a click turns it into a field.
 * Blur or ⌘/Ctrl+Enter saves, Escape drops the edit. Nothing is written while the text is unchanged.
 */
export function VoiceInlineText({
  label,
  value,
  dialect = null,
  placeholder,
  lockReason = null,
  required = true,
  testId,
  onCommit,
}: VoiceInlineTextProps) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  // Escape and the blur it causes both end the edit; only the first may write.
  const settled = useRef(false);

  const finish = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = (draft ?? value).trim();
    setDraft(null);
    if (save && next !== value.trim() && (!required || next !== "")) onCommit(next);
  };

  if (draft === null) {
    const locked = lockReason !== null;
    return (
      <div className="grid gap-0.5">
        <span id={`${id}-label`} className="text-xs font-medium text-fg-3">
          {label}
        </span>
        <button
          type="button"
          data-testid={testId}
          aria-labelledby={`${id}-label`}
          aria-disabled={locked || undefined}
          title={lockReason ?? t("voice.line.editHint")}
          onClick={() => {
            if (locked) return;
            settled.current = false;
            setDraft(value);
          }}
          className={cn(
            "min-h-6 w-full rounded-sm border border-transparent px-1 py-[3px] text-left text-sm leading-[17px] text-fg [overflow-wrap:anywhere] [text-wrap:pretty]",
            "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
            locked ? "cursor-default" : "cursor-text hover:border-border hover:bg-surface-1",
          )}
        >
          {value === "" ? (
            <span className="text-fg-disabled">{placeholder}</span>
          ) : (
            <VoiceTaggedText text={value} dialect={dialect} />
          )}
        </button>
      </div>
    );
  }
  return (
    <div className="grid gap-0.5">
      <label htmlFor={id} className="text-xs font-medium text-fg-3">
        {label}
      </label>
      <textarea
        id={id}
        data-testid={`${testId}-field`}
        autoFocus
        value={draft}
        rows={Math.min(8, Math.max(2, draft.split("\n").length))}
        maxLength={10_000}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            finish(true);
          }
        }}
        className={FIELD}
      />
    </div>
  );
}
