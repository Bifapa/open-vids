import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { webBody } from "../../helpers/nodeStream.js";
import { isPrivateAddress } from "./urlPolicy.js";

/** What a transport needs for one request: the addresses the URL guard vetted for this very hop. */
export interface TransportInit {
  headers: Record<string, string>;
  redirect: "manual";
  signal: AbortSignal;
  /**
   * The public addresses the URL guard resolved and approved for the URL's host. A transport connects to these
   * and to nothing a second DNS lookup might answer.
   */
  addresses: readonly string[];
}

/** Statuses whose responses carry no body (the `Response` constructor refuses one for them). */
const hasNoBody = (status: number): boolean => status === 204 || status === 205 || status === 304;

/**
 * A `lookup` that never asks DNS: it hands the socket the vetted addresses, re-checking each one so that a pinned
 * private address (a bug upstream, not a rebinding answer) still cannot be connected to.
 */
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  return (_hostname, options, callback) => {
    const safe = addresses.filter((address) => !isPrivateAddress(address));
    const first = safe[0];
    if (first === undefined) {
      callback(new Error("No vetted public address to connect to"), "", 4);
      return;
    }
    const family = (address: string) => (address.includes(":") ? 6 : 4);
    if (options.all) {
      callback(
        null,
        safe.map((address) => ({ address, family: family(address) })),
      );
      return;
    }
    callback(null, first, family(first));
  };
}

function responseHeaders(message: IncomingMessage, decoded: boolean): Headers {
  const headers = new Headers();
  const raw = message.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    if (name === undefined || value === undefined) continue;
    const lower = name.toLowerCase();
    if (decoded && (lower === "content-encoding" || lower === "content-length")) continue;
    try {
      headers.append(name, value);
    } catch {
      // A header value `Headers` refuses is one no caller here reads.
    }
  }
  return headers;
}

function decoderFor(encoding: string) {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return null;
  }
}

/**
 * The production transport: connects ONLY to the addresses the URL guard vetted (no second DNS lookup, so a host
 * that answers differently the second time cannot steer the request to a private address), while `Host` and the TLS
 * SNI / certificate check keep using the original host name. Redirects are returned, never followed.
 */
export function pinnedTransport(url: string, init: TransportInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === "https:";
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    const send = secure ? httpsRequest : httpRequest;
    const request = send(
      {
        protocol: target.protocol,
        host: hostname,
        port: target.port === "" ? undefined : Number(target.port),
        method: "GET",
        path: `${target.pathname}${target.search}`,
        headers: { "accept-encoding": "gzip, deflate, br", ...init.headers },
        lookup: pinnedLookup(init.addresses),
        // SNI for a name; an IP literal must not be sent as SNI.
        ...(secure && { servername: /^[\d.]+$|:/.test(hostname) ? "" : hostname }),
      },
      (message) => {
        message.on("close", () => init.signal.removeEventListener("abort", abort));
        const status = message.statusCode ?? 502;
        const encoding = String(message.headers["content-encoding"] ?? "")
          .trim()
          .toLowerCase();
        const decoder = hasNoBody(status) ? null : decoderFor(encoding);
        let source: Readable = message;
        if (decoder) {
          pipeline(message, decoder, () => undefined);
          source = decoder;
        }
        const body = hasNoBody(status) ? null : webBody(source);
        if (body === null) message.resume();
        resolve(
          new Response(body, {
            status,
            statusText: message.statusMessage ?? "",
            headers: responseHeaders(message, decoder !== null),
          }),
        );
      },
    );
    const abort = () => request.destroy(init.signal.reason ?? new Error("aborted"));
    if (init.signal.aborted) abort();
    else init.signal.addEventListener("abort", abort, { once: true });
    request.on("error", (error) => {
      init.signal.removeEventListener("abort", abort);
      reject(error);
    });
    request.end();
  });
}
