import { CaretRight, Stack } from "@phosphor-icons/react";
import type { CompositionLevel } from "./CompositionBreadcrumb";

/**
 * The timeline head's sequence: the composition the tracks show, and — once
 * drilled into a sub-composition — the path back up, each level a button.
 */
export function TimelineSequenceCrumbs({
  stack,
  onNavigate,
}: {
  stack: readonly CompositionLevel[];
  onNavigate: (index: number) => void;
}) {
  const current = stack.at(-1);
  if (!current) return null;
  if (stack.length === 1) {
    return (
      <span className="shrink-0 truncate px-1.5 text-sm font-medium text-fg">{current.label}</span>
    );
  }
  return (
    <nav aria-label="Composition path" className="flex min-w-0 shrink items-center gap-0.5">
      {stack.slice(0, -1).map((level, index) => (
        <span key={level.id} className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => onNavigate(index)}
            title={
              index === stack.length - 2 ? "Back (Esc, or double-click empty timeline)" : undefined
            }
            className="h-ctl-sm rounded-sm px-1.5 text-sm text-fg-2 hover:bg-surface-2 hover:text-fg"
          >
            {level.label}
          </button>
          <CaretRight aria-hidden="true" className="size-icon-xs text-fg-3" />
        </span>
      ))}
      <span
        aria-current="page"
        className="flex min-w-0 items-center gap-[5px] px-1.5 text-sm font-semibold text-fg"
      >
        <Stack aria-hidden="true" className="size-icon-sm shrink-0 text-fg-3" />
        <span className="truncate">{current.label}</span>
      </span>
    </nav>
  );
}
