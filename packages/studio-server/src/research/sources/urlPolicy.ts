import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  RESEARCH_LIMITS,
  type AssetSearchPolicy,
  type TrustedSource,
} from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../errors.js";
import { hostMatchesDomains } from "./domains.js";

/** Addresses a host name resolves to (injectable so tests never touch DNS). */
export type DnsResolver = (host: string) => Promise<string[]>;

export const systemResolver: DnsResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Expands an IPv6 literal into eight 16-bit groups; null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const tail = text.lastIndexOf(":");
  const embedded = tail >= 0 ? ipv4Octets(text.slice(tail + 1)) : null;
  if (embedded) {
    const [a = 0, b = 0, c = 0, d = 0] = embedded;
    text = `${text.slice(0, tail + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const numbers = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN,
  );
  return numbers.length === 8 && numbers.every((value) => !Number.isNaN(value)) ? numbers : null;
}

/** Whether an IP literal (either family) is loopback, private, link-local, multicast or otherwise not public. */
export function isPrivateAddress(address: string): boolean {
  const v4 = ipv4Octets(address);
  if (v4) return isPrivateIpv4(v4);
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const leadingZeros = groups.slice(0, 7).every((group) => group === 0);
  if (leadingZeros && g7 <= 1) return true; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) carry an IPv4 address in the last 32 bits.
  const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIpv4(embedded);
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIpv4(embedded);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  return false;
}

const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
];

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

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
    const host = stripBrackets(url.hostname.toLowerCase()).replace(/\.$/, "");
    if (host === "") throw new ResearchFailure("invalid_request", "The URL has no host");
    const literal = isIP(host) !== 0;
    if (literal) {
      if (isPrivateAddress(host)) throw blocked(`${host} is a local or private network address`);
    } else if (
      host === "localhost" ||
      !host.includes(".") ||
      LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
    ) {
      throw blocked(`${host} is a local network name`);
    }

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

    if (literal) return { url, addresses: [host] };
    let addresses: string[];
    try {
      addresses = await this.resolve(host);
    } catch {
      throw new ResearchFailure("network", `Could not look up ${host}`);
    }
    if (addresses.length === 0) throw new ResearchFailure("network", `Could not look up ${host}`);
    const privateAddress = addresses.find((address) => isPrivateAddress(address));
    if (privateAddress)
      throw blocked(`${host} points to a local or private network address (${privateAddress})`);
    return { url, addresses };
  }
}
