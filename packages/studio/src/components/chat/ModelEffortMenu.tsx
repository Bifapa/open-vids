import { useState } from "react";
import { Cpu } from "@phosphor-icons/react";
import type { ChatSummary } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { displayModelName, resolveModel, runningTurn } from "../../agent/agentSelectors";
import { openSettings } from "../settings/settingsStore";
import { cn } from "../ui/cn";
import { EFFORT_LABELS } from "./agentLabels";
import {
  ChipCaret,
  ComposerPopover,
  EffortField,
  LOCKED_REASON,
  ModelChoice,
  ModelFieldButton,
  PopoverField,
  PopoverHelp,
  chipClass,
  chipIconClass,
  chipLabelClass,
  linkClass,
  modelFieldLabel,
} from "./composerParts";

/**
 * The Model · Effort chip and its popover: Main's model (from the catalog, or Default) and thinking effort for
 * this chat, with the way to the agent defaults in Settings.
 */
export function ModelEffortMenu({ chat }: { chat: ChatSummary }) {
  const catalog = useAgentStore((state) => state.models);
  const catalogFailed = useAgentStore((state) => state.modelsFailed);
  const director = useAgentStore((state) => state.settings?.director ?? null);
  const locked = useAgentStore((state) => runningTurn(state.chat) !== null);
  const setModel = useAgentStore((state) => state.setModel);
  const setThinking = useAgentStore((state) => state.setThinking);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);

  const fallback = director?.model ?? catalog?.defaultModel ?? null;
  const resolved = resolveModel(chat.mainAgentModel, catalog, fallback);
  const modelName = catalog
    ? displayModelName(resolved.selection, resolved.info)
    : catalogFailed
      ? "Models unavailable"
      : "Loading…";
  const effortName = chat.thinking ? EFFORT_LABELS[chat.thinking] : "Default";
  const label = `${modelName} · ${effortName}`;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setPicking(false);
  };

  const trigger = (
    <button
      type="button"
      data-chip="model"
      aria-label={`Main model: ${modelName}, ${effortName} thinking effort`}
      title={`${modelName} · ${effortName} thinking effort`}
      // The model chip gives way first (prototype: the only chip with flex-shrink).
      className={cn(chipClass, "shrink")}
    >
      <Cpu
        size={12}
        aria-hidden
        className={`${chipIconClass} hidden @min-[440px]/composer:inline @max-[299px]/composer:inline`}
      />
      <span className={chipLabelClass}>{label}</span>
      <ChipCaret />
    </button>
  );

  return (
    <ComposerPopover
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      title={picking ? "Choose model" : "Main model"}
      back={picking ? { label: "Back to main model", onBack: () => setPicking(false) } : undefined}
    >
      {picking && catalog ? (
        <ModelChoice
          catalog={catalog}
          explicit={chat.mainAgentModel}
          fallback={fallback}
          onSelect={(model) => {
            setPicking(false);
            void setModel(model);
          }}
        />
      ) : (
        <>
          <PopoverField label="Model">
            <ModelFieldButton
              name="Main model"
              label={modelFieldLabel(catalog, catalogFailed, chat.mainAgentModel, fallback)}
              disabled={locked || !catalog || catalog.models.length === 0}
              onOpen={() => setPicking(true)}
            />
          </PopoverField>
          <EffortField
            model={resolved.info}
            value={chat.thinking}
            defaultEffort={director?.thinking ?? catalog?.defaultThinking ?? null}
            disabled={locked}
            onChange={(effort) => void setThinking(effort)}
          />
          {locked && <PopoverHelp tone="warning">{LOCKED_REASON}</PopoverHelp>}
          <PopoverHelp>
            Default follows the project’s agent defaults.{" "}
            <button
              type="button"
              className={linkClass}
              onClick={() => {
                onOpenChange(false);
                openSettings("agents");
              }}
            >
              Agent defaults…
            </button>
          </PopoverHelp>
        </>
      )}
    </ComposerPopover>
  );
}
