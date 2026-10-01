import { ListChecks } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

const ERROR_PULSES_BEFORE_IDLE = 3;

/** The panel foot's Checks control, in the prototype status bar's `.sb-checks` style. */
export function SidebarLintButton({
  onLint,
  linting,
  findingCount,
  hasError,
}: {
  onLint: () => void;
  linting: boolean;
  findingCount?: number;
  hasError?: boolean;
}) {
  return (
    <div className="flex h-7 shrink-0 items-center border-t border-border-subtle bg-bg-0 px-1.5">
      <button
        type="button"
        onClick={onLint}
        disabled={linting}
        className={cn(
          "inline-flex h-5 items-center gap-1.5 rounded-xs px-1.5 text-xs text-fg-3 transition-colors duration-hover",
          "enabled:hover:bg-surface-2 enabled:hover:text-fg disabled:text-fg-disabled",
          "outline-hidden focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        )}
      >
        <ListChecks size={12} aria-hidden />
        {linting ? "Checking…" : "Run Checks"}
        {!linting && findingCount != null && findingCount > 0 && (
          <span
            key={findingCount}
            data-lint-badge={hasError ? "error" : "warning"}
            style={hasError ? { animationIterationCount: ERROR_PULSES_BEFORE_IDLE } : undefined}
            className={cn(
              "inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-pill px-1 text-2xs font-semibold tabular-nums",
              hasError
                ? "bg-error-soft text-error animate-pulse motion-reduce:animate-none"
                : "bg-warning-soft text-warning",
            )}
          >
            {findingCount}
            <span className="sr-only">
              {hasError ? " lint findings, including errors" : " lint findings, warnings only"}
            </span>
          </span>
        )}
      </button>
    </div>
  );
}
