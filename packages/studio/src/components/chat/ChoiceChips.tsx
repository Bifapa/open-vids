import { useId } from "react";
import { cn } from "../ui/cn";

export interface Choice<T extends string> {
  value: T;
  label: string;
}

interface ChoiceChipsProps<T extends string> {
  /** Names the group for assistive tech. */
  label: string;
  value: T;
  choices: readonly Choice<T>[];
  onChange: (next: T) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * A small set of exclusive choices shown all at once. Native radios underneath, so arrow keys move
 * the choice and it layers inside any dialog (a dropdown would open under a modal's layer).
 */
export function ChoiceChips<T extends string>({
  label,
  value,
  choices,
  onChange,
  disabled,
  className,
}: ChoiceChipsProps<T>) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-wrap gap-1", className)}>
      {choices.map((choice) => (
        <label key={choice.value} className="relative inline-flex">
          <input
            type="radio"
            name={name}
            value={choice.value}
            checked={choice.value === value}
            disabled={disabled}
            onChange={() => onChange(choice.value)}
            className="peer sr-only"
          />
          <span
            className={cn(
              "inline-flex h-ctl-sm cursor-pointer select-none items-center rounded-sm border border-border-input bg-input px-2 text-step-11 text-text-2",
              "transition-colors duration-hover hover:border-border-strong hover:text-text-1",
              "peer-checked:border-accent/70 peer-checked:bg-accent/10 peer-checked:text-text-0",
              "peer-focus-visible:outline-solid peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-accent",
              "peer-disabled:cursor-not-allowed peer-disabled:opacity-40",
            )}
          >
            {choice.label}
          </span>
        </label>
      ))}
    </div>
  );
}
