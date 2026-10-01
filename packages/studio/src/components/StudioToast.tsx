import { cn } from "./ui/cn";

interface StudioToastProps {
  message: string;
  tone?: "error" | "info";
  /** Plays the exit animation when true (owner removes the node after ~160ms). */
  leaving?: boolean;
  onDismiss?: () => void;
}

/** The prototype's toast: a raised `surface-2` card; an error keeps the card and inks the text. */
export function StudioToast({ message, tone, leaving, onDismiss }: StudioToastProps) {
  const isError = tone === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      className={`motion-reduce:animate-none ${leaving ? "hf-toast-exit" : "hf-toast-enter"}`}
    >
      <div
        className={cn(
          "relative flex max-w-[min(560px,calc(100vw-48px))] items-center gap-3 overflow-hidden rounded-lg border bg-surface-2 py-1.5 pl-3 pr-1.5 text-sm shadow-pop",
          isError ? "border-error/50 text-error" : "border-border-strong text-fg",
        )}
      >
        <span className="min-w-0 wrap-break-word py-0.5">{message}</span>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="flex size-ctl-xs shrink-0 items-center justify-center rounded-sm text-fg-3 transition-colors duration-hover hover:bg-surface-3 hover:text-fg focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            aria-label="Dismiss"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
