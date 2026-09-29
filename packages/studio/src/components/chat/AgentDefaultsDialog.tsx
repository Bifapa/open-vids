import { useId, useState, type ReactNode, type RefObject } from "react";
import { CaretRight } from "@phosphor-icons/react";
import {
  AGENT_DISPLAY_NAMES,
  SPECIALIST_IDS,
  type AgentModelCatalog,
  type SpecialistDefaults,
  type SpecialistId,
  type UpdateAgentSettingsRequest,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { Toggle } from "../ui/Toggle";
import { AgentConfigFields } from "./AgentConfigFields";
import { AGENT_BLURBS, describeModelConfig, type ConfigDefaults } from "./agentLabels";
import { ChatDialog } from "./ChatDialog";
import { JevSettings } from "./JevSettings";

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div>
        <h3 id={id} className="text-step-11 font-semibold text-text-0">
          {title}
        </h3>
        {hint && <p className="text-step-10 text-text-3">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function SpecialistDefaultsRow({
  id,
  value,
  catalog,
  catalogFailed,
  defaults,
  onCommit,
}: {
  id: SpecialistId;
  value: SpecialistDefaults;
  catalog: AgentModelCatalog | null;
  catalogFailed: boolean;
  defaults: ConfigDefaults;
  onCommit: (next: SpecialistDefaults) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const name = AGENT_DISPLAY_NAMES[id];

  return (
    <li className="rounded-md border border-hairline bg-bg-2">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${name} defaults`}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent"
        >
          <CaretRight
            size={10}
            weight="bold"
            aria-hidden
            className={cn(
              "shrink-0 text-text-4 transition-transform duration-expand",
              open && "rotate-90",
            )}
          />
          <span className="shrink-0 text-step-11 font-medium text-text-1">{name}</span>
          <span className="min-w-0 truncate text-step-10 text-text-3">
            {describeModelConfig(value, catalog, defaults)}
          </span>
        </button>
        <Toggle
          label={`${name} on in new chats`}
          checked={value.enabledByDefault}
          onCommit={(enabledByDefault) => onCommit({ ...value, enabledByDefault })}
        />
      </div>
      {open && (
        <div id={panelId} className="flex flex-col gap-2 border-t border-hairline px-2 py-2">
          <p className="text-step-10 text-text-3">{AGENT_BLURBS[id]}</p>
          <AgentConfigFields
            name={name}
            value={value}
            onChange={(next) => onCommit({ ...next, enabledByDefault: value.enabledByDefault })}
            catalog={catalog}
            catalogFailed={catalogFailed}
            defaults={defaults}
            withAllowedModels
            disabled={false}
          />
        </div>
      )}
    </li>
  );
}

/**
 * The user's global agent settings: what the Director and each specialist run by default in new chats, and
 * Jev. Every change is saved as it is made, so "Test Jev" always tests what is on screen.
 */
export function AgentDefaultsDialog({
  onClose,
  finalFocus,
}: {
  onClose: () => void;
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  const settings = useAgentStore((state) => state.settings);
  const settingsFailed = useAgentStore((state) => state.settingsFailed);
  const catalog = useAgentStore((state) => state.models);
  const catalogFailed = useAgentStore((state) => state.modelsFailed);
  const loadSettings = useAgentStore((state) => state.loadSettings);
  const updateSettings = useAgentStore((state) => state.updateSettings);
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const commit = async (request: UpdateAgentSettingsRequest) => {
    setSaving((count) => count + 1);
    setError(null);
    const result = await updateSettings(request);
    setSaving((count) => count - 1);
    if (!result.ok) setError(result.message);
  };

  const runtimeDefaults: ConfigDefaults = {
    model: catalog?.defaultModel ?? null,
    thinking: catalog?.defaultThinking ?? null,
  };

  let body: ReactNode;
  if (!settings) {
    body = settingsFailed ? (
      <div className="flex flex-col items-start gap-2">
        <p className="text-step-11 text-text-2">Agent settings are unavailable right now.</p>
        <Button size="sm" variant="secondary" onClick={() => void loadSettings()}>
          Try again
        </Button>
      </div>
    ) : (
      <p className="text-step-11 text-text-3">Loading agent settings…</p>
    );
  } else {
    body = (
      <div className="flex flex-col gap-5">
        <Section title="Director" hint={AGENT_BLURBS.director}>
          <AgentConfigFields
            name="Director"
            value={{ ...settings.director, allowedModels: [] }}
            onChange={({ model, thinking }) => void commit({ director: { model, thinking } })}
            catalog={catalog}
            catalogFailed={catalogFailed}
            defaults={runtimeDefaults}
            withAllowedModels={false}
            disabled={false}
          />
        </Section>
        <Section
          title="Specialists"
          hint="The switch decides whether new chats start with the specialist enabled."
        >
          <ul className="flex flex-col gap-1">
            {SPECIALIST_IDS.map((id) => (
              <SpecialistDefaultsRow
                key={id}
                id={id}
                value={settings.specialists[id]}
                catalog={catalog}
                catalogFailed={catalogFailed}
                defaults={runtimeDefaults}
                onCommit={(next) => {
                  const specialists: NonNullable<UpdateAgentSettingsRequest["specialists"]> = {};
                  specialists[id] = next;
                  void commit({ specialists });
                }}
              />
            ))}
          </ul>
        </Section>
        <Section title="Jev">
          <JevSettings jev={settings.jev} onCommit={(jev) => void commit({ jev })} />
        </Section>
      </div>
    );
  }

  return (
    <ChatDialog
      open
      onClose={onClose}
      finalFocus={finalFocus}
      title="Agent defaults"
      description="For every chat that has no choice of its own. Changes save as you make them."
      className="w-[min(440px,calc(100vw-2rem))]"
      footer={
        <>
          <span aria-live="polite" className="mr-auto text-step-10">
            {error ? (
              <span role="alert" className="text-danger">
                {error}
              </span>
            ) : saving > 0 ? (
              <span className="text-text-3">Saving…</span>
            ) : null}
          </span>
          <Button size="sm" variant="secondary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {body}
    </ChatDialog>
  );
}
