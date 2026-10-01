import {
  AGENT_DISPLAY_NAMES,
  SPECIALIST_IDS,
  isThinkingEffort,
  type AgentModelCatalog,
  type ModelConfig,
  type ModelSelection,
  type SpecialistDefaults,
  type SpecialistId,
  type UpdateAgentSettingsRequest,
} from "@hyperframes/agent-protocol";
import { effortChoices, resolveModel } from "../../agent/agentSelectors";
import { AllowedModels } from "../chat/AgentConfigFields";
import { AGENT_BLURBS, EFFORT_LABELS, type ConfigDefaults } from "../chat/agentLabels";
import { ModelPicker } from "../chat/ModelPicker";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { Select } from "../ui/Select";
import { Toggle } from "../ui/Toggle";
import { Tooltip } from "../ui/Tooltip";
import {
  SaveStatus,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsUnavailable,
} from "./settingsLayout";
import { useAgentSettingsEditor } from "./useAgentSettingsEditor";

/** Agent, Model, Thinking effort, On — the prototype's `.st-agents` columns. */
const AGENT_GRID = "grid grid-cols-[minmax(0,1fr)_152px_144px_28px] items-center gap-3 px-3";

/** ModelPicker in the prototype's 28 px window-form `.sel` look, caret at the right edge. */
const MODEL_TRIGGER =
  "h-ctl w-full rounded-md bg-bg-0 px-2.5 text-sm text-fg [&>span:first-child]:flex-1 [&>span:first-child]:text-left";

/** "MD" for Motion Designer, "E" for Editor. */
const monogram = (name: string) =>
  name
    .split(/\s+/)
    .map((word) => word[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** A model change drops a thinking effort the new model cannot take, as the chat header does. */
function withModel<T extends ModelConfig>(
  config: T,
  model: ModelSelection | null,
  catalog: AgentModelCatalog | null,
  fallback: ModelSelection | null,
): T {
  const next = resolveModel(model, catalog, fallback).info;
  const effort = config.thinking;
  const drop = next && effort && effort !== "off" && !next.efforts.includes(effort);
  return { ...config, model, thinking: drop ? null : effort };
}

function EffortSelect({
  name,
  config,
  catalog,
  defaults,
  onChange,
}: {
  name: string;
  config: ModelConfig;
  catalog: AgentModelCatalog | null;
  defaults: ConfigDefaults;
  onChange: (thinking: ModelConfig["thinking"]) => void;
}) {
  const { info } = resolveModel(config.model, catalog, defaults.model);
  const efforts = effortChoices(info);
  const options = [
    {
      value: "default",
      label: defaults.thinking ? `Default (${EFFORT_LABELS[defaults.thinking]})` : "Default",
    },
    ...efforts.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] })),
  ];
  if (config.thinking && !efforts.includes(config.thinking)) {
    options.push({ value: config.thinking, label: EFFORT_LABELS[config.thinking] });
  }
  return (
    <Select
      size="md"
      label={`${name} thinking effort`}
      className="w-full min-w-0"
      disabled={efforts.length === 0}
      value={config.thinking ?? "default"}
      options={efforts.length === 0 ? [{ value: "default", label: "Not adjustable" }] : options}
      onCommit={(next) => onChange(isThinkingEffort(next) ? next : null)}
    />
  );
}

function AgentCell({ name, blurb, off }: { name: string; blurb: string; off?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className={cn(
          "inline-flex size-ctl-xs flex-none select-none items-center justify-center rounded-xs border border-border font-mono text-2xs font-semibold uppercase leading-none",
          off ? "bg-transparent text-fg-3" : "bg-surface-2 text-fg-2",
        )}
      >
        {monogram(name)}
      </span>
      <div className="grid min-w-0 gap-px">
        <span className={cn("text-base font-medium leading-4", off ? "text-fg-2" : "text-fg")}>
          {name}
        </span>
        <span className="truncate text-xs leading-[14px] text-fg-3" title={blurb}>
          {blurb}
        </span>
      </div>
    </div>
  );
}

