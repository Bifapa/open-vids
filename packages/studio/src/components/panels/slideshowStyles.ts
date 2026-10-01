import { buttonBase, buttonSizes, buttonVariants } from "../ui/Button";

/** `.btn.sm` secondary, for the slide panels' plain buttons. */
export const SLIDE_BUTTON = `${buttonBase} ${buttonVariants.secondary} ${buttonSizes.sm} shrink-0`;

/** `.ta` / `.input`: a boxed field on surface-1. */
export const SLIDE_FIELD =
  "min-w-0 rounded-sm border border-border bg-surface-1 px-2 text-sm text-fg outline-hidden transition-colors placeholder:text-fg-3 hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
