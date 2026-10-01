import type { StoreApi } from "zustand/vanilla";
import {
  SPECIALIST_IDS,
  type AgentModelInfo,
  type AgentSettings,
  type ExecutionQuality,
  type ListProvidersResponse,
  type ModelConfig,
  type OAuthFlow,
  type OAuthLoginState,
  type ProviderInfo,
  type SpecialistConfig,
  type SpecialistId,
  type TestJevResponse,
  type UpdateAgentSettingsRequest,
  type UpdateChatRequest,
} from "@hyperframes/agent-protocol";
import { AgentApiError, type AgentClient } from "./agentClient";
import { describeAgentError } from "./agentErrors";
import type { ThreadId } from "./agentSelectors";
import type { AgentState } from "./agentStore";

/** How an edit from a settings surface ended; the surface shows the message inline. */
export type ActionResult = { ok: true } | { ok: false; message: string };

/** A sign-in call's answer: the sign-in as it now is, or why the call failed (`gone`: the runtime forgot it). */
export type OAuthResult =
  | { ok: true; login: OAuthLoginState }
  | { ok: false; message: string; gone: boolean };

export type Loadable<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "failed"; message: string };

/** The team side of the store: global agent settings, Jev, and which thread each chat shows. */
export interface AgentSettingsSlice {
  /** Global agent settings; null until loaded, or when the runtime could not provide them. */
  settings: AgentSettings | null;
  settingsFailed: boolean;
  /** Every provider the runtime knows, with where its credential stands; null until first asked for. */
  providers: Loadable<ProviderInfo[]> | null;
  /** When (epoch ms) the model catalog last synced with the providers; null before the first sync or ever. */
  providersSyncedAt: number | null;
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
  /** Fetches the list again without leaving a ready list for "loading"; a failure keeps what is shown. */
  reloadProviders(): Promise<void>;
  /** Re-checks every provider now (slow when one is unreachable) and folds the answer in. */
  refreshProviders(): Promise<ActionResult>;
  /**
   * Stores (string) or removes (null) the key OpenVids keeps for a provider, then shows the provider as the runtime
   * now sees it. Checks a new key live, which can take ~10 s; the key is never kept here.
   */
  setProviderApiKey(provider: string, apiKey: string | null): Promise<ActionResult>;
  /** Starts (or resumes) a provider's in-app sign-in; `flow` null takes the provider's first flow. */
  startOAuthLogin(provider: string, flow: OAuthFlow | null): Promise<OAuthResult>;
  pollOAuthLogin(loginId: string): Promise<OAuthResult>;
  /** Answers a sign-in's prompt. The text is passed on and not kept. */
  submitOAuthInput(loginId: string, text: string): Promise<OAuthResult>;
  cancelOAuthLogin(loginId: string): Promise<OAuthResult>;
  /** After a sign-in succeeded: the provider list and the model catalog as the runtime now has them. */
  reloadAfterSignIn(): Promise<void>;
  /** Forgets the sign-in made in OpenVids (not the grant at the provider). */
  signOutProvider(provider: string): Promise<ActionResult>;
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

  /**
   * A provider answer replaces the list. The usable models follow the credentials, so the catalog the pickers read
   * is fetched again (a failure there keeps the old catalog; the list itself is already right).
   */
  const adoptProviders = async (answer: ListProvidersResponse) => {
    if (isDisposed()) return;
    set({
      providers: { status: "ready", value: answer.providers },
      providersSyncedAt: answer.syncedAt,
    });
    try {
      const models = await client.listModels();
      if (!isDisposed()) set({ models, modelsFailed: false });
    } catch {
      // Keep the catalog on screen.
    }
  };

  const oauthCall = async (call: () => Promise<OAuthLoginState>): Promise<OAuthResult> => {
    try {
      return { ok: true, login: await call() };
    } catch (error) {
      return {
        ok: false,
        message: describeAgentError(error),
        gone: error instanceof AgentApiError && error.status === 404,
      };
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
    providersSyncedAt: null,
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
        const { providers, syncedAt } = await client.listProviders();
        if (!isDisposed()) {
          set({ providers: { status: "ready", value: providers }, providersSyncedAt: syncedAt });
        }
      } catch (error) {
        if (!isDisposed()) {
          set({ providers: { status: "failed", message: describeAgentError(error) } });
        }
      }
    },

    async reloadProviders() {
      try {
        const { providers, syncedAt } = await client.listProviders();
        if (!isDisposed()) {
          set({ providers: { status: "ready", value: providers }, providersSyncedAt: syncedAt });
        }
      } catch (error) {
        // A list on screen stays; one that never loaded shows why.
        if (!isDisposed() && get().providers?.status !== "ready") {
          set({ providers: { status: "failed", message: describeAgentError(error) } });
        }
      }
    },

    async refreshProviders() {
      try {
        await adoptProviders(await client.refreshProviders());
        return { ok: true };
      } catch (error) {
        return { ok: false, message: describeAgentError(error) };
      }
    },

    async setProviderApiKey(provider, apiKey) {
      try {
        await adoptProviders(await client.setProviderApiKey(provider, { apiKey }));
        return { ok: true };
      } catch (error) {
        return { ok: false, message: describeAgentError(error) };
      }
    },

    startOAuthLogin: (provider, flow) =>
      oauthCall(() => client.startOAuthLogin(provider, flow ? { flow } : {})),
    pollOAuthLogin: (loginId) => oauthCall(() => client.getOAuthLogin(loginId)),
    submitOAuthInput: (loginId, text) =>
      oauthCall(() => client.submitOAuthLoginInput(loginId, { text })),
    cancelOAuthLogin: (loginId) => oauthCall(() => client.cancelOAuthLogin(loginId)),

    async reloadAfterSignIn() {
      try {
        await adoptProviders(await client.listProviders());
      } catch {
        // The list on screen stays; the next look re-reads it.
      }
    },

    async signOutProvider(provider) {
      try {
        await adoptProviders(await client.logoutProvider(provider));
        return { ok: true };
      } catch (error) {
        return { ok: false, message: describeAgentError(error) };
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