function SpecialistRow({
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
  const name = AGENT_DISPLAY_NAMES[id];
  return (
    <div className={cn(AGENT_GRID, "min-h-row-lg py-1.5")} data-agent-row={id}>
      <AgentCell name={name} blurb={AGENT_BLURBS[id]} off={!value.enabledByDefault} />
      <ModelPicker
        name={`${name} model`}
        catalog={catalog}
        catalogFailed={catalogFailed}
        explicit={value.model}
        fallback={defaults.model}
        disabled={false}
        className={MODEL_TRIGGER}
        onSelect={(model) => onCommit(withModel(value, model, catalog, defaults.model))}
      />
      <EffortSelect
        name={name}
        config={value}
        catalog={catalog}
        defaults={defaults}
        onChange={(thinking) => onCommit({ ...value, thinking })}
      />
      <Toggle
        label={`${name} on in new chats`}
        checked={value.enabledByDefault}
        className="justify-self-end"
        onCommit={(enabledByDefault) => onCommit({ ...value, enabledByDefault })}
      />
    </div>
  );
}

/** What the Director and each specialist run in new chats, and whether a specialist starts enabled. */
export function AgentsSection() {
  const editor = useAgentSettingsEditor();
  const { settings, catalog, catalogFailed, runtimeDefaults, commit } = editor;

  if (!settings) {
    return (
      <SettingsPage title="Agents">
        <SettingsUnavailable
          message={
            editor.settingsFailed
              ? "Agent settings are unavailable right now."
              : "Loading agent settings…"
          }
          action={
            editor.settingsFailed ? (
              <Button size="sm" onClick={() => void editor.loadSettings()}>
                Try again
              </Button>
            ) : undefined
          }
        />
      </SettingsPage>
    );
  }

  const commitSpecialist = (id: SpecialistId, next: SpecialistDefaults) => {
    const specialists: NonNullable<UpdateAgentSettingsRequest["specialists"]> = {};
    specialists[id] = next;
    commit({ specialists });
  };
  const director = settings.director;

  return (
    <SettingsPage
      title="Agents"
      meta={<SaveStatus status={editor.status} failed={editor.failed} />}
    >
      <SettingsGroup
        label="Defaults for new chats"
        footer="Per-chat changes in the Chat panel override these. Models come from the providers the agent is signed in to."
      >
        <div
          aria-hidden
          className={cn(
            AGENT_GRID,
            "h-list-head rounded-t-md bg-bg-0 text-xs text-fg-3 [&>:last-child]:justify-self-end",
          )}
        >
          <span>Agent</span>
          <span>Model</span>
          <span>Thinking effort</span>
          <span>On</span>
        </div>
        <div className={cn(AGENT_GRID, "min-h-row-lg py-1.5")} data-agent-row="director">
          <AgentCell name="Director" blurb={AGENT_BLURBS.director} />
          <ModelPicker
            name="Director model"
            catalog={catalog}
            catalogFailed={catalogFailed}
            explicit={director.model}
            fallback={runtimeDefaults.model}
            disabled={false}
            className={MODEL_TRIGGER}
            onSelect={(model) => {
              const next = withModel(director, model, catalog, runtimeDefaults.model);
              commit({ director: { model: next.model, thinking: next.thinking } });
            }}
          />
          <EffortSelect
            name="Director"
            config={director}
            catalog={catalog}
            defaults={runtimeDefaults}
            onChange={(thinking) => commit({ director: { model: director.model, thinking } })}
          />
          <Tooltip label="The Director is always on" side="left">
            <span className="justify-self-end">
              <Toggle label="Director, always on" checked disabled onCommit={() => {}} />
            </span>
          </Tooltip>
        </div>
        {SPECIALIST_IDS.map((id) => (
          <SpecialistRow
            key={id}
            id={id}
            value={settings.specialists[id]}
            catalog={catalog}
            catalogFailed={catalogFailed}
            defaults={runtimeDefaults}
            onCommit={(next) => commitSpecialist(id, next)}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup
        label="Director may also use"
        note="Extra models the Director may pick for a single task"
        footer="The Director may lower a specialist's thinking for a task, never raise it."
      >
        {SPECIALIST_IDS.map((id) => {
          const value = settings.specialists[id];
          const name = AGENT_DISPLAY_NAMES[id];
          return (
            <SettingsRow
              key={id}
              label={name}
              hint={
                value.allowedModels.length === 0
                  ? `None: ${name} always runs on its own model.`
                  : `One of these may run a single ${name} task.`
              }
            >
              <AllowedModels
                bare
                name={name}
                value={value.allowedModels}
                catalog={catalog}
                disabled={false}
                onChange={(allowedModels) => commitSpecialist(id, { ...value, allowedModels })}
              />
            </SettingsRow>
          );
        })}
      </SettingsGroup>
    </SettingsPage>
  );
}
