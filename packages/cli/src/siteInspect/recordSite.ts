/**
 * The page recorder behind `record-site` and the Studio server's `recordWebsite` capability (full access to linked
 * sites): a public page is opened in headless Chrome under the same address rules as the style reader, and N seconds
 * of it are captured, in real time, as an H.264 MP4.
 *
 * Frames come from CDP `Page.startScreencast` (JPEG) and are piped into FFmpeg. Chrome only sends a frame when the
 * page paints, so each frame is written as many times as a 30 fps grid says it lasted and the last one fills the
 * rest: the file is exactly `seconds` long whatever the page did, and a page that never repaints still gets a video.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WEBSITE_LIMITS, isRecord } from "@hyperframes/agent-protocol";
import type { Browser, HTTPResponse, Page } from "puppeteer-core";
import { findFFmpeg, getFFmpegInstallHint } from "../browser/ffmpeg.js";
import { CAPTURE_USER_AGENT } from "../capture/userAgent.js";
import { createRequestPolicy, type RequestPolicy } from "./requestPolicy.js";
import {
  explainNavigationError,
  guardPage,
  launchChrome,
  settle,
  SiteInspectError,
  type PageCapture,
} from "./siteSession.js";

const FPS = 30;
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;
/** Besides the recording itself: launching Chrome, loading the page, settling and encoding. */
const RECORD_GRACE_SECONDS = 40;
const NAVIGATION_TIMEOUT_MS = 20_000;
const FFMPEG_EXIT_GRACE_MS = 15_000;
const MAX_STDERR_CHARS = 2_000;

export interface RecordSiteOptions {
  url: string;
  /** Where the MP4 is written; the caller owns the file (a failed recording leaves nothing behind). */
  outFile: string;
  /** Length of the recording, {@link WEBSITE_LIMITS.recordMinSeconds}–{@link WEBSITE_LIMITS.recordMaxSeconds}. */
  seconds: number;
  /** Record only this element (scrolled into view and cropped); default the whole viewport. */
  selector?: string;
  /** Scroll smoothly from the top to the bottom of the page during the recording. */
  scroll?: boolean;
  /** Viewport side, whole even pixels up to {@link WEBSITE_LIMITS.recordMaxSide}; default 1920×1080. */
  width?: number;
  height?: number;
  /** Total time for the whole recording (default `seconds + 40 s`). */
  budgetMs?: number;
  signal: AbortSignal;
  policy?: RequestPolicy;
  onProgress?: (message: string) => void;
  /** Tests inject a browser; production launches the engine's Chrome. */
  launch?: () => Promise<Browser>;
}

export interface RecordSiteResult {
  /** After redirects. */
  finalUrl: string;
  /** The recorded frame, in pixels (the cropped element, or the viewport). */
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
  bytes: number;
  /** What the recorder noticed: a selector that matched nothing, refused requests. */
  notes: string[];
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An element's box in viewport coordinates. */
interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An even viewport side inside the protocol's limit, or null when the requested one is not usable. */
function evenSide(value: number | undefined, fallback: number): number | null {
  const side = Math.floor(value ?? fallback);
  if (!Number.isFinite(side) || side < 2 || side > WEBSITE_LIMITS.recordMaxSide) return null;
  return side % 2 === 0 ? side : null;
}

/** The part of an element's box inside the viewport, whole even pixels (H.264 4:2:0 needs even sides). */
export function cropRect(
  rect: ElementBox,
  viewport: { width: number; height: number },
): CropRect | null {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
  const width = Math.floor((right - left) / 2) * 2;
  const height = Math.floor((bottom - top) / 2) * 2;
  if (width < 2 || height < 2) return null;
  return { x: left, y: top, width, height };
}

/**
 * How many frames a captured frame covers on a constant-30fps grid anchored at the first frame. Differencing the
 * rounded cumulative positions keeps the total at `round(fps × elapsed)` whatever rate Chrome paints at: a static
 * page's single frame fills the whole recording, a fast animation's extra frames are dropped.
 */
export function framesToEmit(
  startTimestamp: number,
  previousTimestamp: number,
  timestamp: number,
  fps: number,
): number {
  const end = Math.round((timestamp - startTimestamp) * fps);
  const start = Math.round((previousTimestamp - startTimestamp) * fps);
  return Math.max(0, end - start);
}

interface FrameEncoder {
  /** Writes one more frame, unless the recording already has all of them or FFmpeg stopped. */
  write(buffer: Buffer): void;
  /** Frames written so far. */
  emitted(): number;
  /** Resolves once FFmpeg has taken every frame written so far; rejects when it stopped reading. */
  drained(): Promise<void>;
  /** Closes the input and waits for FFmpeg to finish the file. */
  finish(): Promise<{ code: number | null; stderr: string; timedOut: boolean }>;
  /** Stops FFmpeg now (the caller removes the partial file). */
  kill(): void;
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, timedOut: false });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve({ code: child.exitCode, timedOut: true });
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });
}

