import { useState } from "react";
import type { UpdateAgentSettingsRequest } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import type { ConfigDefaults } from "../chat/agentLabels";

/**
 * The global agent settings as the Agents, Jev and Execution sections edit them: every change saves at once
 * (so "Test Jev" always tests what is on screen); the last failure stays until the next change.
 */
export function useAgentSettingsEditor() {
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

  return {
    settings,
    settingsFailed,
    catalog,
    catalogFailed,
    loadSettings,
    runtimeDefaults,
    commit: (request: UpdateAgentSettingsRequest) => void commit(request),
    status: error ?? (saving > 0 ? "Saving…" : null),
    failed: error !== null,
  };
}
