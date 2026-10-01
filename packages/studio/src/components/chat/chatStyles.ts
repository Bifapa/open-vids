/**
 * Class recipes the chat panel shares (the prototype's `.ov-chat-*`, `.note-box`, `.sect-label`, `.link`).
 * Width adapts with container queries on the panel (`@container/chat` in AgentChatPanel), never the viewport:
 * narrow < 300 px, default, wide ≥ 440 px.
 */

/** The panel's horizontal padding: 10 / 12 / 16 px. */
export const chatPadX = "px-3 @max-[299px]/chat:px-2.5 @min-[440px]/chat:px-4";

/** Focus ring for chat-only controls drawn inside a row. */
export const chatFocus =
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent";

/** A quiet inline box inside the feed (plan, brief, result, QA). */
export const noteBox =
  "grid gap-1.5 rounded-md border border-border-subtle bg-bg-1 px-2.5 py-2 text-sm leading-[17px] text-fg-2 text-pretty";

/** The warning variant (a revert conflict). */
export const noteBoxWarn =
  "grid gap-1.5 rounded-md border border-warning/35 bg-warning-soft px-2.5 py-2 text-sm leading-[17px] text-fg text-pretty";

/** A section label in a list ("Working", "Vision activity"). */
export const sectLabel =
  "flex min-w-0 items-baseline gap-1.5 text-xs leading-[14px] font-semibold text-fg-2";

/** An inline text action ("Undo", "Try again"). */
export const chatLink =
  "rounded-xs text-fg-2 underline decoration-border-strong underline-offset-2 hover:text-fg hover:decoration-fg-2 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/** A row that highlights on hover like the prototype's `.sel-item`. */
export const selItem =
  "rounded-md border border-transparent hover:border-border-subtle hover:bg-surface-1 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/** Text width caps on a wide dock, so lines keep a readable measure. */
export const chatMeasure = "@min-[440px]/chat:max-w-[68ch]";
export const chatMeasureWide = "@min-[440px]/chat:max-w-[72ch]";
