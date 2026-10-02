import { useRef, useState, type RefObject } from "react";
import { CaretDown, Check, Gauge, PencilSimple } from "@phosphor-icons/react";
import {
  DEFAULT_EXECUTION_QUALITY,
  EXECUTION_BUDGETS,
  clampExecutionBudget,
  resolveExecutionBudget,
  type ChatSummary,
  type ExecutionBudget,
  type ExecutionQuality,
  type FixedExecutionQualityPreset,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { chatExecutionQuality, runningTurn } from "../../agent/agentSelectors";
import { Button } from "../ui/Button";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { ChatDialog } from "./ChatDialog";
import {
  ComposerPopover,
  LOCKED_REASON,
  PopoverHelp,
  chipClass,
  chipIconClass,
} from "./composerParts";
import { ExecutionBudgetFields } from "./ExecutionBudgetFields";
import { EXECUTION_PRESET_BLURBS, EXECUTION_PRESET_LABELS, describeBudget } from "./qaLabels";

const FIXED_PRESETS: readonly FixedExecutionQualityPreset[] = ["fast", "balanced", "best"];

type Row = "default" | FixedExecutionQualityPreset | "custom";

/** One choice, in the Mode menu's row language: check, name, what it is for, what it changes. */
function QualityRow({
  row,
  title,
  blurb,
  budget,
  checked,
  disabled,
  editable = false,
  onSelect,
}: {
  row: Row;
  title: string;
  blurb: string;
  /** What it changes, as numbers (`describeBudget`). */
  budget: string;
  checked: boolean;
  disabled: boolean;
  /** Custom opens its editor. */
  editable?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-quality-row={row}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[16px_minmax(0,1fr)] items-center gap-x-1.5 gap-y-px rounded-md border border-transparent py-[5px] pr-2 pl-1 text-left",
        "outline-hidden enabled:hover:border-border-subtle enabled:hover:bg-surface-1",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      <span
        aria-hidden
        className={cn("row-start-1 inline-flex justify-center text-fg", !checked && "invisible")}
      >
        <Check size={12} weight="bold" />
      </span>
      <span className="col-start-2 flex min-w-0 items-center gap-x-1.5 gap-y-px [&:lang(ru)]:flex-wrap">
        <span className="shrink-0 text-sm leading-4 font-medium text-fg">{title}</span>
        {editable && <PencilSimple size={11} aria-hidden className="shrink-0 text-fg-3" />}
        <span className="min-w-0 truncate text-xs text-fg-3">{blurb}</span>
      </span>
      <span className="col-start-2 text-xs leading-[14px] text-pretty text-fg-3">{budget}</span>
    </button>
  );
}

/** The chat's own budget in an editor; Save makes the chat Custom. */
function CustomQualityDialog({
  initial,
  locked,
  finalFocus,
  onSave,
  onClose,
}: {
  initial: ExecutionBudget;
  locked: boolean;
  finalFocus: RefObject<HTMLElement | null>;
  onSave: (budget: ExecutionBudget) => Promise<{ ok: true } | { ok: false; message: string }>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => clampExecutionBudget(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await onSave(draft);
    setSaving(false);
    if (result.ok) onClose();
    else setError(result.message);
  };

  return (
    <ChatDialog
      open
      onClose={onClose}
      finalFocus={finalFocus}
      title={t("chat.quality.customDialog.title")}
      description={t("chat.quality.customDialog.description")}
      className="w-[min(440px,calc(100vw-2rem))]"
      footer={
        <>
          {locked && <span className="mr-auto text-xs text-warning">{t(LOCKED_REASON)}</span>}
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={saving}
            disabled={locked}
            title={locked ? t(LOCKED_REASON) : undefined}
            onClick={() => void save()}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1 text-xs text-fg-3">
          <span>{t("chat.quality.customDialog.startFrom")}</span>
          {FIXED_PRESETS.map((preset) => (
            <Button
              key={preset}
              size="xs"
              variant="ghost"
              disabled={locked}
              onClick={() => setDraft({ ...EXECUTION_BUDGETS[preset] })}
            >
              {t(EXECUTION_PRESET_LABELS[preset])}
            </Button>
          ))}
        </div>
        <ExecutionBudgetFields value={draft} onChange={setDraft} disabled={locked} />
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
      </div>
    </ChatDialog>
  );
}

/**
 * The chat's Execution Quality as a compact composer chip (gauge; its name from 440 px): Fast / Balanced / Best /
 * Custom, or the global default. Each choice says what it changes; Custom opens an editor for the whole budget.
 */
export function ExecutionQualityMenu({ chat }: { chat: ChatSummary }) {
  const { t } = useTranslation();
  const settings = useAgentStore((state) => state.settings);
  const locked = useAgentStore((state) => runningTurn(state.chat) !== null);
  const setExecutionQuality = useAgentStore((state) => state.setExecutionQuality);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const { quality, custom } = chatExecutionQuality(chat, settings);
  const globalQuality = settings?.executionQuality ?? null;
  const label = t(EXECUTION_PRESET_LABELS[quality.preset]);
  const checked: Row = custom ? quality.preset : "default";

  const commit = async (next: ExecutionQuality | null) => {
    setPending(true);
    setError(null);
    const result = await setExecutionQuality(next);
    setPending(false);
    if (result.ok) setOpen(false);
    else setError(result.message);
    return result;
  };

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      data-chip="quality"
      aria-label={t(custom ? "chat.quality.chipAria" : "chat.quality.chipAriaDefault", { label })}
      title={t(custom ? "chat.quality.chipTitle" : "chat.quality.chipTitleDefault", { label })}
      className={chipClass}
    >
      <Gauge size={12} aria-hidden className={chipIconClass} />
      <span className="hidden min-w-0 truncate @min-[440px]/composer:inline">{label}</span>
      {/* Below 440 px the gauge alone says it; the caret space goes to the model chip. */}
      <CaretDown
        size={10}
        weight="bold"
        aria-hidden
        className="hidden shrink-0 text-fg-3 @min-[440px]/composer:inline"
      />
    </button>
  );

  return (
    <>
      <ComposerPopover
        trigger={trigger}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(null);
        }}
        title={t("chat.quality.title")}
      >
        <PopoverHelp>{t("chat.quality.help")}</PopoverHelp>
        <div role="radiogroup" aria-label={t("chat.quality.title")} className="grid gap-px">
          <QualityRow
            row="default"
            title={
              globalQuality
                ? t("chat.quality.defaultNamed", {
                    name: t(EXECUTION_PRESET_LABELS[globalQuality.preset]),
                  })
                : t("common.default")
            }
            blurb={t("chat.quality.blurb.global")}
            budget={describeBudget(
              resolveExecutionBudget(globalQuality ?? DEFAULT_EXECUTION_QUALITY),
            )}
            checked={checked === "default"}
            disabled={locked || pending}
            onSelect={() => {
              if (custom) void commit(null);
              else setOpen(false);
            }}
          />
          {FIXED_PRESETS.map((preset) => (
            <QualityRow
              key={preset}
              row={preset}
              title={t(EXECUTION_PRESET_LABELS[preset])}
              blurb={t(EXECUTION_PRESET_BLURBS[preset])}
              budget={describeBudget(EXECUTION_BUDGETS[preset])}
              checked={checked === preset}
              disabled={locked || pending}
              onSelect={() => {
                if (checked === preset) setOpen(false);
                else void commit({ preset, custom: quality.custom });
              }}
            />
          ))}
          <QualityRow
            row="custom"
            title={t(EXECUTION_PRESET_LABELS.custom)}
            blurb={t("chat.quality.blurb.custom")}
            budget={describeBudget(clampExecutionBudget(quality.custom))}
            checked={checked === "custom"}
            disabled={locked || pending}
            editable
            onSelect={() => {
              setOpen(false);
              setError(null);
              setEditing(true);
            }}
          />
        </div>
        {(locked || error) && (
          <PopoverHelp tone={error ? "error" : "warning"}>{error ?? t(LOCKED_REASON)}</PopoverHelp>
        )}
      </ComposerPopover>
      {editing && (
        <CustomQualityDialog
          initial={quality.custom}
          locked={locked}
          finalFocus={triggerRef}
          onSave={(budget) => commit({ preset: "custom", custom: budget })}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
