import type { ReactNode } from "react";
import { ArrowSquareOut, WarningCircle, X } from "@phosphor-icons/react";
import { cn } from "../components/ui";
import { useTranslation } from "../i18n";

/** A link that leaves Studio: opened outside the editor, the way Studio opens every external page. */
export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={href}
      className={cn(
        "inline-flex min-w-0 items-center gap-0.5 rounded-xs text-fg-2 underline decoration-border-strong underline-offset-2",
        "outline-hidden transition-colors duration-hover hover:text-fg hover:decoration-fg-2",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
        className,
      )}
    >
      <span className="truncate">{children}</span>
      <ArrowSquareOut size={10} className="shrink-0 text-fg-3" aria-hidden />
    </a>
  );
}

/** A failure the user can read and dismiss, in place of the control that failed: the prototype's error note. */
export function InlineError({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-error/35 bg-error-soft px-2.5 py-2 text-sm leading-[17px] text-fg-2"
    >
      <WarningCircle size={12} weight="fill" className="mt-0.5 shrink-0 text-error" aria-hidden />
      <span className="min-w-0 flex-1">{message}</span>
      {onDismiss && (
        <button
          type="button"
          aria-label={t("common.dismissMessage")}
          onClick={onDismiss}
          className="shrink-0 rounded-sm text-fg-3 outline-hidden hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** A group heading in the Sources views: the prototype's `.sect-label`, with an optional note and trailing action. */
export function SectionHeading({
  title,
  note,
  aside,
  className,
}: {
  title: string;
  note?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-ctl-sm items-center justify-between gap-2 px-0.5", className)}>
      <h3 className="flex min-w-0 items-baseline gap-1.5 text-xs leading-[14px] font-semibold text-fg-2">
        {title}
        {note != null && (
          <span className="min-w-0 truncate font-normal text-fg-3 tabular-nums">{note}</span>
        )}
      </h3>
      {aside}
    </div>
  );
}

/** The prototype's `.note-box`: an inline notice inside a panel; `warn` for a caution. */
export function NoteBox({
  icon,
  warn = false,
  children,
  className,
}: {
  icon?: ReactNode;
  warn?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm leading-[17px] text-fg-2 [text-wrap:pretty]",
        warn
          ? "border-warning/35 bg-warning-soft [&_b]:text-fg"
          : "border-border-subtle bg-bg-1 [&_b]:text-fg",
        className,
      )}
    >
      {icon && (
        <span
          aria-hidden="true"
          className={cn("mt-0.5 flex shrink-0", warn ? "text-warning" : "text-fg-3")}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
