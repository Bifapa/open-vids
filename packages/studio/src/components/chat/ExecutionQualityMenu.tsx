import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, Gauge, PencilSimple } from "@phosphor-icons/react";
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
import { cn } from "../ui/cn";
import { Popover } from "../ui/Popover";
import { ChatDialog } from "./ChatDialog";
import { ExecutionBudgetFields } from "./ExecutionBudgetFields";
import { EXECUTION_PRESET_BLURBS, EXECUTION_PRESET_LABELS, describeBudget } from "./qaLabels";

const LOCKED_REASON = "Execution quality can't change while this chat is working.";
const FIXED_PRESETS: readonly FixedExecutionQualityPreset[] = ["fast", "balanced", "best"];

type Row = "default" | FixedExecutionQualityPreset | "custom";

function QualityRow({
  row,
  title,
  blurb,
  budget,
  checked,
  disabled,
  trailing,
  onSelect,
}: {
  row: Row;
  title: string;
  /** What the choice is for, beside its name. */
  blurb: string;
  /** What it changes, as numbers (`describeBudget`). */
  budget: string;
  checked: boolean;
  disabled: boolean;
  trailing?: ReactNode;
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
        "flex w-full items-start gap-2 px-3 py-1.5 text-left outline-hidden transition-colors duration-hover",
        "enabled:hover:bg-hover focus-visible:bg-hover disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <span className="mt-0.5 flex w-3 shrink-0 justify-center">
        {checked && <Check size={11} weight="bold" aria-hidden className="text-accent" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5 text-step-11">
          <span className="shrink-0 font-medium text-text-1">{title}</span>
          {trailing}
          <span className="min-w-0 truncate text-step-10 text-text-3">{blurb}</span>
        </span>
        <span className="block text-step-10 leading-snug text-text-4">{budget}</span>
      </span>
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
      title="Custom execution quality"
      description="How hard the agents work on this chat's next turns."
      className="w-[min(440px,calc(100vw-2rem))]"
      footer={
        <>
          {locked && <span className="mr-auto text-step-10 text-container">{LOCKED_REASON}</span>}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={saving}
            disabled={locked}
            title={locked ? LOCKED_REASON : undefined}
            onClick={() => void save()}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1 text-step-10 text-text-3">
          <span>Start from</span>
          {FIXED_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={locked}
              onClick={() => setDraft({ ...EXECUTION_BUDGETS[preset] })}
              className="rounded-sm px-1.5 py-0.5 font-medium text-accent outline-hidden transition-colors duration-hover enabled:hover:bg-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
            >
              {EXECUTION_PRESET_LABELS[preset]}
            </button>
          ))}
        </div>
        <ExecutionBudgetFields value={draft} onChange={setDraft} disabled={locked} />
        {error && (
          <p role="alert" className="text-step-11 text-danger">
            {error}
          </p>
        )}
      </div>
    </ChatDialog>
  );
}

/**
 * The chat's Execution Quality: Fast / Balanced / Best / Custom, or the global default. Each choice says what it
 * changes; Custom opens an editor for the whole budget.
 */
export function ExecutionQualityMenu({ chat }: { chat: ChatSummary }) {
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
  const label = EXECUTION_PRESET_LABELS[quality.preset];
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
      aria-label={`Execution quality: ${label}${custom ? "" : " (default)"}`}
      title="Execution quality: how hard the agents work on this chat's turns"
      className={cn(
        "flex h-ctl-sm shrink-0 items-center gap-1 rounded-sm px-1.5 text-step-11 text-text-2",
        "outline-hidden transition-colors duration-hover hover:bg-hover hover:text-text-0",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
        "data-[popup-open]:bg-hover data-[popup-open]:text-text-0",
      )}
    >
      <Gauge size={13} aria-hidden />
      {label}
      {!custom && <span className="text-step-10 text-text-4">default</span>}
    </button>
  );

  return (
    <>
      <Popover
        trigger={trigger}
        open={open}
        onOpenChange={setOpen}
        side="bottom"
        align="end"
        aria-label="Execution quality for this chat"
        className="w-80 p-0"
      >
        <div className="px-3 pb-1 pt-2.5">
          <p className="text-step-11 font-semibold text-text-0">Execution quality</p>
          <p className="text-step-10 text-text-3">
            How hard the agents work on this chat's next turns: render QA, Vision, research and
            thinking.
          </p>
        </div>
        <div role="radiogroup" aria-label="Execution quality" className="flex flex-col py-1">
          <QualityRow
            row="default"
            title={
              globalQuality
                ? `Default · ${EXECUTION_PRESET_LABELS[globalQuality.preset]}`
                : "Default"
            }
            blurb="your global setting"
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
              title={EXECUTION_PRESET_LABELS[preset]}
              blurb={EXECUTION_PRESET_BLURBS[preset]}
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
            title="Custom"
            blurb="your own budget"
            budget={describeBudget(clampExecutionBudget(quality.custom))}
            checked={checked === "custom"}
            disabled={locked || pending}
            trailing={<PencilSimple size={11} aria-hidden className="text-text-4" />}
            onSelect={() => {
              setOpen(false);
              setError(null);
              setEditing(true);
            }}
          />
        </div>
        {(locked || error) && (
          <p
            role={error ? "alert" : undefined}
            className={cn("px-3 pb-2 text-step-10", error ? "text-danger" : "text-container")}
          >
            {error ?? LOCKED_REASON}
          </p>
        )}
      </Popover>
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
