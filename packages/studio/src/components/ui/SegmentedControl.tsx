/**
 * SegmentedControl: the prototype's `.seg`, a single choice among two to five
 * options drawn as one inset strip (Media | Story | Edit, grid | list, All | Video).
 * A radio group: one tab stop, arrow keys move and choose, Home/End jump.
 */

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "./cn";

export interface SegmentedOption<T extends string> {
  value: T;
  /** Visible text in the `text` variant; the accessible name in both. */
  label: string;
  /** Leading glyph; the whole content in the `icon` variant. */
  icon?: ReactNode;
  /** Hover hint. Defaults to the label in the `icon` variant. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Names the group for assistive tech ("Workspace", "View"). */
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  /** Called with a different option's value. */
  onChange: (next: T) => void;
  /** `text` segments size to their label; `icon` segments are 26 px squares. */
  variant?: "text" | "icon";
  /** `md` 28 px strip (titlebar, toolbars), `sm` 22 px (panel heads, filters). */
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
}

/** Segment box per variant and strip size: icon segments are 26 px wide, text sizes to its label. */
const segmentSizes = {
  icon: { md: "h-[22px] w-[26px]", sm: "h-[18px] w-[26px]" },
  text: { md: "h-[22px] px-3 text-sm font-medium", sm: "h-[18px] px-2 text-xs font-medium" },
} as const;

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  variant = "text",
  size = "md",
  disabled,
  className,
}: SegmentedControlProps<T>) {
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((option) => !disabled && !option.disabled);
  // One tab stop: the chosen option, or the first enabled one when nothing matches.
  const tabStop = options.find((option) => option.value === value) ?? enabled[0];
  const choose = (next: SegmentedOption<T>) => {
    buttonsRef.current[options.indexOf(next)]?.focus();
    if (next.value !== value) onChange(next.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (enabled.length === 0) return;
    const current = enabled.findIndex((option) => option.value === value);
    const wrap = (index: number) => enabled[(index + enabled.length) % enabled.length];
    let next: SegmentedOption<T> | undefined;
    switch (event.key) {
      case "Home":
        next = enabled[0];
        break;
      case "End":
        next = enabled[enabled.length - 1];
        break;
      case "ArrowRight":
      case "ArrowDown":
        next = wrap(current + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = wrap(current - 1);
        break;
    }
    if (!next) return;
    event.preventDefault();
    choose(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-bg-0 p-0.5",
        className,
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        const isDisabled = disabled || option.disabled;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttonsRef.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={variant === "icon" ? option.label : undefined}
            title={option.title ?? (variant === "icon" ? option.label : undefined)}
            disabled={isDisabled}
            tabIndex={option === tabStop ? 0 : -1}
            onClick={() => choose(option)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-sm text-fg-3 select-none",
              "transition-[background-color,color] ease-standard duration-hover",
              segmentSizes[variant][size],
              "enabled:hover:bg-surface-2 enabled:hover:text-fg",
              "aria-checked:bg-surface-3 aria-checked:text-fg aria-checked:shadow-[inset_0_0_0_1px_var(--color-border-strong)]",
              "disabled:cursor-not-allowed disabled:text-fg-disabled",
              "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
            )}
          >
            {option.icon}
            {variant === "text" ? option.label : null}
          </button>
        );
      })}
    </div>
  );
}
