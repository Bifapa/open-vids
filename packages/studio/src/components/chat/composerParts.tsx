import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import { CaretDown, CaretLeft } from "@phosphor-icons/react";
import {
  isThinkingEffort,
  type AgentModelCatalog,
  type AgentModelInfo,
  type ModelSelection,
  type ThinkingEffort,
} from "@hyperframes/agent-protocol";
import { displayModelName, effortChoices, resolveModel } from "../../agent/agentSelectors";
import { cn } from "../ui/cn";
import { t, useTranslation, type TranslationKey } from "../../i18n";
import { IconButton } from "../ui/IconButton";
import { Popover } from "../ui/Popover";
import { SegmentedControl, type SegmentedOption } from "../ui/SegmentedControl";
import { EFFORT_LABELS } from "./agentLabels";
import { ModelList } from "./ModelList";

/** Where the composer's popovers mount: inside the chat panel, so they size to it and stay within it. */
export const ComposerPortalContext = createContext<HTMLElement | null>(null);

/** Said wherever a control is locked by the running turn (the runtime refuses changes mid-run). */
export const LOCKED_REASON: TranslationKey = "chat.locked";

/**
 * A composer selector (prototype `.tool-btn.ov-chat-chip`): 24 px, metadata weight, label + caret. Below 300 px
 * of panel the label and caret hide and only the leading icon stays.
 */
export const chipClass = cn(
  "inline-flex h-ctl-sm min-w-0 shrink-0 items-center gap-1 rounded-sm pl-2 pr-1.5 text-xs font-medium whitespace-nowrap text-fg-2",
  "outline-hidden transition-colors duration-hover hover:bg-surface-2 hover:text-fg",
  "aria-expanded:bg-surface-2 aria-expanded:text-fg data-[popup-open]:bg-surface-2 data-[popup-open]:text-fg",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
  "disabled:pointer-events-none disabled:text-fg-disabled",
  "@max-[299px]/composer:px-1.5",
);
export const chipLabelClass =
  "min-w-0 truncate tabular-nums @min-[440px]/composer:max-w-40 @max-[299px]/composer:hidden";
export const chipCaretClass = "shrink-0 text-fg-3 @max-[299px]/composer:hidden";
export const chipIconClass = "shrink-0 text-fg-3";

export function ChipCaret() {
  return <CaretDown size={10} weight="bold" aria-hidden className={chipCaretClass} />;
}

/**
 * A titled composer popover (prototype `.popover.ov-chat-popover`): 280 px or the panel less 16, above its chip,
 * a 32 px head with an optional back button, then the rows.
 */
export function ComposerPopover({
  trigger,
  open,
  onOpenChange,
  title,
  back,
  narrow = false,
  children,
}: {
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  back?: { label: string; onBack: () => void };
  /** The Mode menu's 248 px. */
  narrow?: boolean;
  children: ReactNode;
}) {
  const container = useContext(ComposerPortalContext);
  return (
    <Popover
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      side="top"
      align="center"
      sideOffset={8}
      collisionAvoidance={{ side: "none" }}
      container={container ?? undefined}
      aria-label={title}
      className={cn(
        "max-h-[var(--available-height)] overflow-x-hidden overflow-y-auto overscroll-contain p-1",
        narrow ? "w-[min(248px,calc(100cqw-16px))]" : "w-[min(280px,calc(100cqw-16px))]",
      )}
    >
      <div
        className={cn(
          "-mx-1 -mt-1 mb-1 flex h-head items-center gap-1.5 border-b border-border-subtle pr-1 select-none",
          back ? "pl-1" : "pl-3",
        )}
      >
        {back && (
          <IconButton
            size="sm"
            aria-label={back.label}
            icon={<CaretLeft size={12} aria-hidden />}
            onClick={back.onBack}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{title}</span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-px">{children}</div>
    </Popover>
  );
}

/** A labelled popover field (prototype `.ov-chat-field`). */
export function PopoverField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 px-1.5 pt-1.5 pb-1">
      <span className="text-xs font-medium text-fg-3">{label}</span>
      {children}
    </div>
  );
}

const HELP_TONES = {
  muted: "text-fg-3",
  warning: "text-warning",
  error: "text-error",
} as const;

/** Small print under the fields (prototype `.ov-chat-help`). */
export function PopoverHelp({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: keyof typeof HELP_TONES;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "m-0 px-1.5 pt-0.5 pb-1.5 text-xs leading-[15px] text-pretty",
        HELP_TONES[tone],
      )}
    >
      {children}
    </p>
  );
}

/** An underlined text button inside popover copy (prototype `.link`). */
export const linkClass = cn(
  "rounded-xs text-fg-2 underline decoration-border-strong underline-offset-2 outline-hidden",
  "hover:text-fg hover:decoration-fg-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
);

