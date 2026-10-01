import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeSvg } from "@hyperframes/core/figma";
import { WEBSITE_LIMITS, type WebsiteLogo, type WebsiteStyle } from "@hyperframes/agent-protocol";
import type { Browser, HTTPResponse, Page } from "puppeteer-core";
import { CAPTURE_USER_AGENT } from "../capture/userAgent.js";
import { installPageFunctionGuard } from "../capture/captureCompositionFrame.js";
import { assembleStyle, fontMime, type CapturedFontFile } from "./assemble.js";
import { analyzeCss, type CssSheet } from "./cssAnalysis.js";
import { PAGE_SCRIPT, type RawPage } from "./pageScript.js";
import { parseRawPage, parseTokenPairs } from "./rawPage.js";
import { createRequestPolicy, type RequestPolicy } from "./requestPolicy.js";

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

const VIEWPORT = { width: 1440, height: 900 } as const;
const FULL_PAGE_MAX = { width: 1440, height: 3000 } as const;
/** Chrome cannot capture much more than this in one image. */
const FULL_PAGE_CAPTURE_HEIGHT = 6_000;
const DEFAULT_BUDGET_MS = 30_000;
const MAX_STYLESHEETS = 80;
const MAX_STYLESHEET_BYTES = 1_500_000;
const MAX_FONT_FILES = 40;
const LOGO_MIME = /^image\/(svg\+xml|png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon)$/i;

export interface InspectSiteOptions {
  url: string;
  /** Where the screenshots, logo and font files are written. */
  outDir: string;
  signal: AbortSignal;
  /** Total time for the whole read (default 30 s). */
  budgetMs?: number;
  policy?: RequestPolicy;
  onProgress?: (message: string) => void;
  /** Tests inject a browser; production launches the engine's Chrome. */
  launch?: () => Promise<Browser>;
}

export interface InspectSiteResult {
  site: WebsiteStyle;
  screenshots: Array<{ name: string; file: string; width: number; height: number }>;
  logo: { file: string; mimeType: string; url: string } | null;
  fonts: Array<{
    file: string;
    family: string;
    weight: number;
    style: "normal" | "italic";
    url: string;
    mimeType: string;
  }>;
}

const CHROME_ARGS = [
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
];

// Chrome, puppeteer and sharp load lazily: they are only needed by this command, not by every CLI start.
async function launchChrome(userDataDir: string): Promise<Browser> {
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
  return puppeteer.default.launch({
    headless: true,
    executablePath,
    // Chrome exits when this pipe closes, so a killed CLI never leaves a browser behind.
    pipe: true,
    userDataDir,
    args: [...CHROME_ARGS, ...(root ? ["--no-sandbox"] : [])],
  });
}

/** Script run in every document before the page's own: no sockets, no service workers, no popups. */
const LOCKDOWN_SCRIPT = String.raw`(() => {
  var deny = function (name) {
    return function () { throw new DOMException(name + " is disabled while a page is being read", "SecurityError"); };
  };
  try { window.WebSocket = deny("WebSocket"); } catch (e) {}
  try { window.EventSource = deny("EventSource"); } catch (e) {}
  try { window.RTCPeerConnection = deny("RTCPeerConnection"); } catch (e) {}
  try { window.open = function () { return null; }; } catch (e) {}
  try { if (navigator.serviceWorker) Object.defineProperty(navigator, "serviceWorker", { value: undefined }); } catch (e) {}
})()`;

interface Capture {
  stylesheets: CssSheet[];
  stylesheetCount: number;
  stylesheetBytes: number;
  fonts: Map<string, CapturedFontFile>;
  blocked: Array<{ url: string; reason: string }>;
  /** Set when a connection went to a private address although its name vetted as public (DNS rebinding). */
  violation: string | null;
  pending: Array<Promise<void>>;
}

async function guardPage(page: Page, policy: RequestPolicy, capture: Capture): Promise<void> {
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
  page.on("response", (response) => watchResponse(response, policy, capture));
  page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
}

