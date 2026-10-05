/**
 * The headless Chrome session shared by the site reader (`inspect-site`) and the page recorder (`record-site`): how
 * the browser is launched, what every document is forbidden to do, how every request is held to the address rules,
 * how the page is settled, and the typed errors both commands report.
 *
 * The page is untrusted and runs its own scripts before ours, so the guard is installed for every document before
 * anything of the page runs. Requests are checked one by one (every redirect hop included), and Chrome reaches the
 * network only through the vetting proxy, which connects to the addresses the policy vetted and nothing else: that
 * covers what request interception never sees (WebSocket handshakes, workers, preconnects) and a name that
 * resolves differently the second time.
 */

import type { Browser, HTTPResponse, Page } from "puppeteer-core";
import { installPageFunctionGuard } from "../capture/captureCompositionFrame.js";
import type { RequestPolicy } from "./requestPolicy.js";
import { startSiteProxy, type ProxyRefusal } from "./siteProxy.js";

export const SITE_INSPECT_ERROR_CODES = [
  "blocked_by_policy",
  "unavailable",
  "network",
  "unsupported",
] as const;
export type SiteInspectErrorCode = (typeof SITE_INSPECT_ERROR_CODES)[number];

export class SiteInspectError extends Error {
  constructor(
    readonly code: SiteInspectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SiteInspectError";
  }
}

export const CHROME_ARGS = [
  "--disable-extensions",
  "--disable-sync",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-component-update",
  "--disable-features=Translate,MediaRouter",
  "--no-first-run",
  "--no-default-browser-check",
  "--mute-audio",
  "--hide-scrollbars",
  "--block-new-web-contents",
  "--force-color-profile=srgb",
  "--disable-dev-shm-usage",
  // No QUIC (WebTransport and HTTP/3 are UDP the proxy cannot carry) and no WebRTC UDP outside the proxy.
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  // Loopback is proxied too (and refused there), so no socket opens to a local service behind the proxy's back.
  "--proxy-bypass-list=<-loopback>",
];

// Chrome, puppeteer and sharp load lazily: they are only needed by these commands, not by every CLI start.
export async function launchChrome(
  userDataDir: string,
  policy: RequestPolicy,
  refusals: ProxyRefusal[],
  lookupFor?: Parameters<typeof startSiteProxy>[2],
): Promise<Browser> {
  const { ensureBrowser } = await import("../browser/manager.js");
  const puppeteer = await import("puppeteer-core");
  let executablePath: string;
  try {
    executablePath = (await ensureBrowser()).executablePath;
  } catch (error) {
    throw new SiteInspectError(
      "unsupported",
      `No Chrome is available to render the page: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // The renderer sandbox stays on: this opens pages nobody vetted. Only a root user on Linux cannot have it.
  const root = process.platform === "linux" && process.getuid?.() === 0;
  const proxy = await startSiteProxy(policy, refusals, lookupFor);
  try {
    const browser = await puppeteer.default.launch({
      headless: true,
      executablePath,
      // Chrome exits when this pipe closes, so a killed CLI never leaves a browser behind.
      pipe: true,
      userDataDir,
      args: [
        ...CHROME_ARGS,
        `--proxy-server=http://127.0.0.1:${proxy.port}`,
        ...(root ? ["--no-sandbox"] : []),
      ],
    });
    // The proxy lives exactly as long as the browser it serves.
    browser.once("disconnected", () => void proxy.close());
    return browser;
  } catch (error) {
    await proxy.close();
    throw error;
  }
}

/**
 * Script run in every document before the page's own: no sockets, no service workers, no popups. Workers do not run
 * it, which is why the network layer (the proxy) holds the same rules for their sockets.
 */
export const LOCKDOWN_SCRIPT = String.raw`(() => {
  var deny = function (name) {
    return function () { throw new DOMException(name + " is disabled while a page is being read", "SecurityError"); };
  };
  try { window.WebSocket = deny("WebSocket"); } catch (e) {}
  try { window.EventSource = deny("EventSource"); } catch (e) {}
  try { window.RTCPeerConnection = deny("RTCPeerConnection"); } catch (e) {}
  try { window.WebTransport = deny("WebTransport"); } catch (e) {}
  try { window.open = function () { return null; }; } catch (e) {}
  try { if (navigator.serviceWorker) Object.defineProperty(navigator, "serviceWorker", { value: undefined }); } catch (e) {}
})()`;

/** What the page was refused and what a collector wants to keep from the responses it was allowed. */
export interface PageCapture {
  blocked: ProxyRefusal[];
  pending: Array<Promise<void>>;
}

/**
 * Holds one page to the address rules: the lockdown script in every document, request interception through the
 * policy for every request (redirect hops included), dialogs dismissed. `onResponse` sees every response.
 */
export async function guardPage(
  page: Page,
  policy: RequestPolicy,
  capture: PageCapture,
  onResponse?: (response: HTTPResponse) => void,
): Promise<void> {
  await installPageFunctionGuard(page);
  await page.evaluateOnNewDocument(LOCKDOWN_SCRIPT);
  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    void (async () => {
      const refusal = await policy.check(request.url());
      try {
        if (refusal) {
          capture.blocked.push({ url: request.url(), reason: refusal.reason });
          await request.abort("blockedbyclient");
        } else {
          await request.continue();
        }
      } catch {
        // The page closed or the request was already answered.
      }
    })();
  });
  if (onResponse) page.on("response", onResponse);
  page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
}

/** Waits `ms`; the settle and the reader's lazy scroll share it. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the page stops fetching, its fonts are ready and a paint has settled. */
export async function settle(page: Page): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 700, timeout: 7000 }).catch(() => {});
  await Promise.race([
    page.evaluate(
      "document.fonts ? document.fonts.ready.then(function () { return true; }) : true",
    ),
    sleep(3000),
  ]).catch(() => {});
  await sleep(250);
}

export function explainNavigationError(
  error: unknown,
  url: string,
  capture: PageCapture,
): SiteInspectError {
  const message = error instanceof Error ? error.message : String(error);
  const refused = capture.blocked.find((entry) => entry.url === url) ?? capture.blocked[0];
  if (/ERR_BLOCKED_BY_CLIENT/.test(message) && refused) {
    return new SiteInspectError("blocked_by_policy", refused.reason);
  }
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(message)) {
    return new SiteInspectError("network", `Could not look up ${new URL(url).hostname}`);
  }
  if (/timeout|Timeout/.test(message)) {
    return new SiteInspectError("network", "The page did not respond in time");
  }
  const code = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
  return new SiteInspectError("network", `The page could not be opened${code ? ` (${code})` : ""}`);
}
