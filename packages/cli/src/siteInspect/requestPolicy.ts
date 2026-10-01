import {
  isPrivateAddress,
  normalizeHostname,
  publicHostVerdict,
  systemResolver,
  type DnsResolver,
} from "@hyperframes/studio-server/public-address";

/** Why a request is not made: the address rules refused it, or its host could not be looked up. */
export interface RequestRefusal {
  kind: "blocked" | "lookup";
  reason: string;
}

/**
 * What the page being inspected may reach. Every request Chrome makes for it (the document, each redirect hop, every
 * subresource) passes `check` first: public http(s) hosts only, resolved here and every answer checked. Chrome
 * resolves names itself afterwards, so `remoteAddressProblem` re-checks the address the connection really used.
 */
export interface RequestPolicy {
  check(url: string): Promise<RequestRefusal | null>;
  remoteAddressProblem(ip: string | undefined): string | null;
}

/** Schemes that never touch the network. */
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);

export function createRequestPolicy(resolve: DnsResolver = systemResolver): RequestPolicy {
  const verdicts = new Map<string, Promise<RequestRefusal | null>>();

  const verdictFor = (host: string): Promise<RequestRefusal | null> => {
    const known = verdicts.get(host);
    if (known) return known;
    const pending = publicHostVerdict(host, resolve).then((verdict): RequestRefusal | null =>
      verdict.ok ? null : { kind: verdict.kind, reason: verdict.reason },
    );
    verdicts.set(host, pending);
    return pending;
  };

  return {
    async check(rawUrl) {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return { kind: "blocked", reason: `"${rawUrl.slice(0, 80)}" is not a valid URL` };
      }
      if (LOCAL_SCHEMES.has(url.protocol)) return null;
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return {
          kind: "blocked",
          reason: `Only http and https addresses are read, not ${url.protocol}`,
        };
      }
      if (url.username !== "" || url.password !== "") {
        return { kind: "blocked", reason: "Addresses with a user name or password are not read" };
      }
      const host = normalizeHostname(url.hostname);
      if (host === "") return { kind: "blocked", reason: "The URL has no host" };
      return verdictFor(host);
    },
    remoteAddressProblem(ip) {
      if (ip === undefined || ip === "") return null;
      const bare = ip.startsWith("[") ? ip.slice(1, -1) : ip;
      return isPrivateAddress(bare)
        ? `The connection went to a local or private network address (${bare})`
        : null;
    },
  };
}
