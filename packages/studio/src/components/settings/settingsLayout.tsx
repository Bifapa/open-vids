import { useId, type ReactNode } from "react";
import { Check, WarningCircle } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

/** One Settings section: its heading, an optional lede under it and an optional meta line at the right. */
export function SettingsPage({
  title,
  lede,
  meta,
  children,
}: {
  title: string;
  lede?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[640px]" data-settings-page={title}>
      <div className="mb-1 flex items-end justify-between gap-4">
        <h1 className="m-0 text-lg leading-4 font-semibold tracking-[-0.005em] text-fg">{title}</h1>
        {meta && (
          <span className="flex items-center gap-2 whitespace-nowrap text-xs text-fg-3">
            {meta}
          </span>
        )}
      </div>
      {lede && <p className="mt-1 text-sm leading-[17px] text-fg-3 text-pretty">{lede}</p>}
      {children}
    </div>
  );
}

/** A labelled box of rows (prototype `.st-group`): label and note above, rows split by hairlines. */
export function SettingsGroup({
  label,
  note,
  action,
  footer,
  className,
  children,
}: {
  label: string;
  note?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("mt-5", className)}>
      <div className="flex min-w-0 items-baseline gap-1.5 px-0.5 pb-1.5 text-xs font-semibold text-fg-2 [&:lang(ru)]:flex-wrap">
        <span id={id} className="[&:lang(ru)]:shrink-0">
          {label}
        </span>
        {note && (
          <span className="min-w-0 truncate font-normal text-fg-3 tabular-nums">{note}</span>
        )}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="divide-y divide-border-subtle rounded-md border border-border-subtle bg-bg-1">
        {children}
      </div>
      {footer && <div className="mx-0.5 mt-1.5 text-xs leading-[15px] text-fg-3">{footer}</div>}
    </section>
  );
}

/** A label (and hint) on the left, its control on the right (prototype `.st-row`). */
export function SettingsRow({
  label,
  hint,
  disabled,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid min-h-row-lg grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-3 py-row-pad",
        className,
      )}
    >
      <div className="grid min-w-0 gap-px">
        <span className={cn("text-base leading-4 text-fg", disabled && "text-fg-disabled")}>
          {label}
        </span>
        {hint && (
          <span
            className={cn(
              "text-xs leading-[14px] text-fg-3 text-pretty",
              disabled && "text-fg-disabled",
            )}
          >
            {hint}
          </span>
        )}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1.5">{children}</div>
    </div>
  );
}

/** Underlined inline action (prototype `.link`). */
export function SettingsLink({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-xs p-0 text-fg-2 underline decoration-border-strong underline-offset-2",
        "enabled:hover:text-fg enabled:hover:decoration-fg-2 disabled:cursor-not-allowed disabled:text-fg-disabled",
        "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
      )}
    >
      {children}
    </button>
  );
}

/** Loading / unavailable state for a section whose data has not arrived. */
export function SettingsUnavailable({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div role="status" className="mt-5 flex flex-col items-start gap-2 text-sm text-fg-3">
      <p className="m-0">{message}</p>
      {action}
    </div>
  );
}

/** "Saving…" or the last save error, for a section heading's meta slot. */
export function SaveStatus({ status, failed }: { status: string | null; failed: boolean }) {
  return (
    <span aria-live="polite" className={cn("text-xs", failed ? "text-error" : "text-fg-3")}>
      {status && <span role={failed ? "alert" : undefined}>{status}</span>}
    </span>
  );
}

const STATUS_TONES = {
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
} as const;

/** A short status with its glyph (prototype `.status`): a check for success, an alert for warning and error. */
export function SettingsStatus({
  tone,
  wrap,
  className,
  children,
}: {
  tone: keyof typeof STATUS_TONES;
  /** Let a long message wrap instead of staying on one line. */
  wrap?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const Glyph = tone === "success" ? Check : WarningCircle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium",
        wrap ? "leading-[14px]" : "whitespace-nowrap",
        STATUS_TONES[tone],
        className,
      )}
    >
      <Glyph aria-hidden className="size-icon-sm shrink-0" />
      {children}
    </span>
  );
}
