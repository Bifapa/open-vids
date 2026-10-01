import {
  AGENT_DISPLAY_NAMES,
  SPECIALIST_IDS,
  type AgentModelCatalog,
  type AgentSettings,
  type ModelSelection,
  type ProviderInfo,
} from "@hyperframes/agent-protocol";
import { resolveModel } from "../../agent/agentSelectors";

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
      return `${provider.name} needs sign-in`;
    case "error":
      return `${provider.name} has an error`;
    case "not_configured":
      return `${provider.name} isn't set up`;
  }
}

/** "just now", "2 min ago", "3 h ago", then the date. */
export function syncedAgo(syncedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - syncedAt) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(syncedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
): Map<string, string[]> {
  const users = new Map<string, string[]>();
  if (!settings) return users;
  const add = (selection: ModelSelection | null, name: string) => {
    if (!selection) return;
    const key = modelKey(selection);
    users.set(key, [...(users.get(key) ?? []), name]);
  };
  const fallback = catalog?.defaultModel ?? null;
  add(resolveModel(settings.director.model, catalog, fallback).selection, "Director");
  for (const id of SPECIALIST_IDS) {
    const specialist = settings.specialists[id];
    if (!specialist.enabledByDefault) continue;
    add(resolveModel(specialist.model, catalog, fallback).selection, AGENT_DISPLAY_NAMES[id]);
  }
  const { jev } = settings;
  if (jev.enabled && jev.provider && jev.modelId) {
    add({ provider: jev.provider, modelId: jev.modelId }, "Jev");
  }
  return users;
}
