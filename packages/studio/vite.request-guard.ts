import type { IncomingMessage, ServerResponse } from "node:http";
// Relative on purpose: the dev host loads this config before any workspace
// build exists, and the CLI host runs the very same function (one guard).
import { checkStudioRequest } from "../studio-server/src/helpers/hostGuard";

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * First middleware of the Studio dev host. Vite runs plugin middlewares
 * before its own CORS and host checks, so without this gate any web page can
 * send CORS-simple POSTs to `/api` (CSRF) or rebind its hostname to loopback
 * and read the whole API (DNS rebinding). Same verdicts as the CLI host.
 */
export function studioRequestGuard(): (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void {
  return (req, res, next) => {
    const verdict = checkStudioRequest({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      host: headerValue(req.headers.host),
      origin: headerValue(req.headers.origin),
      secFetchSite: headerValue(req.headers["sec-fetch-site"]),
    });
    if (verdict === "ok") {
      next();
      return;
    }
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(verdict === "untrusted_host" ? "Forbidden host" : "Forbidden cross-origin request");
  };
}