function watchResponse(response: HTTPResponse, policy: RequestPolicy, capture: Capture): void {
  const problem = policy.remoteAddressProblem(response.remoteAddress().ip);
  if (problem) {
    capture.violation ??= `${new URL(response.url()).hostname}: ${problem}`;
    return;
  }
  const type = response.request().resourceType();
  if (!response.ok()) return;
  if (type === "stylesheet" && capture.stylesheetCount < MAX_STYLESHEETS) {
    capture.stylesheetCount += 1;
    capture.pending.push(
      response
        .text()
        .then((text) => {
          if (capture.stylesheetBytes + text.length > MAX_STYLESHEET_BYTES * 4) return;
          capture.stylesheetBytes += text.length;
          capture.stylesheets.push({
            text: text.slice(0, MAX_STYLESHEET_BYTES),
            baseUrl: response.url(),
          });
        })
        .catch(() => {}),
    );
  } else if (type === "font" && capture.fonts.size < MAX_FONT_FILES) {
    capture.pending.push(
      response
        .buffer()
        .then((data) => {
          if (data.byteLength > WEBSITE_LIMITS.fontFileBytes) return;
          const mimeType = fontMime(response.url(), response.headers()["content-type"] ?? null);
          capture.fonts.set(response.url(), { url: response.url(), data, mimeType });
        })
        .catch(() => {}),
    );
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function settle(page: Page): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 700, timeout: 7000 }).catch(() => {});
  await Promise.race([
    page.evaluate(
      "document.fonts ? document.fonts.ready.then(function () { return true; }) : true",
    ),
    sleep(3000),
  ]).catch(() => {});
  await sleep(250);
}

/** Scrolls the whole page once so lazily loaded content and scroll-revealed elements are in place. */
async function lazyScroll(page: Page, signal: AbortSignal): Promise<void> {
  const height = Number(
    await page.evaluate(
      "Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)",
    ),
  );
  const top = Math.min(Number.isFinite(height) ? height : 0, 9000);
  for (let y = 700; y < top && !signal.aborted; y += 700) {
    await page.evaluate(`window.scrollTo(0, ${y})`);
    await sleep(110);
  }
  await page.evaluate("window.scrollTo(0, 0)");
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 2500 }).catch(() => {});
  await sleep(250);
}

async function jpeg(page: Page, options: { fullPage?: boolean; quality: number }): Promise<Buffer> {
  if (options.fullPage) {
    const height = Number(
      await page.evaluate(
        "Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)",
      ),
    );
    return Buffer.from(
      await page.screenshot({
        type: "jpeg",
        quality: options.quality,
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: VIEWPORT.width,
          height: Math.max(
            VIEWPORT.height,
            Math.min(height || VIEWPORT.height, FULL_PAGE_CAPTURE_HEIGHT),
          ),
        },
      }),
    );
  }
  return Buffer.from(await page.screenshot({ type: "jpeg", quality: options.quality }));
}

