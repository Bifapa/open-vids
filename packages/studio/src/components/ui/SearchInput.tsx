import { type InputHTMLAttributes } from "react";
import { cn } from "./cn";

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Accessible name — placeholder alone is not one. */
  "aria-label": string;
}

/**
 * Shared search input, the prototype's `.field`: an inset well on the panel
 * background with a leading magnifier, so every panel search reads the same and
 * carries a required accessible name.
 */
export function SearchInput({ className, ...props }: SearchInputProps) {
  return (
    <div
      className={cn(
        "flex h-ctl-sm min-w-0 items-center gap-1.5 rounded-md border border-border bg-bg-0 px-2 text-fg-3",
        "transition-[border-color] ease-standard duration-focus hover:border-border-strong",
        "focus-within:border-border-strong focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent",
        className,
      )}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 256 256"
        fill="none"
        className="shrink-0"
        aria-hidden="true"
      >
        <circle cx="116" cy="116" r="76" stroke="currentColor" strokeWidth="22" />
        <line
          x1="170"
          y1="170"
          x2="232"
          y2="232"
          stroke="currentColor"
          strokeWidth="22"
          strokeLinecap="round"
        />
      </svg>
      <input
        type="text"
        className="h-full min-w-0 w-full bg-transparent text-sm text-fg outline-hidden placeholder:text-fg-3"
        {...props}
      />
    </div>
  );
}
