import { createHash } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import type { AssetSearchPolicy, ResearchMediaKind } from "@hyperframes/agent-protocol";
import { ResearchFailure, isResearchFailure } from "../errors.js";
import {
  isHtmlType,
  isStreamManifest,
  mediaKindFromContentType,
  mediaKindFromUrl,
} from "./mediaTypes.js";
import type { FetchedPage, ResearchHttp } from "./types.js";
import { pinnedTransport, type TransportInit } from "./pinnedTransport.js";
import { UrlGuard, assertInAllowedSites, type VettedUrl } from "./urlPolicy.js";

/**
 * Public media hosts ask automated clients to identify themselves with a contact URL (Wikimedia's User-Agent policy
 * answers downloads from an anonymous agent with 429), so the agent names the project.
 */
export const RESEARCH_USER_AGENT =
  "OpenVids/0.8 (https://github.com/bazodev/open-vids; desktop video editor, asset research)";

const MAX_REDIRECTS = 5;
const JSON_LIMIT_BYTES = 8 * 1024 * 1024;
const PAGE_LIMIT_BYTES = 3 * 1024 * 1024;
/** Commons answers video-derivative queries in up to ~20 s. */
const REQUEST_TIMEOUT_MS = 45_000;
const DOWNLOAD_IDLE_MS = 30_000;
/** How often a 429 answer is retried (after the first attempt) before the call fails `rate_limited`. */
const RATE_LIMIT_RETRIES = 2;
/** The longest one wait for a rate-limited host may last; a `Retry-After` beyond it fails the call at once. */
const MAX_RETRY_WAIT_MS = 15_000;
const BASE_RETRY_WAIT_MS = 1_000;
const STREAM_MESSAGE =
  "Streamed or protected media (HLS/DASH manifests) is not downloaded; look for a plain video file instead.";

/**
 * The network call (injectable): a `fetch`-like that must not follow redirects itself and must connect only to
 * `init.addresses`, the addresses the guard vetted for this hop, never to a fresh DNS answer.
 */
export type Transport = (url: string, init: TransportInit) => Promise<Response>;

export const globalTransport: Transport = pinnedTransport;

/** What one network operation may do: the policy in force and the exact hosts a candidate grant allows. */
export interface FetchScope {
  policy: AssetSearchPolicy;
  grants?: readonly string[];
  signal?: AbortSignal;
}

export interface DownloadOptions {
  maxBytes: number;
  /** The kind the caller wants; a different one is `not_media`. */
  expect?: ResearchMediaKind | undefined;
  signal?: AbortSignal | undefined;
}

export interface DownloadResult {
  finalUrl: string;
  contentType: string;
  mediaKind: ResearchMediaKind | null;
  bytes: number;
  sha256: string;
}

export interface PolicyFetcherOptions {
  transport?: Transport;
  guard?: UrlGuard;
  userAgent?: string;
  timeoutMs?: number;
  downloadIdleMs?: number;
  /** Waits between rate-limited attempts (tests inject a recording sleep). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Jitter source in [0, 1) (tests inject a fixed value). */
  random?: () => number;
  now?: () => number;
}

