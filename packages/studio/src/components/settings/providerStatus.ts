import {
  SPECIALIST_IDS,
  type AgentId,
  type AgentModelCatalog,
  type AgentSettings,
  type ModelSelection,
  type ProviderInfo,
} from "@hyperframes/agent-protocol";
import { resolveModel } from "../../agent/agentSelectors";
import { formatDate, t, type TranslationKey } from "../../i18n";

/** The catalog key of each agent's name; Jev is a product name and stays as it is. */
const AGENT_NAME_KEYS = {
  director: "settings.agent.director.name",
  editor: "settings.agent.editor.name",
  vision: "settings.agent.vision.name",
  motion: "settings.agent.motion.name",
  research: "settings.agent.research.name",
  audio: "settings.agent.audio.name",
} as const satisfies Partial<Record<AgentId, TranslationKey>>;

/** What an agent is called in Settings. */
export function agentName(id: AgentId): string {
  return id === "jev" ? "Jev" : t(AGENT_NAME_KEYS[id]);
}

/** The providers people know, in the order the prototype lists them. They lead the list even when not set up. */
export const WELL_KNOWN_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "ollama",
] as const;

const wellKnownRank = (id: string) => {
  const index = WELL_KNOWN_PROVIDERS.findIndex((known) => known === id);
  return index === -1 ? WELL_KNOWN_PROVIDERS.length : index;
};

/** A provider the list always shows: one that is set up or needs a look, and the well-known ones. */
export function isProminent(provider: ProviderInfo): boolean {
  return (
    provider.status !== "not_configured" || wellKnownRank(provider.id) < WELL_KNOWN_PROVIDERS.length
  );
}

/**
 * The runtime knows every provider OMP does, which is a long list. Connected, failing and signing-in ones and the
 * well-known five come first (the five in prototype order, then the rest by name); everything else waits behind
 * "Show all providers".
 */
export function splitProviders(providers: readonly ProviderInfo[]): {
  shown: ProviderInfo[];
  rest: ProviderInfo[];
} {
  const byName = (a: ProviderInfo, b: ProviderInfo) => a.name.localeCompare(b.name);
  const shown = providers
    .filter(isProminent)
    .sort((a, b) => wellKnownRank(a.id) - wellKnownRank(b.id) || byName(a, b));
  const rest = providers.filter((provider) => !isProminent(provider)).sort(byName);
  return { shown, rest };
}

/** Providers that need the user: a failed check, or a sign-in that expired. Not "not set up": that is a choice. */
export function providerIssueCount(providers: readonly ProviderInfo[]): number {
  return providers.filter(
    (provider) => provider.status === "error" || provider.status === "signin_required",
  ).length;
}

/** "Google has an error", "OpenAI needs sign-in", "OpenRouter isn't set up"; null for a connected provider. */
export function providerIssue(provider: ProviderInfo): string | null {
  switch (provider.status) {
    case "connected":
      return null;
    case "signin_required":
      return t("settings.provider.issue.signinRequired", { name: provider.name });
    case "error":
      return t("settings.provider.issue.error", { name: provider.name });
    case "not_configured":
      return t("settings.studio.pv.issueNotSetUp", { name: provider.name });
  }
}

/** "Synced just now", "Synced 2 min ago", "Synced 3 h ago", then "Synced" and the date. */
export function syncedLabel(syncedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - syncedAt) / 1000));
  if (seconds < 45) return t("settings.providers.synced.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("settings.providers.synced.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("settings.providers.synced.hours", { count: hours });
  return t("settings.providers.synced.date", {
    date: formatDate(syncedAt, { month: "short", day: "numeric" }),
  });
}

/** The key a model is listed under: `provider/modelId`. */
export const modelKey = (model: ModelSelection) => `${model.provider}/${model.modelId}`;

/**
 * Who runs each model by default, for the "used by" column of a provider: the Director, the specialists that are on
 * in new chats (a model left on Default is the runtime's default model), and Jev while it is on.
 */
export function modelUsers(
  settings: AgentSettings | null,
  catalog: AgentModelCatalog | null,
): Map<string, AgentId[]> {
  const users = new Map<string, AgentId[]>();
  if (!settings) return users;
  const add = (selection: ModelSelection | null, agent: AgentId) => {
    if (!selection) return;
    const key = modelKey(selection);
    users.set(key, [...(users.get(key) ?? []), agent]);
  };
  const fallback = catalog?.defaultModel ?? null;
  add(resolveModel(settings.director.model, catalog, fallback).selection, "director");
  for (const id of SPECIALIST_IDS) {
    const specialist = settings.specialists[id];
    if (!specialist.enabledByDefault) continue;
    add(resolveModel(specialist.model, catalog, fallback).selection, id);
  }
  const { jev } = settings;
  if (jev.enabled && jev.provider && jev.modelId) {
    add({ provider: jev.provider, modelId: jev.modelId }, "jev");
  }
  return users;
}