/** The model a field shows: the explicit choice, else "Default · <what it resolves to>". */
export function modelFieldLabel(
  catalog: AgentModelCatalog | null,
  catalogFailed: boolean,
  explicit: ModelSelection | null,
  fallback: ModelSelection | null,
): string {
  if (!catalog) return t(catalogFailed ? "chat.model.unavailable" : "chat.model.loading");
  const resolved = resolveModel(explicit, catalog, fallback);
  const name = displayModelName(resolved.selection, resolved.info);
  if (!resolved.selection) return t("chat.model.none");
  return explicit === null ? t("chat.model.defaultNamed", { name }) : name;
}

/** The prototype's `.sel` as a button: opens the searchable model list in the popover. */
export function ModelFieldButton({
  label,
  name,
  disabled,
  onOpen,
}: {
  label: string;
  /** Who the model is for, for assistive tech. */
  name: string;
  disabled: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t("chat.model.fieldLabel", { name, label })}
      aria-haspopup="listbox"
      disabled={disabled}
      title={disabled ? t(LOCKED_REASON) : undefined}
      onClick={onOpen}
      className={cn(
        "flex h-ctl-sm w-full min-w-0 items-center gap-1 rounded-sm border border-border bg-surface-1 pr-1.5 pl-2 text-left text-sm text-fg",
        "outline-hidden transition-colors duration-hover hover:border-border-strong",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:border-border-subtle disabled:bg-transparent disabled:text-fg-disabled",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <CaretDown size={12} aria-hidden className="shrink-0 text-fg-3" />
    </button>
  );
}

/** The popover's model list view: search + provider groups, sized to the popover. */
export function ModelChoice({
  catalog,
  explicit,
  fallback,
  onSelect,
}: {
  catalog: AgentModelCatalog;
  explicit: ModelSelection | null;
  fallback: ModelSelection | null;
  onSelect: (model: ModelSelection | null) => void;
}) {
  const resolved = resolveModel(null, catalog, fallback);
  return (
    <div className="p-1">
      <ModelList
        className="w-full"
        models={catalog.models}
        explicit={explicit}
        defaultName={
          resolved.selection ? displayModelName(resolved.selection, resolved.info) : null
        }
        onSelect={onSelect}
      />
    </div>
  );
}

/** Six or more segments do not fit 264 px with full names. */
const SHORT_EFFORT_LABELS: Record<ThinkingEffort, TranslationKey> = {
  off: "chat.effort.short.off",
  minimal: "chat.effort.short.minimal",
  low: "chat.effort.short.low",
  medium: "chat.effort.short.medium",
  high: "chat.effort.short.high",
  xhigh: "chat.effort.short.xhigh",
  max: "chat.effort.short.max",
};

/**
 * Thinking effort as the prototype's segmented strip: Default (the agent defaults) plus what the resolved model
 * accepts. A model without the control says so instead.
 */
export function EffortField({
  model,
  value,
  defaultEffort,
  disabled,
  onChange,
}: {
  /** The catalog entry of the model that will run; decides the choices. */
  model: AgentModelInfo | null;
  value: ThinkingEffort | null;
  /** What Default resolves to, for its tooltip. */
  defaultEffort: ThinkingEffort | null;
  disabled: boolean;
  onChange: (effort: ThinkingEffort | null) => void;
}) {
  const { t } = useTranslation();
  const choices = effortChoices(model);
  if (choices.length === 0) {
    return (
      <PopoverField label={t("chat.effort.field")}>
        <span className="text-xs text-fg-3">{t("chat.effort.noneAdjustable")}</span>
      </PopoverField>
    );
  }
  const compact = choices.length + 1 > 5;
  const labels = compact ? SHORT_EFFORT_LABELS : EFFORT_LABELS;
  const options: SegmentedOption<string>[] = [
    {
      value: "default",
      label: compact ? t("chat.effort.short.default") : t("common.default"),
      title: defaultEffort
        ? t("chat.effort.defaultWith", { effort: t(EFFORT_LABELS[defaultEffort]) })
        : t("common.default"),
    },
    ...choices.map((effort) => ({
      value: effort,
      label: t(labels[effort]),
      title: t("chat.effort.levelTitle", { effort: t(EFFORT_LABELS[effort]) }),
    })),
  ];
  // A choice the model no longer lists still shows as chosen.
  if (value && !choices.includes(value)) {
    options.push({ value, label: t(labels[value]), title: t(EFFORT_LABELS[value]) });
  }
  return (
    <PopoverField label={t("chat.effort.field")}>
      <SegmentedControl
        label={t("chat.effort.field")}
        size="sm"
        value={value ?? "default"}
        options={options}
        disabled={disabled}
        onChange={(next) => {
          if (next === "default") onChange(null);
          else if (isThinkingEffort(next)) onChange(next);
        }}
        className="flex w-full [&>button]:min-w-0 [&>button]:flex-1 [&>button]:px-1 [&>button]:whitespace-nowrap [&:lang(ru)]:flex-wrap [&:lang(ru)>button]:flex-auto"
      />
    </PopoverField>
  );
}
