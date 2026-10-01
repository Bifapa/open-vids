import { ArrowLeft } from "@phosphor-icons/react";

export interface CompositionLevel {
  /** Unique id — "master" or composition file path */
  id: string;
  /** Display label — "Master" or filename without extension */
  label: string;
  /** Preview URL for this composition level */
  previewUrl: string;
}

interface CompositionBreadcrumbProps {
  stack: CompositionLevel[];
  onNavigate: (index: number) => void;
}

export function CompositionBreadcrumb({ stack, onNavigate }: CompositionBreadcrumbProps) {
  if (stack.length <= 1) return null;

  return (
    <nav
      aria-label="Composition navigation"
      className="flex h-head shrink-0 items-center gap-0.5 border-t border-border-subtle bg-bg-1 px-1.5"
    >
      {/* Back button — always goes to parent */}
      <button
        type="button"
        onClick={() => {
          onNavigate(stack.length - 2);
        }}
        className="flex size-ctl-sm items-center justify-center rounded-sm text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
        title="Back (Esc, or double-click empty timeline)"
        aria-label="Back to parent composition"
      >
        <ArrowLeft size={12} weight="bold" />
      </button>

      {/* Breadcrumb path */}
      {stack.map((level, i) => {
        const isLast = i === stack.length - 1;
        return (
          <span key={level.id} className="flex items-center gap-1">
            {i > 0 && (
              <span aria-hidden="true" className="mx-0.5 text-sm text-fg-3">
                ›
              </span>
            )}
            {isLast ? (
              <span aria-current="location" className="px-1.5 text-sm font-medium text-fg">
                {level.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  onNavigate(i);
                }}
                className="rounded-sm px-1.5 text-sm text-fg-2 transition-colors hover:bg-surface-1 hover:text-fg"
              >
                {level.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
