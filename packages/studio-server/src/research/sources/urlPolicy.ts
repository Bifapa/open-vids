import {
  RESEARCH_LIMITS,
  type AssetSearchPolicy,
  type TrustedSource,
} from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../errors.js";
import {
  localHostProblem,
  normalizeHostname,
  publicHostVerdict,
  systemResolver,
  type DnsResolver,
} from "./address.js";
import { hostMatchesDomains } from "./domains.js";

/** The Asset Search policy's view of one enabled source list. */
function enabledSources(policy: AssetSearchPolicy): TrustedSource[] {
  return policy.sources.filter((source) => source.enabled);
}

/** The trusted source that vouches for a host (an enabled source with a matching domain), or null. */
export function sourceForHost(policy: AssetSearchPolicy, host: string): TrustedSource | null {
  return enabledSources(policy).find((source) => hostMatchesDomains(host, source.domains)) ?? null;
}

const blocked = (message: string) => new ResearchFailure("blocked_by_policy", message);

/** A URL that passed the guard, with the public addresses its host resolved to at that moment. */
export interface VettedUrl {
  url: URL;
  /** Every answer was checked public; a transport connects to these and never resolves the host again. */
  addresses: string[];
}

/**
 * The URL rules of Asset Search, enforced for every page read, API call and download (and every redirect hop):
 * http(s) only, no credentials in the URL, no local or private network addresses (host names are resolved and every
 * answer checked), and in trusted mode the host must belong to an enabled trusted source or be the exact host of a
 * candidate grant issued by one.
 */
export class UrlGuard {
  constructor(private readonly resolve: DnsResolver = systemResolver) {}

  /** The URL check alone, for callers that only need a verdict. */
  async check(
    rawUrl: string,
    policy: AssetSearchPolicy,
    grants: readonly string[] = [],
  ): Promise<URL> {
    return (await this.vet(rawUrl, policy, grants)).url;
  }

  /** The URL check plus the single resolution its verdict rests on, for a transport to pin. */
  async vet(
    rawUrl: string,
    policy: AssetSearchPolicy,
    grants: readonly string[] = [],
  ): Promise<VettedUrl> {
    return this.vetUrl(rawUrl, policy, grants);
  }

  /**
   * The address rules alone (http(s), no credentials, public addresses), for readers that are not bound to the
   * trusted sources: the website reader may open any public site the user linked.
   */
  async vetPublic(rawUrl: string): Promise<VettedUrl> {
    return this.vetUrl(rawUrl, null, []);
  }

  private async vetUrl(
    rawUrl: string,
    policy: AssetSearchPolicy | null,
    grants: readonly string[],
  ): Promise<VettedUrl> {
    if (rawUrl.length > RESEARCH_LIMITS.urlChars) {
      throw new ResearchFailure(
        "invalid_request",
        `A URL is at most ${RESEARCH_LIMITS.urlChars} characters`,
      );
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ResearchFailure("invalid_request", `"${rawUrl.slice(0, 120)}" is not a valid URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ResearchFailure(
        "invalid_request",
        `Only http and https addresses can be read, not ${url.protocol}`,
      );
    }
    if (url.username !== "" || url.password !== "") {
      throw blocked("Addresses with a user name or password are not read");
    }
    const host = normalizeHostname(url.hostname.toLowerCase());
    if (host === "") throw new ResearchFailure("invalid_request", "The URL has no host");
    const local = localHostProblem(host);
    if (local) throw blocked(local);

    if (policy) {
      if (policy.mode === "trusted") {
        const explicitPort = url.port !== "" && url.port !== "80" && url.port !== "443";
        const vouched = sourceForHost(policy, host) !== null || grants.includes(host);
        if (!vouched) {
          throw blocked(
            `${host} is not one of the enabled trusted sources (Asset Search is in trusted mode). Enable a source for it, add it as a trusted website, or switch to "any" mode.`,
          );
        }
        if (explicitPort) throw blocked(`Port ${url.port} is not used by the trusted sources`);
      }
    }

    const verdict = await publicHostVerdict(host, this.resolve);
    if (verdict.ok) return { url, addresses: verdict.addresses };
    if (verdict.kind === "lookup") throw new ResearchFailure("network", verdict.reason);
    throw blocked(verdict.reason);
  }
}
