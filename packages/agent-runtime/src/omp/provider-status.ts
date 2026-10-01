import type {
  ProviderCredentialSource,
  ProviderInfo,
  ProviderOAuthInfo,
  ProviderStatus,
} from "@hyperframes/agent-protocol";

/**
 * Pure derivation of the provider list the Settings window shows, from facts the OMP adapter reads out of the SDK.
 * Nothing here imports the SDK, so the rules are testable without it.
 *
 * What the SDK can and cannot tell (checked against the SDK source):
 * - Where a credential comes from: `AuthStorage.keys.source()` names the winning layer (runtime override = the key
 *   OpenVids stored, config/OAuth/login key/env/stored key = OMP's).
 * - Whether a login was lost: when an OAuth token refresh fails definitively the SDK tears the credential down and keeps
 *   a tombstone with the cause (`AuthStorage.credentials.listDisabled()`). That is the only sign-in problem it can
 *   report; an expired token that has not been refreshed yet looks like a normal login.
 * - Whether a key works: built-in providers' live model listing swallows HTTP errors, so a rejected key, an offline
 *   machine and a provider outage all look the same (discovery state `unavailable`, no message). Only providers
 *   configured through models.yml report a 401/403 separately (`unauthenticated`).
 */

/** The layer of the SDK's credential cascade that wins for a provider (`AuthStorage.keys.source().kind`). */
export type OmpCredentialKind = "runtime" | "config" | "oauth" | "api_key" | "env";

/** The SDK's own `ProviderDiscoveryState`, reduced to what the rules read. */
export interface DiscoveryFacts {
  status: "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";
  /** The live fetch failed or fell back to a cache/bundled catalog. */
  stale: boolean;
  /** Where the catalog came from: a live provider fetch, a cache, the bundled catalog. */
  source?: string;
  error?: string;
}

export interface ProviderFacts {
  id: string;
  /** The SDK's own label (`Anthropic (Claude Pro/Max)`), or null for a provider it has no label for. */
  sdkName: string | null;
  modelCount: number;
  /** The SDK counts the provider as having credentials (or needing none). */
  authenticated: boolean;
  credential: OmpCredentialKind | null;
  /** The winning credential is a sign-in made in OpenVids (a row of OpenVids' own auth store), not OMP's. */
  signedInWithOpenVids: boolean;
  /** The in-app sign-in the provider offers, or null (also null when sign-ins cannot be stored in this setup). */
  oauth: ProviderOAuthInfo | null;
  discovery: DiscoveryFacts | null;
  /** Cause of an OAuth sign-in the SDK tore down after a failed refresh, when nothing else authenticates the provider. */
  lostSignIn: string | null;
}

/** The SDK's labels are `/login` menu entries; these are the plain names Settings shows. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "ChatGPT (Codex sign-in)",
  google: "Google",
  "google-vertex": "Google Vertex AI",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  "github-copilot": "GitHub Copilot",
  mistral: "Mistral",
  groq: "Groq",
  xai: "xAI",
  deepseek: "DeepSeek",
};

export function providerDisplayName(id: string, sdkName: string | null): string {
  return DISPLAY_NAMES[id] ?? (sdkName && sdkName.trim() ? sdkName.trim() : id);
}

/**
 * The reasons with which the SDK retires an OAuth credential that was not lost: the user logging out (OMP's `/logout`,
 * `omp auth`) and housekeeping that removes a duplicate of an account that is still signed in. Every other reason (a
 * failed token refresh, an upstream "token invalidated") means the sign-in was lost.
 */
const BENIGN_DISABLE_CAUSES: ReadonlySet<string> = new Set([
  "deleted by user",
  "logged out by user",
  "deduplicated duplicate credential",
]);

export function isLostSignInCause(cause: string): boolean {
  return !BENIGN_DISABLE_CAUSES.has(cause);
}

const MAX_ERROR_CHARS = 300;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS - 1)}…` : flat;
}

export function credentialSource(
  kind: OmpCredentialKind | null,
  signedInWithOpenVids = false,
): ProviderCredentialSource | null {
  if (kind === null) return null;
  if (kind === "runtime") return "api-key";
  return signedInWithOpenVids && (kind === "oauth" || kind === "api_key") ? "oauth" : "omp";
}

function listingProblem(
  facts: ProviderFacts,
  source: ProviderCredentialSource | null,
): string | null {
  const { discovery } = facts;
  if (!discovery) return null;
  if (discovery.status === "unauthenticated") {
    return oneLine(discovery.error ?? "The provider rejected the credentials.");
  }
  if (discovery.status !== "unavailable") return null;
  // An explicit failure message (a timeout, a connection error) is real information about the provider.
  if (discovery.error) return oneLine(discovery.error);
  // Without a message the SDK cannot tell a rejected key from no network. For the key the user just typed into
  // OpenVids that is still the best signal there is; for OMP's own credentials it is too weak to call an error.
  if (source === "api-key") {
    return "The provider's model list could not be fetched with this key. The key may be invalid or the provider unreachable; the bundled model list is shown meanwhile.";
  }
  return null;
}

export function toProviderInfo(facts: ProviderFacts): ProviderInfo {
  const source = credentialSource(facts.credential, facts.signedInWithOpenVids);
  const keyless = facts.authenticated && facts.credential === null;
  const base = {
    id: facts.id,
    name: providerDisplayName(facts.id, facts.sdkName),
    authenticated: facts.authenticated,
    credentialSource: source,
    modelCount: facts.modelCount,
    oauth: facts.oauth,
    keyless,
    verified:
      facts.authenticated &&
      facts.discovery !== null &&
      facts.discovery.source === "provider" &&
      !facts.discovery.stale &&
      (facts.discovery.status === "ok" || facts.discovery.status === "empty"),
  };
  if (!facts.authenticated) {
    const lost = facts.lostSignIn;
    const status: ProviderStatus = lost === null ? "not_configured" : "signin_required";
    return {
      ...base,
      status,
      error:
        lost === null
          ? null
          : oneLine(`The sign-in expired or was revoked (${lost}). Sign in again.`),
    };
  }
  const problem = listingProblem(facts, source);
  return { ...base, status: problem === null ? "connected" : "error", error: problem };
}