async function shrinkToFit(
  image: Buffer,
): Promise<{ data: Buffer; width: number; height: number }> {
  const sharp = (await import("sharp")).default;
  for (const quality of [70, 55, 40, 28]) {
    const { data, info } = await sharp(image)
      .resize({
        width: FULL_PAGE_MAX.width,
        height: FULL_PAGE_MAX.height,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (data.byteLength <= WEBSITE_LIMITS.screenshotBytes || quality === 28) {
      return { data, width: info.width, height: info.height };
    }
  }
  throw new Error("unreachable");
}

async function fetchImage(
  browser: Browser,
  url: string,
  policy: RequestPolicy,
  capture: Capture,
): Promise<{ data: Buffer; mimeType: string } | null> {
  const tab = await browser.newPage();
  try {
    await guardPage(tab, policy, capture);
    const response = await tab.goto(url, { waitUntil: "load", timeout: 8000 });
    if (!response?.ok()) return null;
    const mimeType =
      (response.headers()["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!LOGO_MIME.test(mimeType)) return null;
    const data = await response.buffer();
    return data.byteLength <= WEBSITE_LIMITS.logoFileBytes ? { data, mimeType } : null;
  } catch {
    return null;
  } finally {
    await tab.close().catch(() => {});
  }
}

const EXTENSION_OF: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

function fileNameOf(url: string, mimeType: string, fallback: string): string {
  const last = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
  const cleaned = last.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  const hasExtension = /\.(woff2|woff|ttf|otf)$/i.test(cleaned);
  const extension = mimeType.replace("font/", "");
  return cleaned !== "" && hasExtension ? cleaned : `${fallback}.${extension}`;
}

/** The logo to save: an inline SVG first, then the first image that can be fetched (header logo, og image, icon). */
async function captureLogo(
  raw: RawPage,
  browser: Browser,
  outDir: string,
  policy: RequestPolicy,
  capture: Capture,
): Promise<{ logos: WebsiteLogo[]; saved: InspectSiteResult["logo"] }> {
  const logos: WebsiteLogo[] = [];
  let saved: InspectSiteResult["logo"] = null;

  const write = (name: string, data: Uint8Array, mimeType: string, url: string) => {
    writeFileSync(join(outDir, name), data);
    saved = { file: name, mimeType, url };
  };

  for (const candidate of raw.logos) {
    const common = { alt: candidate.alt, width: candidate.width, height: candidate.height };
    if (candidate.source === "inline_svg" && candidate.svg) {
      const clean = sanitizeSvg(candidate.svg);
      if (clean !== "" && !saved) {
        write("logo.svg", new TextEncoder().encode(clean), "image/svg+xml", raw.finalUrl);
        logos.push({ source: "inline_svg", url: raw.finalUrl, ...common, captured: true });
      } else {
        logos.push({ source: "inline_svg", url: raw.finalUrl, ...common, captured: false });
      }
      continue;
    }
    if (candidate.url === "") continue;
    let captured = false;
    if (!saved) {
      const image = await fetchImage(browser, candidate.url, policy, capture);
      if (image) {
        const ext = EXTENSION_OF[image.mimeType] ?? "png";
        const data =
          image.mimeType === "image/svg+xml"
            ? new TextEncoder().encode(sanitizeSvg(image.data.toString("utf8")))
            : image.data;
        if (data.byteLength > 0) {
          write(`logo.${ext}`, data, image.mimeType, candidate.url);
          captured = true;
        }
      }
    }
    logos.push({ source: "image", url: candidate.url, ...common, captured });
  }

  const extras: Array<{ source: "og_image" | "icon"; url: string; size: number }> = [];
  if (raw.ogImage) extras.push({ source: "og_image", url: raw.ogImage, size: 0 });
  for (const icon of [...raw.icons]
    .sort((a, b) => Number(b.svg) - Number(a.svg) || b.size - a.size)
    .slice(0, 1)) {
    extras.push({ source: "icon", url: icon.url, size: icon.size });
  }
  for (const extra of extras) {
    let captured = false;
    // An og:image is a social card, not a logo: it is listed, but only icons are saved when nothing else was found.
    if (!saved && extra.source === "icon") {
      const image = await fetchImage(browser, extra.url, policy, capture);
      if (image) {
        const ext = EXTENSION_OF[image.mimeType] ?? "png";
        const data =
          image.mimeType === "image/svg+xml"
            ? new TextEncoder().encode(sanitizeSvg(image.data.toString("utf8")))
            : image.data;
        if (data.byteLength > 0) {
          write(`logo.${ext}`, data, image.mimeType, extra.url);
          captured = true;
        }
      }
    }
    logos.push({
      source: extra.source,
      url: extra.url,
      alt: "",
      width: extra.size || null,
      height: extra.size || null,
      captured,
    });
  }
  return { logos, saved };
}

function notesFor(raw: RawPage, capture: Capture, documentHeight: number): string[] {
  const notes: string[] = [];
  if (raw.textLength < 150 && raw.visibleElements < 25) {
    notes.push(
      `The page rendered almost empty (${raw.textLength} characters of text). It may need a login, depend on something that did not load, or block automated browsers; the style below may not be the real one.`,
    );
  }
  if (
    /just a moment|attention required|access denied|are you human|captcha|verify you are|security check/i.test(
      raw.title,
    )
  ) {
    notes.push(
      `The page looks like a bot check or an access page ("${raw.title}"), not the site itself.`,
    );
  }
  if (capture.blocked.length > 0) {
    const hosts = [
      ...new Set(
        capture.blocked.flatMap((entry) => {
          try {
            return [new URL(entry.url).hostname];
          } catch {
            return [];
          }
        }),
      ),
    ].slice(0, 4);
    notes.push(
      `${capture.blocked.length} request${capture.blocked.length === 1 ? " was" : "s were"} refused because the address is local or private${hosts.length > 0 ? ` (${hosts.join(", ")})` : ""}.`,
    );
  }
  if (documentHeight > FULL_PAGE_CAPTURE_HEIGHT) {
    notes.push(
      `The page is ${documentHeight}px tall: the full-page screenshot covers its first ${FULL_PAGE_CAPTURE_HEIGHT}px, scaled down.`,
    );
  } else if (documentHeight > FULL_PAGE_MAX.height) {
    notes.push(
      `The full-page screenshot is scaled down to fit ${FULL_PAGE_MAX.height}px of height.`,
    );
  }
  return notes;
}

function explainNavigationError(error: unknown, url: string, capture: Capture): SiteInspectError {
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

export async function inspectSite(options: InspectSiteOptions): Promise<InspectSiteResult> {
  const { url, outDir, signal } = options;
  const policy = options.policy ?? createRequestPolicy();
  const progress = options.onProgress ?? (() => {});
  const capture: Capture = {
    stylesheets: [],
    stylesheetCount: 0,
    stylesheetBytes: 0,
    fonts: new Map(),
    blocked: [],
    violation: null,
    pending: [],
  };

  const first = await policy.check(url);
  if (first) {
    throw new SiteInspectError(
      first.kind === "blocked" ? "blocked_by_policy" : "network",
      first.reason,
    );
  }
  signal.throwIfAborted();
  mkdirSync(outDir, { recursive: true });

  const profileDir = mkdtempSync(join(tmpdir(), "openvids-site-"));
  let browser: Browser | undefined;
  let timedOut = false;
  const budget = setTimeout(() => {
    timedOut = true;
    void browser?.close().catch(() => {});
  }, options.budgetMs ?? DEFAULT_BUDGET_MS);
  const onAbort = () => void browser?.close().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    progress("Launching headless Chrome");
    browser = await (options.launch ? options.launch() : launchChrome(profileDir));
    if (signal.aborted || timedOut) await browser.close();
    signal.throwIfAborted();

    const control = await browser.target().createCDPSession();
    await control.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});

    const page = await browser.newPage();
    await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
    await page.setUserAgent(CAPTURE_USER_AGENT);
    await guardPage(page, policy, capture);

    progress(`Opening ${url}`);
    let response: HTTPResponse | null;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (timedOut)
        throw new SiteInspectError("network", "The page did not finish loading in time");
      throw explainNavigationError(error, url, capture);
    }
    if (capture.violation) throw new SiteInspectError("blocked_by_policy", capture.violation);
    const status = response?.status() ?? 0;
    if (status >= 400) {
      throw new SiteInspectError("unavailable", `The page answered HTTP ${status}`);
    }

    await settle(page);
    progress("Taking screenshots");
    const viewportShot = await jpeg(page, { quality: 72 });
    await lazyScroll(page, signal);

    progress("Reading styles");
    const raw = parseRawPage(await page.evaluate(PAGE_SCRIPT));
    if (!raw)
      throw new SiteInspectError(
        "unavailable",
        "The page could not be read (its address is not usable)",
      );
    await Promise.allSettled(capture.pending);
    if (capture.violation) throw new SiteInspectError("blocked_by_policy", capture.violation);

    const css = analyzeCss([
      ...raw.inlineCss.map((text) => ({ text, baseUrl: raw.finalUrl })),
      ...capture.stylesheets,
    ]);
    const tokenValues = css.tokenNames.length
      ? parseTokenPairs(
          await page.evaluate(
            `(${JSON.stringify(css.tokenNames)}).map(function (name) { return [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim().slice(0, 200)]; })`,
          ),
        )
      : [];

    progress("Reading the logo");
    const { logos, saved } = await captureLogo(raw, browser, outDir, policy, capture);

    progress("Capturing the full page");
    const full = await shrinkToFit(await jpeg(page, { fullPage: true, quality: 75 }));
    writeFileSync(join(outDir, "viewport.jpg"), viewportShot);
    writeFileSync(join(outDir, "fullpage.jpg"), full.data);
    if (capture.violation) throw new SiteInspectError("blocked_by_policy", capture.violation);

    const { site, fontPicks } = assembleStyle({
      requestedUrl: url,
      raw,
      css,
      tokenValues,
      fontFiles: capture.fonts,
      logos,
      notes: notesFor(raw, capture, raw.documentHeight),
      now: Date.now(),
    });

    mkdirSync(join(outDir, "fonts"), { recursive: true });
    const fonts: InspectSiteResult["fonts"] = fontPicks.map((pick) => {
      const file = `fonts/${fileNameOf(pick.url, pick.mimeType, `${pick.family}-${pick.weight}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))}`;
      writeFileSync(join(outDir, file), pick.data);
      return {
        file,
        family: pick.family,
        weight: pick.weight,
        style: pick.style,
        url: pick.url,
        mimeType: pick.mimeType,
      };
    });

    return {
      site,
      screenshots: [
        {
          name: "viewport.jpg",
          file: "viewport.jpg",
          width: VIEWPORT.width,
          height: VIEWPORT.height,
        },
        { name: "fullpage.jpg", file: "fullpage.jpg", width: full.width, height: full.height },
      ],
      logo: saved,
      fonts,
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
    if (timedOut && !(error instanceof SiteInspectError)) {
      throw new SiteInspectError("network", "The page took too long to read (30 s budget)");
    }
    throw error;
  } finally {
    clearTimeout(budget);
    signal.removeEventListener("abort", onAbort);
    await browser?.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
  }
}
