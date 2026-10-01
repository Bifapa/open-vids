import { useState, type RefObject } from "react";
import {
  type AgentSettings,
  type ChatSummary,
  type SpecialistConfig,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { runningTurn } from "../../agent/agentSelectors";
import type { ActionResult } from "../../agent/agentSettingsSlice";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/Button";
import { AgentConfigFields } from "./AgentConfigFields";
import { AGENT_BLURBS, AGENT_NAME_KEYS, type ConfigDefaults } from "./agentLabels";
import { ChatDialog, DialogField } from "./ChatDialog";
import { ChoiceChips } from "./ChoiceChips";

export type ConfigurableAgent = "director" | SpecialistId;

type Scope = "default" | "custom";

const EMPTY_CONFIG: SpecialistConfig = { model: null, thinking: null, allowedModels: [] };
const LOCKED_REASON = "chat.agentConfig.locked";

/** The agent's global default, as a config the fields can show. */
function globalDefault(agent: ConfigurableAgent, settings: AgentSettings | null): SpecialistConfig {
  if (!settings) return EMPTY_CONFIG;
  if (agent === "director") return { ...settings.director, allowedModels: [] };
  const { model, thinking, allowedModels } = settings.specialists[agent];
  return { model, thinking, allowedModels };
}

/** What the chat has now: its own choice ("custom") or none (the default applies). */
function chatChoice(
  agent: ConfigurableAgent,
  chat: ChatSummary,
): { scope: Scope; config: SpecialistConfig | null } {
  if (agent === "director") {
    const custom = chat.mainAgentModel !== null || chat.thinking !== null;
    return {
      scope: custom ? "custom" : "default",
      config: custom
        ? { model: chat.mainAgentModel, thinking: chat.thinking, allowedModels: [] }
        : null,
    };
  }
  const override = chat.agentOverrides?.[agent];
  return { scope: override ? "custom" : "default", config: override ?? null };
}

/**
 * One agent's model and thinking for this chat: "Default" follows the global setting (and clears the chat's own
 * choice), "Custom for this chat" keeps a choice for this chat only.
 */
export function AgentConfigDialog({
  agent,
  chat,
  onClose,
  finalFocus,
}: {
  agent: ConfigurableAgent;
  chat: ChatSummary;
  onClose: () => void;
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  const settings = useAgentStore((state) => state.settings);
  const catalog = useAgentStore((state) => state.models);
  const catalogFailed = useAgentStore((state) => state.modelsFailed);
  const locked = useAgentStore((state) => runningTurn(state.chat) !== null);
  const setAgentOverride = useAgentStore((state) => state.setAgentOverride);
  const setDirectorConfig = useAgentStore((state) => state.setDirectorConfig);

  const { t } = useTranslation();
  const defaults = globalDefault(agent, settings);
  const [initial] = useState(() => chatChoice(agent, chat));
  const [scope, setScope] = useState<Scope>(initial.scope);
  const [draft, setDraft] = useState<SpecialistConfig>(initial.config ?? defaults);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = t(AGENT_NAME_KEYS[agent]);
  // Null fields fall back to: the Director's global default (then the runtime's) for the Director,
  // the runtime default for a specialist.
  const fallback: ConfigDefaults = {
    model:
      (agent === "director" ? settings?.director.model : null) ?? catalog?.defaultModel ?? null,
    thinking:
      (agent === "director" ? settings?.director.thinking : null) ??
      catalog?.defaultThinking ??
      null,
  };
  const shown = scope === "custom" ? draft : defaults;

  const save = async () => {
    setSaving(true);
    setError(null);
    let result: ActionResult = { ok: true };
    if (agent === "director") {
      result = await setDirectorConfig(
        scope === "custom"
          ? { model: draft.model, thinking: draft.thinking }
          : { model: null, thinking: null },
      );
    } else if (scope === "custom") {
      result = await setAgentOverride(agent, draft);
    } else if (chat.agentOverrides?.[agent]) {
      result = await setAgentOverride(agent, null);
    }
    setSaving(false);
    if (result.ok) onClose();
    else setError(result.message);
  };

  return (
    <ChatDialog
      open
      onClose={onClose}
      finalFocus={finalFocus}
      title={t("chat.agentConfig.title", { name })}
      description={t(AGENT_BLURBS[agent])}
      footer={
        <>
          {locked && (
            <span className="mr-auto text-step-10 text-container">{t(LOCKED_REASON)}</span>
          )}
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
        <DialogField
          label={t("chat.agentConfig.use")}
          hint={
            scope === "default"
              ? t("chat.agentConfig.hintDefault")
              : t("chat.agentConfig.hintCustom")
          }
        >
          <ChoiceChips
            label={t("chat.agentConfig.scopeLabel", { name })}
            value={scope}
            choices={[
              { value: "default", label: t("common.default") },
              { value: "custom", label: t("chat.agentConfig.custom") },
            ]}
            disabled={locked}
            onChange={setScope}
          />
        </DialogField>
        <AgentConfigFields
          name={name}
          value={shown}
          onChange={setDraft}
          catalog={catalog}
          catalogFailed={catalogFailed}
          defaults={fallback}
          withAllowedModels={agent !== "director"}
          disabled={locked || scope === "default"}
          disabledReason={locked ? t(LOCKED_REASON) : t("chat.agentConfig.customRequired")}
        />
        {agent !== "director" && !settings && (
          <p className="text-step-11 text-text-3">{t("chat.agentConfig.noGlobalSettings")}</p>
        )}
        {error && (
          <p role="alert" className="text-step-11 text-danger">
            {error}
          </p>
        )}
      </div>
    </ChatDialog>
  );
}
