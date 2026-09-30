import type { StoreApi } from "zustand/vanilla";
import {
  SPECIALIST_IDS,
  type AgentModelInfo,
  type AgentSettings,
  type ExecutionQuality,
  type ModelConfig,
  type ProviderInfo,
  type SpecialistConfig,
  type SpecialistId,
  type TestJevResponse,
  type UpdateAgentSettingsRequest,
  type UpdateChatRequest,
} from "@hyperframes/agent-protocol";
import type { AgentClient } from "./agentClient";
import { describeAgentError } from "./agentErrors";
import type { ThreadId } from "./agentSelectors";
import type { AgentState } from "./agentStore";

/** How an edit from a settings surface ended; the surface shows the message inline. */
export type ActionResult = { ok: true } | { ok: false; message: string };

export type Loadable<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "failed"; message: string };

/** The team side of the store: global agent settings, Jev, and which thread each chat shows. */
export interface AgentSettingsSlice {
  /** Global agent settings; null until loaded, or when the runtime could not provide them. */
  settings: AgentSettings | null;
  settingsFailed: boolean;
  /** Providers Jev can use; null until first asked for. */
  providers: Loadable<ProviderInfo[]> | null;
  /** Every model of a provider, by provider id, loaded on demand. */
  providerModels: Record<string, Loadable<AgentModelInfo[]>>;
  /** The thread each chat shows, by chat id; a chat not listed shows Main. */
  threads: Record<string, ThreadId>;

  loadSettings(): Promise<void>;
  updateSettings(request: UpdateAgentSettingsRequest): Promise<ActionResult>;
  setJevApiKey(apiKey: string | null): Promise<ActionResult>;
  /** Never rejects: a failed call comes back as `{ok: false}` in plain language. */
  testJev(): Promise<TestJevResponse>;
  loadProviders(): Promise<void>;
  loadProviderModels(provider: string): Promise<void>;
  selectThread(thread: ThreadId): void;
  setEnabledAgents(agents: readonly SpecialistId[]): Promise<ActionResult>;
  /** Null removes the chat's override: the specialist follows the global default again. */
  setAgentOverride(id: SpecialistId, config: SpecialistConfig | null): Promise<ActionResult>;
  /** The Director's per-chat model and thinking; null fields follow the global default. */
  setDirectorConfig(config: ModelConfig): Promise<ActionResult>;
  /** The chat's own Execution Quality; null returns it to the global default. */
  setExecutionQuality(quality: ExecutionQuality | null): Promise<ActionResult>;
}

export interface AgentSettingsSliceDeps {
  client: AgentClient;
  set: StoreApi<AgentState>["setState"];
  get: StoreApi<AgentState>["getState"];
  isDisposed: () => boolean;
  /** PATCHes the open chat and folds the new summary in. */
  updateOpenChat: (request: UpdateChatRequest) => Promise<ActionResult>;
}

export function createAgentSettingsSlice({
  client,
  set,
  get,
  isDisposed,
  updateOpenChat,
}: AgentSettingsSliceDeps): AgentSettingsSlice {
  /** Every settings write answers with the whole new settings, which replace ours. */
  const saveSettings = async (write: () => Promise<AgentSettings>): Promise<ActionResult> => {
    try {
      const settings = await write();
      if (!isDisposed()) set({ settings, settingsFailed: false });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: describeAgentError(error) };
    }
  };

  const putProviderModels = (provider: string, entry: Loadable<AgentModelInfo[]>) => {
    if (isDisposed()) return;
    set((state) => ({ providerModels: { ...state.providerModels, [provider]: entry } }));
  };

  return {
    settings: null,
    settingsFailed: false,
    providers: null,
    providerModels: {},
    threads: {},

    async loadSettings() {
      try {
        const settings = await client.getSettings();
        if (!isDisposed()) set({ settings, settingsFailed: false });
      } catch {
        if (!isDisposed()) set({ settingsFailed: true });
      }
    },

    updateSettings: (request) => saveSettings(() => client.updateSettings(request)),
    setJevApiKey: (apiKey) => saveSettings(() => client.setJevApiKey({ apiKey })),

    async testJev() {
      try {
        return await client.testJev();
      } catch (error) {
        return { ok: false, message: describeAgentError(error) };
      }
    },

    async loadProviders() {
      const current = get().providers;
      if (current && current.status !== "failed") return;
      set({ providers: { status: "loading" } });
      try {
        const { providers } = await client.listProviders();
        if (!isDisposed()) set({ providers: { status: "ready", value: providers } });
      } catch (error) {
        if (!isDisposed()) {
          set({ providers: { status: "failed", message: describeAgentError(error) } });
        }
      }
    },

    async loadProviderModels(provider) {
      const current = get().providerModels[provider];
      if (current && current.status !== "failed") return;
      putProviderModels(provider, { status: "loading" });
      try {
        const { models } = await client.listProviderModels(provider);
        putProviderModels(provider, { status: "ready", value: models });
      } catch (error) {
        putProviderModels(provider, { status: "failed", message: describeAgentError(error) });
      }
    },

    selectThread(thread) {
      const chatId = get().chatId;
      if (chatId) set((state) => ({ threads: { ...state.threads, [chatId]: thread } }));
    },

    setEnabledAgents: (agents) =>
      updateOpenChat({ enabledAgents: SPECIALIST_IDS.filter((id) => agents.includes(id)) }),

    setAgentOverride(id, config) {
      const agentOverrides: NonNullable<UpdateChatRequest["agentOverrides"]> = {};
      agentOverrides[id] = config;
      return updateOpenChat({ agentOverrides });
    },

    setDirectorConfig: ({ model, thinking }) => updateOpenChat({ model, thinking }),

    setExecutionQuality: (executionQuality) => updateOpenChat({ executionQuality }),
  };
}