/** The FFmpeg half: JPEG frames in on stdin, one H.264 MP4 out, exactly `expected` frames long. */
function startEncoder(
  ffmpegPath: string,
  outFile: string,
  crop: CropRect | null,
  expected: number,
): FrameEncoder {
  const filters = [
    ...(crop ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`] : []),
    // Chrome's JPEG frames are full-range; H.264 in an MP4 is expected to be limited-range yuv420p.
    "scale=in_range=full:out_range=limited",
    "format=yuv420p",
  ];
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-framerate",
    String(FPS),
    "-i",
    "pipe:0",
    "-an",
    "-vf",
    filters.join(","),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-movflags",
    "+faststart",
    outFile,
  ];
  const child = spawn(ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
  });
  let emitted = 0;
  let pending = 0;
  let failure: Error | null = null;
  let releaseDrain: (() => void) | null = null;
  const settleDrain = () => {
    if (pending === 0 && releaseDrain) {
      const resolve = releaseDrain;
      releaseDrain = null;
      resolve();
    }
  };
  return {
    write(buffer) {
      if (emitted >= expected || failure) return;
      emitted += 1;
      pending += 1;
      const stdin = child.stdin;
      if (!stdin?.writable) {
        failure ??= new Error("FFmpeg stopped reading the recording");
        pending -= 1;
        settleDrain();
        return;
      }
      stdin.write(buffer, (error?: Error | null) => {
        pending -= 1;
        if (error) failure ??= error;
        settleDrain();
      });
    },
    emitted: () => emitted,
    async drained() {
      if (pending > 0) {
        await new Promise<void>((resolve) => {
          releaseDrain = resolve;
        });
      }
      if (failure) throw failure;
    },
    async finish() {
      if (child.stdin?.writable) child.stdin.end();
      const exited = await waitForExit(child, FFMPEG_EXIT_GRACE_MS);
      return { code: exited.code, stderr: stderrTail, timedOut: exited.timedOut };
    },
    kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

function waitForAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

const finiteField = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The element's box after scrolling it into view; null when the selector matches nothing, undefined when it is not
 * valid CSS at all.
 */
async function elementBox(page: Page, selector: string): Promise<ElementBox | null | undefined> {
  const raw: unknown = await page
    .evaluate(
      `(() => {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()`,
    )
    .catch(() => undefined);
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  const x = finiteField(raw.x);
  const y = finiteField(raw.y);
  const width = finiteField(raw.width);
  const height = finiteField(raw.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

/** Starts the page's own smooth scroll (eased, top to bottom) over the recording's length. */
async function startScroll(page: Page, seconds: number): Promise<void> {
  await page.evaluate(`(() => {
    window.__openvidsRecordScrollStopped = false;
    var max = Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight);
    var started = performance.now();
    var duration = ${Math.round(seconds * 1000)};
    function step(now) {
      if (window.__openvidsRecordScrollStopped) return;
      var progress = Math.min(1, (now - started) / duration);
      var eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      window.scrollTo(0, Math.round(eased * max));
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  })()`);
}

export async function recordSite(options: RecordSiteOptions): Promise<RecordSiteResult> {
  const { url, outFile, signal } = options;
  const progress = options.onProgress ?? (() => {});
  const policy = options.policy ?? createRequestPolicy();
  if (
    !Number.isFinite(options.seconds) ||
    options.seconds < WEBSITE_LIMITS.recordMinSeconds ||
    options.seconds > WEBSITE_LIMITS.recordMaxSeconds
  ) {
    throw new SiteInspectError(
      "unsupported",
      `A recording is ${WEBSITE_LIMITS.recordMinSeconds}-${WEBSITE_LIMITS.recordMaxSeconds} seconds long, not ${options.seconds}`,
    );
  }
  const width = evenSide(options.width, DEFAULT_VIEWPORT.width);
  const height = evenSide(options.height, DEFAULT_VIEWPORT.height);
  if (width === null || height === null) {
    throw new SiteInspectError(
      "unsupported",
      `The viewport must be whole even pixels up to ${WEBSITE_LIMITS.recordMaxSide} a side`,
    );
  }
  const ffmpegPath = findFFmpeg();
  if (!ffmpegPath) {
    throw new SiteInspectError(
      "unsupported",
      `FFmpeg is required to record a page (${getFFmpegInstallHint()})`,
    );
  }

  const first = await policy.check(url);
  if (first) {
    throw new SiteInspectError(
      first.kind === "blocked" ? "blocked_by_policy" : "network",
      first.reason,
    );
  }
  signal.throwIfAborted();
  mkdirSync(dirname(outFile), { recursive: true });

  const capture: PageCapture = { blocked: [], violation: null, pending: [] };
  const profileDir = mkdtempSync(join(tmpdir(), "openvids-site-"));
  const expected = Math.round(options.seconds * FPS);
  const notes: string[] = [];
  let browser: Browser | undefined;
  let encoder: FrameEncoder | undefined;
  let completed = false;
  let timedOut = false;
  const budgetMs = options.budgetMs ?? (options.seconds + RECORD_GRACE_SECONDS) * 1000;
  const budget = setTimeout(() => {
    timedOut = true;
    void browser?.close().catch(() => {});
  }, budgetMs);
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
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setUserAgent(CAPTURE_USER_AGENT);
    await guardPage(page, policy, capture);

    progress(`Opening ${url}`);
    let response: HTTPResponse | null;
    try {
      response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (timedOut)
        throw new SiteInspectError("network", "The page did not finish loading in time");
      throw explainNavigationError(error, url, capture);
    }
    if (capture.violation) throw new SiteInspectError("blocked_by_policy", capture.violation);
    const status = response?.status() ?? 0;
    if (status >= 400)
      throw new SiteInspectError("unavailable", `The page answered HTTP ${status}`);

    await settle(page);
    if (capture.violation) throw new SiteInspectError("blocked_by_policy", capture.violation);

    let crop: CropRect | null = null;
    if (options.selector) {
      const box = await elementBox(page, options.selector);
      if (box === undefined) {
        notes.push(
          `"${options.selector}" is not a valid CSS selector; the whole viewport was recorded.`,
        );
      } else {
        crop = box ? cropRect(box, { width, height }) : null;
        if (!box || !crop) {
          notes.push(
            `The selector "${options.selector}" ${box ? "is outside the viewport" : "matched nothing"}; the whole viewport was recorded.`,
          );
          crop = null;
        } else if (Math.ceil(box.width) > crop.width || Math.ceil(box.height) > crop.height) {
          notes.push(
            "The element is larger than the viewport; the recording covers the part inside it.",
          );
        }
      }
      if (options.scroll) {
        notes.push("Scrolling was skipped: the recording is cropped to the selector.");
      }
    }

    const sink = startEncoder(ffmpegPath, outFile, crop, expected);
    encoder = sink;
    progress(`Recording ${options.seconds} seconds`);
    // The first screencast frame can arrive before the page has painted; a real screenshot taken now is what the
    // video starts with, and the screencast's frames take over as soon as the page repaints.
    let lastFrame: Buffer | null = Buffer.from(
      await page.screenshot({ type: "jpeg", quality: 80 }),
    );
    if (options.scroll && !options.selector) await startScroll(page, options.seconds);

    const cdp = await page.createCDPSession();
    let startTimestamp: number | null = null;
    let previousTimestamp = 0;
    cdp.on("Page.screencastFrame", (event) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
      const timestamp = finiteField(event.metadata?.timestamp);
      if (timestamp === null) return;
      const buffer = Buffer.from(event.data, "base64");
      if (startTimestamp === null) {
        // The grid is anchored at the first frame; the screenshot already covers this instant.
        startTimestamp = timestamp;
        previousTimestamp = timestamp;
        return;
      }
      const count = framesToEmit(startTimestamp, previousTimestamp, timestamp, FPS);
      if (lastFrame) {
        for (let frame = 0; frame < count && sink.emitted() < expected; frame++) {
          sink.write(lastFrame);
        }
      }
      previousTimestamp = timestamp;
      lastFrame = buffer;
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1,
    });

    await waitForAbortable(options.seconds * 1000, signal);

    await page.evaluate("window.__openvidsRecordScrollStopped = true").catch(() => {});
    await cdp.send("Page.stopScreencast").catch(() => {});
    if (sink.emitted() < expected) {
      const filler = lastFrame ?? Buffer.from(await page.screenshot({ type: "jpeg", quality: 80 }));
      while (sink.emitted() < expected) sink.write(filler);
    }
    try {
      await sink.drained();
    } catch (error) {
      const failed = await sink.finish();
      const tail = failed.stderr.trim().split("\n").at(-1) ?? "";
      const reason = tail !== "" ? tail : error instanceof Error ? error.message : String(error);
      throw new SiteInspectError(
        "unsupported",
        `FFmpeg stopped before the recording was written${reason ? `: ${reason}` : ""}`,
      );
    }
    const finished = await sink.finish();
    if (finished.timedOut) {
      throw new SiteInspectError("unsupported", "FFmpeg did not finish the recording in time");
    }
    if (finished.code !== 0) {
      const reason = finished.stderr.trim().split("\n").at(-1) ?? "";
      throw new SiteInspectError(
        "unsupported",
        `FFmpeg could not encode the recording${reason ? `: ${reason}` : ""}`,
      );
    }
    const bytes = statSync(outFile).size;
    if (bytes === 0) throw new SiteInspectError("unsupported", "FFmpeg wrote an empty recording");

    if (capture.blocked.length > 0) {
      notes.push(
        `${capture.blocked.length} request${capture.blocked.length === 1 ? " was" : "s were"} refused because the address is local or private.`,
      );
    }
    completed = true;
    return {
      finalUrl: page.url(),
      width: crop?.width ?? width,
      height: crop?.height ?? height,
      duration: expected / FPS,
      bytes,
      notes,
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
    if (timedOut && !(error instanceof SiteInspectError)) {
      throw new SiteInspectError(
        "network",
        `The recording took too long (${Math.round(budgetMs / 1000)} s budget)`,
      );
    }
    throw error;
  } finally {
    clearTimeout(budget);
    signal.removeEventListener("abort", onAbort);
    encoder?.kill();
    if (!completed) rmSync(outFile, { force: true });
    await browser?.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
  }
}
