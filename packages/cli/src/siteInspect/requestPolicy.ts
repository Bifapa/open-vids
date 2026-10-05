import {
  normalizeHostname,
  publicHostVerdict,
  systemResolver,
  type DnsResolver,
  type PublicHostVerdict,
} from "@hyperframes/studio-server/public-address";

/** Why a request is not made: the address rules refused it, or its host could not be looked up. */
export interface RequestRefusal {
  kind: "blocked" | "lookup";
  reason: string;
}

/**
 * What the page being inspected may reach. Every request Chrome makes for it (the document, each redirect hop, every
 * subresource) passes `check` first: public http(s) hosts only, resolved here and every answer checked. Chrome
 * never resolves names itself: its connections go through the vetting proxy, which connects only to the addresses
 * `vet` settled on for the host, so a name that answers differently a second time reaches nothing private.
 */
export interface RequestPolicy {
  check(url: string): Promise<RequestRefusal | null>;
  /** The public addresses a host may be connected to (one lookup per host and run), or why it may not be. */
  vet(host: string): Promise<PublicHostVerdict>;
}

/** Schemes that never touch the network. */
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:"]);

export function createRequestPolicy(resolve: DnsResolver = systemResolver): RequestPolicy {
  const verdicts = new Map<string, Promise<PublicHostVerdict>>();

  const vet = (rawHost: string): Promise<PublicHostVerdict> => {
    const host = normalizeHostname(rawHost);
    const known = verdicts.get(host);
    if (known) return known;
    const pending = publicHostVerdict(host, resolve);
    verdicts.set(host, pending);
    return pending;
  };

  return {
    vet,
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
      const verdict = await vet(host);
      return verdict.ok ? null : { kind: verdict.kind, reason: verdict.reason };
    },
  };
}