/** The wait a response asks for with `Retry-After` (seconds or an HTTP date), in ms; null when it asks for none. */
function retryAfterMs(response: Response, now: number): number | null {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return null;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The failure for a host that kept answering 429: what to tell the model, and when to try again when the host said
 * (`Retry-After`).
 */
export function rateLimitedFailure(host: string, response: Response, now: number): ResearchFailure {
  const wait = retryAfterMs(response, now);
  const when =
    wait === null
      ? ""
      : ` The host asks to wait ${Math.ceil(wait / 1000)} s before the next request.`;
  return new ResearchFailure(
    "rate_limited",
    `${host} answered 429 (too many requests) and kept doing so.${when} Do not retry this source right away: use another source, or other material, or wait.`,
  );
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Every byte OpenVids reads from the internet for research passes through here: each request and each redirect hop
 * is checked against the Asset Search policy ({@link UrlGuard}), bodies are size-bounded, and failures map to
 * research errors (404/410 → `unavailable`, refused hosts → `blocked_by_policy`, streams → `unsupported`).
 */
export class PolicyFetcher {
  private readonly transport: Transport;
  private readonly guard: UrlGuard;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly idleMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: PolicyFetcherOptions = {}) {
    this.transport = options.transport ?? globalTransport;
    this.guard = options.guard ?? new UrlGuard();
    this.userAgent = options.userAgent ?? RESEARCH_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.idleMs = options.downloadIdleMs ?? DOWNLOAD_IDLE_MS;
    this.sleep = options.sleep ?? sleepFor;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  /** The failure for a host that kept answering 429 (see {@link rateLimitedFailure}). */
  rateLimited(host: string, response: Response): ResearchFailure {
    return rateLimitedFailure(host, response, this.now());
  }

  /**
   * One request. A 429 answer is retried twice with a pause that follows `Retry-After` (or doubles from one second,
   * with jitter); a host that asks for longer than the cap, or keeps answering 429, is returned as is for the caller
   * to fail with {@link rateLimitedFailure}. The body of an answer that is retried is discarded.
   */
  private async requestWithBackoff(
    url: URL,
    headers: Record<string, string>,
    signal: AbortSignal,
    addresses: string[],
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.transport(url.toString(), {
        headers: { "user-agent": this.userAgent, ...headers },
        redirect: "manual",
        signal,
        addresses,
      });
      if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES || signal.aborted)
        return response;
      const asked = retryAfterMs(response, this.now());
      const wait = asked ?? BASE_RETRY_WAIT_MS * 2 ** attempt * (1 + this.random() * 0.5);
      if (wait > MAX_RETRY_WAIT_MS) return response;
      await response.body?.cancel().catch(() => undefined);
      await this.sleep(wait, signal);
    }
  }

  /** The URL check alone (used before anything is fetched, e.g. to report a blocked page without a request). */
  check(url: string, scope: FetchScope): Promise<URL> {
    return this.guard.check(url, scope.policy, scope.grants ?? []);
  }

  /** What a connector or the page inspector uses: JSON and page reads under `scope`. */
  http(scope: FetchScope): ResearchHttp {
    return {
      getJson: (url, options) => this.getJson(url, scope, options?.headers),
      getPage: (url) => this.getPage(url, scope),
    };
  }

  private signalFor(scope: FetchScope, timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return scope.signal ? AbortSignal.any([scope.signal, timeout]) : timeout;
  }

  /** Opens a response, following redirects by hand with the policy check on every hop. */
  async open(
    rawUrl: string,
    scope: FetchScope,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ response: Response; finalUrl: string }> {
    return this.follow(rawUrl, headers, signal, (url) =>
      this.guard.vet(url, scope.policy, scope.grants ?? []),
    );
  }

  /**
   * Opens a response under the address rules alone: full access to linked sites may open any public address, so the
   * trusted-source check does not apply. Redirects are followed by hand and every hop is vetted, exactly like
   * {@link open}. With `sites` (the websites the user linked) every hop must also belong to one of them, checked
   * before it is requested: a redirect off the linked sites is never followed.
   */
  async openPublic(
    rawUrl: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    sites?: readonly string[],
  ): Promise<{ response: Response; finalUrl: string }> {
    return this.follow(rawUrl, headers, signal, (url) => {
      assertInAllowedSites(url, sites);
      return this.guard.vetPublic(url);
    });
  }

  private async follow(
    rawUrl: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    vet: (url: string) => Promise<VettedUrl>,
  ): Promise<{ response: Response; finalUrl: string }> {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const { url, addresses } = await vet(current);
      let response: Response;
      try {
        response = await this.requestWithBackoff(url, headers, signal, addresses);
      } catch (error) {
        if (isResearchFailure(error)) throw error;
        throw networkFailure(url, error, signal);
      }
      if (REDIRECTS.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location)
          throw new ResearchFailure("network", `${url.host} redirected without saying where`);
        try {
          current = new URL(location, url).toString();
        } catch {
          throw new ResearchFailure("network", `${url.host} redirected to an invalid address`);
        }
        continue;
      }
      return { response, finalUrl: url.toString() };
    }
    throw new ResearchFailure("network", `Too many redirects from ${new URL(rawUrl).host}`);
  }

  private async opened(
    url: string,
    scope: FetchScope,
    headers: Record<string, string>,
    signal: AbortSignal,
    failure: "network" | "provider_error",
  ): Promise<{ response: Response; finalUrl: string }> {
    const result = await this.open(url, scope, headers, signal);
    const { status } = result.response;
    if (status >= 200 && status < 300) return result;
    await result.response.body?.cancel().catch(() => undefined);
    const host = new URL(result.finalUrl).host;
    if (status === 404 || status === 410) {
      throw new ResearchFailure(
        "unavailable",
        `${host} answered ${status}: the file or page is gone`,
      );
    }
    if (status === 429) throw this.rateLimited(host, result.response);
    throw new ResearchFailure(failure, `${host} answered ${status}`);
  }

  async getJson(
    url: string,
    scope: FetchScope,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const signal = this.signalFor(scope, this.timeoutMs);
    const { response, finalUrl } = await this.opened(
      url,
      scope,
      { accept: "application/json", ...headers },
      signal,
      "provider_error",
    );
    const host = new URL(finalUrl).host;
    const text = await readText(response, JSON_LIMIT_BYTES, false, host, signal);
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    } catch {
      throw new ResearchFailure("provider_error", `${host} did not answer with JSON`);
    }
  }

  async getPage(url: string, scope: FetchScope): Promise<FetchedPage> {
    const signal = this.signalFor(scope, this.timeoutMs);
    const { response, finalUrl } = await this.opened(
      url,
      scope,
      { accept: "text/html,application/xhtml+xml,*/*;q=0.5" },
      signal,
      "network",
    );
    const contentType = response.headers.get("content-type");
    if (isStreamManifest(finalUrl, contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResearchFailure("unsupported", STREAM_MESSAGE);
    }
    const mediaKind =
      mediaKindFromContentType(contentType) ??
      (isGeneric(contentType) ? mediaKindFromUrl(finalUrl) : null);
    if (mediaKind !== null) {
      await response.body?.cancel().catch(() => undefined);
      const length = Number(response.headers.get("content-length"));
      return {
        kind: "media",
        finalUrl,
        contentType: contentType?.split(";")[0]?.trim() || "application/octet-stream",
        bytes: Number.isFinite(length) && length > 0 ? length : null,
        mediaKind,
      };
    }
    if (isHtmlType(contentType) || contentType === null) {
      const html = await readText(
        response,
        PAGE_LIMIT_BYTES,
        true,
        new URL(finalUrl).host,
        signal,
        contentType,
      );
      return { kind: "html", finalUrl, html };
    }
    await response.body?.cancel().catch(() => undefined);
    return { kind: "other", finalUrl, contentType };
  }

  /**
   * Streams a media file to `destination` with its sha256, refusing HTML pages, stream manifests, files of a kind
   * other than `expect` and anything beyond `maxBytes` (nothing is left behind on a refusal).
   */
  async download(
    url: string,
    scope: FetchScope,
    destination: string,
    options: DownloadOptions,
  ): Promise<DownloadResult> {
    // One controller for the whole transfer: a timeout while the server has not answered, an idle timeout after.
    const control = new AbortController();
    const connect = control.signal;
    const outer = options.signal ?? scope.signal;
    if (outer?.aborted) control.abort();
    else outer?.addEventListener("abort", () => control.abort(), { once: true });
    let timer: NodeJS.Timeout | undefined = setTimeout(() => control.abort(), this.timeoutMs);
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => control.abort(), this.idleMs);
    };
    try {
      const { response, finalUrl } = await this.opened(
        url,
        scope,
        { accept: "video/*,audio/*,image/*,*/*;q=0.5" },
        connect,
        "network",
      );
      const host = new URL(finalUrl).host;
      const contentType = response.headers.get("content-type");
      if (isStreamManifest(finalUrl, contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new ResearchFailure("unsupported", STREAM_MESSAGE);
      }
      if (isHtmlType(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new ResearchFailure(
          "not_media",
          `${host} answered with a web page, not a media file`,
        );
      }
      const headerKind = mediaKindFromContentType(contentType);
      if (headerKind === null && !isGeneric(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new ResearchFailure(
          "not_media",
          `${host} answered with ${contentType?.split(";")[0]?.trim()}, which is not a media file`,
        );
      }
      const mediaKind = headerKind ?? mediaKindFromUrl(finalUrl) ?? options.expect ?? null;
      if (options.expect && mediaKind !== options.expect) {
        await response.body?.cancel().catch(() => undefined);
        throw new ResearchFailure(
          "not_media",
          `The file is ${describeKind(mediaKind)}, but ${describeKind(options.expect)} was wanted`,
        );
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new ResearchFailure(
          "too_large",
          `The file is ${mb(declared)} MB; the limit is ${mb(options.maxBytes)} MB`,
        );
      }
      if (!response.body) throw new ResearchFailure("network", `${host} sent no data`);

      const hash = createHash("sha256");
      const out = createWriteStream(destination);
      let bytes = 0;
      try {
        touch();
        for await (const chunk of chunksOf(response.body)) {
          touch();
          bytes += chunk.byteLength;
          if (bytes > options.maxBytes) {
            throw new ResearchFailure(
              "too_large",
              `The file is larger than ${mb(options.maxBytes)} MB`,
            );
          }
          hash.update(chunk);
          if (!out.write(chunk)) await once(out, "drain");
        }
        out.end();
        await finished(out);
      } catch (error) {
        out.destroy();
        rmSync(destination, { force: true });
        if (isResearchFailure(error)) throw error;
        throw networkFailure(new URL(finalUrl), error, connect);
      }
      if (bytes === 0) {
        rmSync(destination, { force: true });
        throw new ResearchFailure("not_media", `${host} sent an empty file`);
      }
      return {
        finalUrl,
        contentType: contentType?.split(";")[0]?.trim() || "application/octet-stream",
        mediaKind,
        bytes,
        sha256: hash.digest("hex"),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The chunks of a response body (`getReader` loop: DOM-lib streams are not async-iterable). Cancels on early exit. */
export async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const isGeneric = (contentType: string | null): boolean =>
  contentType === null ||
  /^(application\/octet-stream|binary\/octet-stream|application\/x-binary)\b/i.test(contentType);

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0);

function describeKind(kind: ResearchMediaKind | null): string {
  if (kind === "picture") return "a picture";
  if (kind === "video") return "a video";
  if (kind === "audio") return "an audio file";
  return "of unknown type";
}

function networkFailure(url: URL, error: unknown, signal: AbortSignal): ResearchFailure {
  if (signal.aborted) {
    return new ResearchFailure(
      "network",
      `${url.host} did not answer in time (or the request was cancelled)`,
    );
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new ResearchFailure("network", `Could not reach ${url.host}: ${reason}`);
}

/** Reads a body as text up to `limit` bytes: a larger one is truncated (pages) or refused (API answers). */
async function readText(
  response: Response,
  limit: number,
  truncate: boolean,
  host: string,
  signal: AbortSignal,
  contentType: string | null = response.headers.get("content-type"),
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    try {
      for await (const chunk of chunksOf(response.body)) {
        total += chunk.byteLength;
        if (total > limit) {
          if (!truncate)
            throw new ResearchFailure(
              "provider_error",
              `${host} answered with more than ${mb(limit)} MB`,
            );
          chunks.push(chunk.subarray(0, chunk.byteLength - (total - limit)));
          break;
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (isResearchFailure(error)) throw error;
      throw networkFailure(new URL(response.url || `https://${host}/`), error, signal);
    }
  }
  const bytes = Buffer.concat(chunks);
  const charset = /charset=([\w-]+)/i.exec(contentType ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
