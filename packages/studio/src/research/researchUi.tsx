import type { ReactNode } from "react";
import { ArrowSquareOut, WarningCircle, X } from "@phosphor-icons/react";
import { cn } from "../components/ui";

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
        "inline-flex min-w-0 items-center gap-0.5 rounded-xs text-selection underline-offset-2 outline-hidden hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
        className,
      )}
    >
      <span className="truncate">{children}</span>
      <ArrowSquareOut size={10} className="shrink-0" aria-hidden />
    </a>
  );
}

/** A failure the user can read and dismiss, in place of the control that failed. */
export function InlineError({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-step-11 text-text-1"
    >
      <WarningCircle size={13} weight="fill" className="mt-px shrink-0 text-danger" aria-hidden />
      <span className="min-w-0 flex-1">{message}</span>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss message"
          onClick={onDismiss}
          className="shrink-0 rounded-sm text-text-3 outline-hidden hover:text-text-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** A heading in the Sources panel, in the inspector's section style. */
export function SectionHeading({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-step-10 font-semibold uppercase tracking-wide text-text-3">{title}</h3>
      {aside}
    </div>
  );
}
