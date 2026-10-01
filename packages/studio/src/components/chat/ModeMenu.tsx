import { useState, type KeyboardEvent } from "react";
import { ChatCircleText, Check } from "@phosphor-icons/react";
import { CHAT_INTENTS, type ChatIntent, type ChatSummary } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { runningTurn } from "../../agent/agentSelectors";
import { useTranslation, type TranslationKey } from "../../i18n";
import { cn } from "../ui/cn";
import {
  ChipCaret,
  ComposerPopover,
  LOCKED_REASON,
  PopoverHelp,
  chipClass,
  chipIconClass,
  chipLabelClass,
} from "./composerParts";

/** The Mode chip's choices: what the next turns do. */
export const INTENT_LABELS: Record<
  ChatIntent,
  { name: TranslationKey; description: TranslationKey }
> = {
  plan: { name: "chat.intent.plan", description: "chat.mode.plan.description" },
  edit: { name: "chat.intent.edit", description: "chat.mode.edit.description" },
  ask: { name: "chat.intent.ask", description: "chat.mode.ask.description" },
};

/** Up/Down move between the choices, like the prototype's popover navigation. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]"),
  ];
  const index = items.findIndex((item) => item === document.activeElement);
  if (index === -1) return;
  event.preventDefault();
  items[
    Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
  ]?.focus();
}

/** Plan / Edit / Ask: the chat's intent, persisted on the chat and applied to each turn it starts. */
export function ModeMenu({ chat }: { chat: ChatSummary }) {
  const { t } = useTranslation();
  const locked = useAgentStore((state) => runningTurn(state.chat) !== null);
  const setIntent = useAgentStore((state) => state.setIntent);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intent = chat.intent ?? "edit";
  const current = INTENT_LABELS[intent];

  const choose = async (next: ChatIntent) => {
    setError(null);
    const result = await setIntent(next);
    if (result.ok) setOpen(false);
    else setError(result.message);
  };

  const trigger = (
    <button
      type="button"
      data-chip="mode"
      aria-label={t("chat.mode.chipAria", {
        name: t(current.name),
        description: t(current.description),
      })}
      title={t("chat.mode.chipTitle", {
        name: t(current.name),
        description: t(current.description),
      })}
      className={chipClass}
    >
      <ChatCircleText
        size={12}
        aria-hidden
        className={`${chipIconClass} hidden @min-[440px]/composer:inline @max-[299px]/composer:inline`}
      />
      <span className={chipLabelClass}>{t(current.name)}</span>
      <ChipCaret />
    </button>
  );

  return (
    <ComposerPopover
      trigger={trigger}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
      title={t("chat.mode.title")}
      narrow
    >
      <div
        role="menu"
        aria-label={t("chat.mode.title")}
        onKeyDown={moveFocus}
        className="grid gap-px"
      >
        {CHAT_INTENTS.map((option) => {
          const label = INTENT_LABELS[option];
          const checked = option === intent;
          return (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              aria-label={t("chat.mode.optionAria", {
                name: t(label.name),
                description: t(label.description),
              })}
              disabled={locked}
              onClick={() => {
                if (checked) setOpen(false);
                else void choose(option);
              }}
              className={cn(
                "grid w-full grid-cols-[16px_minmax(0,1fr)] items-center gap-x-1.5 gap-y-px rounded-md border border-transparent py-[5px] pr-2 pl-1 text-left",
                "outline-hidden enabled:hover:border-border-subtle enabled:hover:bg-surface-1",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "row-start-1 inline-flex justify-center text-fg",
                  !checked && "invisible",
                )}
              >
                <Check size={12} weight="bold" />
              </span>
              <span className="col-start-2 text-sm leading-4 font-medium text-fg">
                {t(label.name)}
              </span>
              <span className="col-start-2 text-xs leading-[14px] text-pretty text-fg-3">
                {t(label.description)}
              </span>
            </button>
          );
        })}
      </div>
      {(locked || error) && (
        <PopoverHelp tone={error ? "error" : "warning"}>{error ?? t(LOCKED_REASON)}</PopoverHelp>
      )}
    </ComposerPopover>
  );
}
