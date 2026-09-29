import { useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { AgentModelCatalog, ModelSelection } from "@hyperframes/agent-protocol";
import { displayModelName, resolveModel } from "../../agent/agentSelectors";
import { cn } from "../ui/cn";
import { Popover } from "../ui/Popover";
import { ModelList } from "./ModelList";

interface ModelPickerProps {
  catalog: AgentModelCatalog | null;
  /** The catalog could not be loaded (as opposed to still loading). */
  catalogFailed: boolean;
  explicit: ModelSelection | null;
  /** Locked while a turn runs: the runtime refuses changes mid-run. */
  disabled: boolean;
  onSelect: (model: ModelSelection | null) => void;
  /** What "Default" resolves to for this agent; the runtime default when omitted. */
  fallback?: ModelSelection | null;
  /** Who the model is for, as assistive tech hears it: "<name>: <model>". */
  name?: string;
  /** Why the picker is disabled, as a tooltip. */
  disabledReason?: string;
}

/** An agent's model: shows the resolved default when nothing was chosen explicitly. */
export function ModelPicker({
  catalog,
  catalogFailed,
  explicit,
  disabled,
  onSelect,
  fallback,
  name = "Model",
  disabledReason = "The model can't change while the agent is working.",
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const resolved = resolveModel(explicit, catalog, fallback);
  const defaultInfo = resolveModel(null, catalog, fallback);
  const unavailable = catalog === null;

  let label = displayModelName(resolved.selection, resolved.info);
  if (unavailable) label = catalogFailed ? "Models unavailable" : "Loading models…";
  else if (resolved.selection === null) label = "No model available";

  const trigger = (
    <button
      type="button"
      aria-label={`${name}: ${label}`}
      aria-haspopup="listbox"
      disabled={disabled || catalog === null || catalog.models.length === 0}
      title={disabled ? disabledReason : undefined}
      className={cn(
        "flex h-ctl-sm min-w-0 max-w-full items-center gap-1 rounded-sm border border-border-input bg-input px-2 text-step-11 text-text-1",
        "outline-hidden transition-colors duration-hover hover:border-border-strong",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <span className="truncate">{label}</span>
      {!unavailable && resolved.isDefault && resolved.selection && (
        <span className="shrink-0 text-step-10 text-text-4">default</span>
      )}
      <CaretDown size={10} weight="bold" aria-hidden className="shrink-0 text-text-4" />
    </button>
  );

  return (
    <Popover
      trigger={trigger}
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="start"
      aria-label="Choose a model"
    >
      {catalog && (
        <ModelList
          models={catalog.models}
          explicit={explicit}
          defaultName={
            defaultInfo.selection ? displayModelName(defaultInfo.selection, defaultInfo.info) : null
          }
          onSelect={(model) => {
            setOpen(false);
            onSelect(model);
          }}
        />
      )}
    </Popover>
  );
}
