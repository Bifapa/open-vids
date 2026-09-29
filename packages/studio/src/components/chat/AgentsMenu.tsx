import { useRef, useState } from "react";
import { GearSix, UsersThree } from "@phosphor-icons/react";
import {
  AGENT_DISPLAY_NAMES,
  SPECIALIST_IDS,
  type ChatSummary,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { directorConfig, runningTurn, specialistConfig } from "../../agent/agentSelectors";
import { cn } from "../ui/cn";
import { IconButton } from "../ui/IconButton";
import { Popover } from "../ui/Popover";
import { Toggle } from "../ui/Toggle";
import { AgentConfigDialog, type ConfigurableAgent } from "./AgentConfigDialog";
import { AgentDefaultsDialog } from "./AgentDefaultsDialog";
import { AGENT_BLURBS, describeModelConfig } from "./agentLabels";

const LOCKED_REASON = "Agents can't change while this chat is working.";

function AgentRow({
  agent,
  summary,
  custom,
  toggle,
  onConfigure,
}: {
  agent: ConfigurableAgent;
  /** "Sonnet · High", or why it can't be shown. */
  summary: string;
  custom: boolean | null;
  toggle?: { checked: boolean; disabled: boolean; onCommit: (next: boolean) => void };
  onConfigure: () => void;
}) {
  const name = AGENT_DISPLAY_NAMES[agent];
  return (
    <li className="flex items-center gap-2 px-3 py-1.5" data-agent={agent}>
      {toggle ? (
        <Toggle
          label={`Enable ${name}`}
          checked={toggle.checked}
          disabled={toggle.disabled}
          onCommit={toggle.onCommit}
          // Base UI marks a disabled switch with `data-disabled`, not `:disabled`.
          className="data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40"
        />
      ) : (
        <span className="w-7 shrink-0 text-center text-step-10 text-text-4">lead</span>
      )}
      <div className="min-w-0 flex-1" title={AGENT_BLURBS[agent]}>
        <p className="text-step-11 font-medium text-text-1">{name}</p>
        <p className="flex min-w-0 items-center gap-1 text-step-10 text-text-3">
          <span className="truncate">{summary}</span>
          {custom !== null && (
            <span
              className={cn(
                "shrink-0 rounded-sm px-1",
                custom ? "bg-accent/10 text-accent" : "text-text-4",
              )}
            >
              {custom ? "custom" : "default"}
            </span>
          )}
        </p>
      </div>
      <IconButton
        aria-label={`Configure ${name}`}
        size="sm"
        icon={<GearSix size={13} aria-hidden />}
        onClick={onConfigure}
      />
    </li>
  );
}

/**
 * Which specialists the Director may delegate to in this chat, and what each runs on. The dialogs live
 * beside the popover, so closing the popover to open one does not unmount it.
 */
export function AgentsMenu({ chat }: { chat: ChatSummary }) {
  const settings = useAgentStore((state) => state.settings);
  const catalog = useAgentStore((state) => state.models);
  const locked = useAgentStore((state) => runningTurn(state.chat) !== null);
  const setEnabledAgents = useAgentStore((state) => state.setEnabledAgents);
  const [open, setOpen] = useState(false);
  const [configuring, setConfiguring] = useState<ConfigurableAgent | null>(null);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [pending, setPending] = useState<SpecialistId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const enabled = chat.enabledAgents;
  const runtimeDefaults = {
    model: catalog?.defaultModel ?? null,
    thinking: catalog?.defaultThinking ?? null,
  };
  const director = directorConfig(chat, settings);

  const toggle = async (id: SpecialistId, next: boolean) => {
    setPending(id);
    setError(null);
    const result = await setEnabledAgents(
      next ? [...enabled, id] : enabled.filter((known) => known !== id),
    );
    setPending(null);
    if (!result.ok) setError(result.message);
  };

  const openDialog = (show: () => void) => {
    setOpen(false);
    setError(null);
    show();
  };

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      aria-label={`Agents: ${enabled.length} enabled`}
      className={cn(
        "flex h-ctl-sm shrink-0 items-center gap-1 rounded-sm px-1.5 text-step-11 text-text-2",
        "outline-hidden transition-colors duration-hover hover:bg-hover hover:text-text-0",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
        "data-[popup-open]:bg-hover data-[popup-open]:text-text-0",
      )}
    >
      <UsersThree size={13} aria-hidden />
      Agents
      <span className="rounded-sm bg-surface px-1 text-step-10 tabular-nums text-text-1">
        {enabled.length}
      </span>
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
        aria-label="Agents in this chat"
        className="w-80 p-0"
      >
        <div className="px-3 pb-1 pt-2.5">
          <p className="text-step-11 font-semibold text-text-0">Agents in this chat</p>
          <p className="text-step-10 text-text-3">
            The Director hands work to the specialists you enable.
          </p>
        </div>
        <ul className="flex flex-col py-1">
          <AgentRow
            agent="director"
            summary={describeModelConfig(director.config, catalog, runtimeDefaults)}
            custom={director.custom}
            onConfigure={() => openDialog(() => setConfiguring("director"))}
          />
          {SPECIALIST_IDS.map((id) => {
            const view = specialistConfig(chat, settings, id);
            return (
              <AgentRow
                key={id}
                agent={id}
                summary={
                  view
                    ? describeModelConfig(view.config, catalog, runtimeDefaults)
                    : "Settings unavailable"
                }
                custom={view ? view.custom : null}
                toggle={{
                  checked: enabled.includes(id),
                  disabled: locked || pending !== null,
                  onCommit: (next) => void toggle(id, next),
                }}
                onConfigure={() => openDialog(() => setConfiguring(id))}
              />
            );
          })}
        </ul>
        {(locked || error) && (
          <p
            role={error ? "alert" : undefined}
            className={cn("px-3 pb-1.5 text-step-10", error ? "text-danger" : "text-container")}
          >
            {error ?? LOCKED_REASON}
          </p>
        )}
        <div className="border-t border-hairline p-1">
          <button
            type="button"
            onClick={() => openDialog(() => setDefaultsOpen(true))}
            className="flex h-ctl-sm w-full items-center gap-1.5 rounded-sm px-2 text-left text-step-11 text-text-2 outline-hidden transition-colors duration-hover hover:bg-hover hover:text-text-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
          >
            <GearSix size={12} aria-hidden />
            Defaults & Jev…
          </button>
        </div>
      </Popover>
      {configuring && (
        <AgentConfigDialog
          key={configuring}
          agent={configuring}
          chat={chat}
          finalFocus={triggerRef}
          onClose={() => setConfiguring(null)}
        />
      )}
      {defaultsOpen && (
        <AgentDefaultsDialog finalFocus={triggerRef} onClose={() => setDefaultsOpen(false)} />
      )}
    </>
  );
}
