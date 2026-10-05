import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { finished } from "node:stream/promises";
import {
  WEBSITE_ASSET_DIR,
  WEBSITE_LIMITS,
  isRecord,
  type AssetSearchPolicy,
  type ProvenanceMediaKind,
  type RecordWebsiteRequest,
  type RecordWebsiteResult,
  type WebsiteFileRequest,
  type WebsiteFileResult,
  type WebsiteResourceKind,
} from "@hyperframes/agent-protocol";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { pinWithinProject } from "../helpers/safePath.js";
import { ResearchFailure, isResearchFailure } from "./errors.js";
import { readLedger, writeLedger } from "./provenance.js";
import { RequestRegistry, type RequestGuard } from "./requestRegistry.js";
import { extensionFor } from "./sources/mediaTypes.js";
import { PolicyFetcher, chunksOf } from "./sources/policyFetch.js";
import type { PolicyStore } from "./sources/policyStore.js";
import { assertInAllowedSites, type UrlGuard } from "./sources/urlPolicy.js";
import { hostFolder, safeFileName, websiteProvenance } from "./website.js";
import type { WebsiteGrantStore } from "./websiteGrants.js";

type RecordWebsite = NonNullable<StudioApiAdapter["recordWebsite"]>;

/**
 * Full access downloads a browser's share of a site's files, so it asks like a browser rather than like the research
 * connectors (which identify OpenVids with a contact URL).
 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CONNECT_TIMEOUT_MS = 45_000;
const IDLE_TIMEOUT_MS = 30_000;
/** Lottie JSON is only sniffed below this size (a bigger download is saved without the extra read). */
const SNIFF_BYTES = 8 * 1024 * 1024;
const FILE_HEADERS = { "user-agent": BROWSER_USER_AGENT, accept: "*/*" };
const READ_HEADERS = {
  "user-agent": BROWSER_USER_AGENT,
  accept:
    "text/html,application/xhtml+xml,application/json,text/css,text/javascript,image/svg+xml,*/*;q=0.5",
};

const GENERIC_TYPE = /^(application|binary)\/(octet-stream|x-binary)$/;

const KIND_BY_EXTENSION: Record<string, WebsiteResourceKind> = {
  svg: "svg",
  css: "stylesheet",
  js: "script",
  mjs: "script",
  cjs: "script",
  html: "document",
  htm: "document",
  xhtml: "document",
  json: "data",
  map: "data",
  xml: "data",
  txt: "data",
  csv: "data",
  md: "data",
  webmanifest: "data",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  avif: "image",
  ico: "image",
  bmp: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  ogv: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  opus: "audio",
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  eot: "font",
  lottie: "animation",
  riv: "animation",
};

const EXTENSION_BY_KIND: Record<WebsiteResourceKind, string> = {
  image: "png",
  svg: "svg",
  video: "mp4",
  audio: "mp3",
  animation: "json",
  font: "woff2",
  stylesheet: "css",
  script: "js",
  document: "html",
  data: "json",
  other: "bin",
};

const TEXT_TYPES: Record<string, true> = {
  "application/json": true,
  "application/ld+json": true,
  "application/manifest+json": true,
  "application/javascript": true,
  "application/x-javascript": true,
  "application/ecmascript": true,
  "application/xml": true,
  "application/xhtml+xml": true,
  "application/rss+xml": true,
  "application/atom+xml": true,
  "application/yaml": true,
  "application/x-yaml": true,
  "image/svg+xml": true,
};

const TEXT_EXTENSIONS: Record<string, true> = {
  html: true,
  htm: true,
  xhtml: true,
  css: true,
  js: true,
  mjs: true,
  cjs: true,
  json: true,
  map: true,
  svg: true,
  xml: true,
  txt: true,
  md: true,
  csv: true,
  webmanifest: true,
  ts: true,
  tsx: true,
  jsx: true,
  yaml: true,
  yml: true,
  graphql: true,
};

function baseType(contentType: string | null): string | null {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "" ? null : type;
}

function extensionOf(url: URL): string {
  const name = url.pathname.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The kind of a response: its file extension first (a site's names are the most specific), then its Content-Type. */
function kindOf(url: URL, contentType: string | null): WebsiteResourceKind {
  const byExtension = KIND_BY_EXTENSION[extensionOf(url)];
  if (byExtension) return byExtension;
  const type = baseType(contentType) ?? "";
  if (type === "image/svg+xml") return "svg";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (
    type.startsWith("font/") ||
    type === "application/font-woff" ||
    type === "application/vnd.ms-fontobject"
  ) {
    return "font";
  }
  if (type === "text/css") return "stylesheet";
  if (/javascript|ecmascript/.test(type)) return "script";
  if (/^(text\/html|application\/xhtml\+xml)/.test(type)) return "document";
  if (type.startsWith("text/") || /json|xml|yaml|csv/.test(type)) return "data";
  return "other";
}

/** Whether `read` may return this response as text; a generic Content-Type falls back to the extension. */
function isTextual(url: URL, contentType: string | null): boolean {
  const type = baseType(contentType);
  if (type !== null && type.startsWith("text/")) return true;
  if (type !== null && TEXT_TYPES[type] === true) return true;
  if (type !== null && !GENERIC_TYPE.test(type)) return false;
  return TEXT_EXTENSIONS[extensionOf(url)] === true;
}

/** A Lottie animation: JSON with a version, a frame rate and layers (bodymovin's shape). */
function lottieLike(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return (
      isRecord(value) &&
      value.v !== undefined &&
      typeof value.fr === "number" &&
      Array.isArray(value.layers)
    );
  } catch {
    return false;
  }
}

function isJsonish(url: URL, contentType: string | null): boolean {
  return extensionOf(url) === "json" || /(^|\+)json$/.test(baseType(contentType) ?? "");
}

function fileNameFor(url: URL, contentType: string | null, kind: WebsiteResourceKind): string {
  const extension = extensionFor(url.toString(), contentType) ?? EXTENSION_BY_KIND[kind];
  const named = safeFileName(posix.basename(url.pathname), "");
  if (named === "") return `file.${extension}`;
  return /\.[a-z0-9]{1,8}$/.test(named) ? named : `${named}.${extension}`;
}

function evenSide(value: number): number {
  return Math.max(2, Math.min(Math.floor(value / 2) * 2, WEBSITE_LIMITS.recordMaxSide));
}

function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function secondsLabel(duration: number): string {
  return Number.isInteger(duration) ? String(duration) : duration.toFixed(1);
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

function safeAddress(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** sha256 of a file without loading it into memory (a download may be hundreds of megabytes). */
function sha256OfFile(file: string): string {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Copies a file from the private scratch dir into the project through a sibling temp file, then renames. */
function moveIntoProject(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  const staging = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    copyFileSync(source, staging);
    chmodSync(staging, 0o644);
    renameSync(staging, destination);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}

function mediaKindOf(kind: WebsiteResourceKind): ProvenanceMediaKind {
  switch (kind) {
    case "image":
    case "svg":
      return "picture";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "font":
      return "font";
    case "animation":
      return "animation";
    default:
      return "file";
  }
}

interface Control {
  signal: AbortSignal;
  /** Resets the idle timer (a slow server is fine as long as it keeps sending). */
  touch: () => void;
  done: () => void;
}

function controlledSignal(base: AbortSignal): Control {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (base.aborted) abort();
  else base.addEventListener("abort", abort, { once: true });
  let timer: NodeJS.Timeout | undefined = setTimeout(abort, CONNECT_TIMEOUT_MS);
  return {
    signal: controller.signal,
    touch: () => {
      clearTimeout(timer);
      timer = setTimeout(abort, IDLE_TIMEOUT_MS);
    },
    done: () => {
      clearTimeout(timer);
      base.removeEventListener("abort", abort);
    },
  };
}

export interface WebsiteFilesOptions {
  store: PolicyStore;
  /** The address rules alone: full access replaces the trusted-source check of Asset Search. */
  guard: UrlGuard;
  /** Every network access of full access goes through the fetcher's public open (per-hop vetted). */
  fetcher: PolicyFetcher;
  /** The adapter's browser (the CLI child); without it recording is unsupported. */
  record: RecordWebsite | undefined;
  requests: RequestRegistry;
  /** The one-time grants ("Allow once") that let a turn download and record while full access is off. */
  grants: WebsiteGrantStore;
  /** Serializes writes to a project with the other research writes. */
  lock: <T>(project: ResolvedProject, task: () => Promise<T>) => Promise<T>;
  now: () => number;
}

/**
 * Full access to the sites the user linked in chat (`websites.fullAccess`): downloads any file such a site serves or
 * its pages load into `assets/web/<host>/files/`, returns the raw text of its pages, styles and scripts, and records
 * its pages as MP4s into `assets/web/<host>/recordings/` (through the adapter's browser). Both requests are refused
 * `blocked_by_policy` while full access is off — unless the turn itself was granted full access once
 * ({@link WebsiteGrantStore}); every request and redirect hop passes the public address rules
 * ({@link UrlGuard.vetPublic}), never the trusted-source check. A request with a `requestId` is cancellable through
 * the research commit point: nothing is written after a cancel was answered `cancelled`.
 */
export class WebsiteFiles {
  constructor(private readonly options: WebsiteFilesOptions) {}

  /** `POST /api/projects/:id/research/website/file`: save a file of a linked site, or read its text. */
  async file(
    project: ResolvedProject,
    request: WebsiteFileRequest,
    client?: AbortSignal,
  ): Promise<WebsiteFileResult> {
    const policy = this.fullAccessPolicy(project, request.turnId);
    const vetted = await this.options.guard.vetPublic(request.url);
    const guard = this.options.requests.begin(project.dir, request.requestId, client);
    try {
      guard.assertLive();
      return request.mode === "read"
        ? await this.read(request, vetted.url.toString(), guard)
        : await this.save(project, request, vetted.url.toString(), policy, guard);
    } catch (error) {
      throw guard.normalize(error);
    } finally {
      this.options.requests.end(guard);
    }
  }

  /** `POST /api/projects/:id/research/website/record`: record a page as an MP4 through the adapter's browser. */
  async record(
    project: ResolvedProject,
    request: RecordWebsiteRequest,
    client?: AbortSignal,
  ): Promise<RecordWebsiteResult> {
    const policy = this.fullAccessPolicy(project, request.turnId);
    assertInAllowedSites(request.url, request.allowedSites);
    const vetted = await this.options.guard.vetPublic(request.url);
    const record = this.options.record;
    if (!record) {
      throw new ResearchFailure(
        "unsupported",
        "This Studio cannot record web pages (no browser capability)",
      );
    }
    const guard = this.options.requests.begin(project.dir, request.requestId, client);
    const scratch = mkdtempSync(join(tmpdir(), "openvids-website-record-"));
    const outFile = join(scratch, "recording.mp4");
    try {
      guard.assertLive();
      const width = evenSide(request.width ?? 1920);
      const height = evenSide(request.height ?? 1080);
      const outcome = await record({
        url: vetted.url.toString(),
        seconds: request.seconds,
        ...(request.selector !== undefined && { selector: request.selector }),
        ...(request.scroll !== undefined && { scroll: request.scroll }),
        width,
        height,
        outFile,
        signal: guard.signal,
      }).catch((error: unknown) => {
        guard.assertLive();
        const message = error instanceof Error ? error.message : String(error);
        throw new ResearchFailure("network", `Could not record ${vetted.url.host}: ${message}`);
      });
      guard.assertLive();
      if ("error" in outcome) throw new ResearchFailure(outcome.error.code, outcome.error.message);
      // The browser follows redirects itself: a recording that ended off the linked sites is dropped unwritten.
      assertInAllowedSites(outcome.finalUrl, request.allowedSites);
      if (!existsSync(outFile)) {
        throw new ResearchFailure("network", "The recorder produced no video file");
      }
      return await guard.race(
        this.options.lock(project, () =>
          Promise.resolve(
            this.commitRecording(project, request, guard, policy, {
              outFile,
              final: safeAddress(outcome.finalUrl) ?? vetted.url,
              finalUrl: outcome.finalUrl,
              width: outcome.width >= 2 ? evenSide(outcome.width) : width,
              height: outcome.height >= 2 ? evenSide(outcome.height) : height,
              duration: outcome.duration,
              bytes: statSync(outFile).size,
              notes: outcome.notes,
            }),
          ),
        ),
      );
    } catch (error) {
      throw guard.normalize(error);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      this.options.requests.end(guard);
    }
  }

  /**
   * The full-access gate: both switches must be on, or a `full` grant of this turn; the answer names where the user
   * turns them on. A granted turn passes as if the switches were on.
   */
  private fullAccessPolicy(
    project: ResolvedProject,
    turnId: string | undefined,
  ): AssetSearchPolicy {
    const policy = this.options.store.get();
    const granted = this.options.grants.allows(project.dir, turnId, "full");
    if (!policy.websites.readLinkedPages && !granted) {
      throw new ResearchFailure(
        "blocked_by_policy",
        "Reading linked websites is turned off. The user can allow it in Settings → Asset Search → Websites.",
      );
    }
    if (!policy.websites.fullAccess && !granted) {
      throw new ResearchFailure(
        "blocked_by_policy",
        "Full access to linked sites is off. The user can turn it on in Settings → Asset Search → Websites.",
      );
    }
    return policy;
  }

  private async opened(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    sites: readonly string[] | undefined,
  ): Promise<{ response: Response; finalUrl: string }> {
    const { response, finalUrl } = await this.options.fetcher.openPublic(
      url,
      headers,
      signal,
      sites,
    );
    if (response.status >= 200 && response.status < 300) return { response, finalUrl };
    await response.body?.cancel().catch(() => undefined);
    const host = new URL(finalUrl).host;
    if (response.status === 404 || response.status === 410) {
      throw new ResearchFailure(
        "unavailable",
        `${host} answered ${response.status}: the file or page is gone`,
      );
    }
    throw new ResearchFailure("network", `${host} answered ${response.status}`);
  }

  private async read(
    request: WebsiteFileRequest,
    url: string,
    guard: RequestGuard,
  ): Promise<WebsiteFileResult> {
    const control = controlledSignal(guard.signal);
    try {
      const { response, finalUrl } = await this.opened(
        url,
        READ_HEADERS,
        control.signal,
        request.allowedSites,
      );
      const contentType = response.headers.get("content-type");
      const final = new URL(finalUrl);
      const kind = kindOf(final, contentType);
      if (!isTextual(final, contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new ResearchFailure(
          "invalid_request",
          `${final.host} serves ${baseType(contentType) ?? "a binary file"}; it cannot be read as text — use mode "save" to download it`,
        );
      }
      guard.assertLive();
      const read = await this.readText(response, control);
      guard.assertLive();
      const animation = (kind === "data" || kind === "other") && lottieLike(read.text);
      return {
        url: request.url,
        finalUrl,
        kind: animation ? "animation" : kind,
        mimeType: baseType(contentType),
        bytes: read.bytes,
        text: read.text,
        truncated: read.truncated,
      };
    } finally {
      control.done();
    }
  }

  private async readText(
    response: Response,
    control: Control,
  ): Promise<{ text: string; bytes: number; truncated: boolean }> {
    // UTF-8 is at most 4 bytes per character; the cut is applied in characters after decoding.
    const limitBytes = WEBSITE_LIMITS.readTextChars * 4;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    if (response.body) {
      for await (const chunk of chunksOf(response.body)) {
        control.touch();
        if (bytes + chunk.byteLength <= limitBytes) {
          chunks.push(chunk);
          bytes += chunk.byteLength;
          continue;
        }
        const room = limitBytes - bytes;
        if (room > 0) {
          chunks.push(chunk.subarray(0, room));
          bytes += room;
        }
        truncated = true;
        break;
      }
    }
    const raw = Buffer.concat(chunks);
    const contentType = response.headers.get("content-type");
    const charset = /charset=([\w-]+)/i.exec(contentType ?? "")?.[1] ?? "utf-8";
    let text: string;
    try {
      text = new TextDecoder(charset).decode(raw);
    } catch {
      text = new TextDecoder("utf-8").decode(raw);
    }
    if (text.length > WEBSITE_LIMITS.readTextChars) {
      text = text.slice(0, WEBSITE_LIMITS.readTextChars);
      truncated = true;
    }
    return { text, bytes, truncated };
  }

  private async save(
    project: ResolvedProject,
    request: WebsiteFileRequest,
    url: string,
    policy: AssetSearchPolicy,
    guard: RequestGuard,
  ): Promise<WebsiteFileResult> {
    const scratch = mkdtempSync(join(tmpdir(), "openvids-website-"));
    const downloaded = join(scratch, "download");
    try {
      guard.assertLive();
      const control = controlledSignal(guard.signal);
      let file: { finalUrl: string; contentType: string | null; bytes: number; sha256: string };
      try {
        file = await this.download(url, downloaded, control, request.allowedSites);
      } finally {
        control.done();
      }
      guard.assertLive();
      const final = new URL(file.finalUrl);
      const kind = this.kindOfDownload(final, file.contentType, downloaded, file.bytes);
      return await guard.race(
        this.options.lock(project, () =>
          Promise.resolve(
            this.commitFile(project, request, guard, policy, {
              ...file,
              final,
              kind,
              downloaded,
            }),
          ),
        ),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private async download(
    url: string,
    destination: string,
    control: Control,
    sites: readonly string[] | undefined,
  ): Promise<{ finalUrl: string; contentType: string | null; bytes: number; sha256: string }> {
    const { response, finalUrl } = await this.opened(url, FILE_HEADERS, control.signal, sites);
    const contentType = response.headers.get("content-type");
    const host = new URL(finalUrl).host;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > WEBSITE_LIMITS.fileBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResearchFailure(
        "too_large",
        `${host} says the file is ${mb(declared)} MB; the limit is ${mb(WEBSITE_LIMITS.fileBytes)} MB`,
      );
    }
    if (!response.body) throw new ResearchFailure("network", `${host} sent no data`);
    const hash = createHash("sha256");
    const out = createWriteStream(destination);
    let bytes = 0;
    try {
      for await (const chunk of chunksOf(response.body)) {
        control.touch();
        bytes += chunk.byteLength;
        if (bytes > WEBSITE_LIMITS.fileBytes) {
          throw new ResearchFailure(
            "too_large",
            `The file is larger than ${mb(WEBSITE_LIMITS.fileBytes)} MB`,
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
      const reason = error instanceof Error ? error.message : String(error);
      throw new ResearchFailure("network", `Could not read ${host}: ${reason}`);
    }
    return { finalUrl, contentType, bytes, sha256: hash.digest("hex") };
  }

  private kindOfDownload(
    final: URL,
    contentType: string | null,
    file: string,
    bytes: number,
  ): WebsiteResourceKind {
    const kind = kindOf(final, contentType);
    if (kind === "animation" || bytes > SNIFF_BYTES || !isJsonish(final, contentType)) return kind;
    return lottieLike(readFileSync(file, "utf8")) ? "animation" : kind;
  }

  private commitFile(
    project: ResolvedProject,
    request: WebsiteFileRequest,
    guard: RequestGuard,
    policy: AssetSearchPolicy,
    input: {
      final: URL;
      finalUrl: string;
      contentType: string | null;
      bytes: number;
      sha256: string;
      kind: WebsiteResourceKind;
      downloaded: string;
    },
  ): WebsiteFileResult {
    guard.assertLive();
    const folder = posix.join(WEBSITE_ASSET_DIR, hostFolder(input.final.host), "files");
    const placed = this.place(
      project,
      folder,
      fileNameFor(input.final, input.contentType, input.kind),
      input.bytes,
      input.sha256,
    );
    const record = websiteProvenance({
      asset: placed.asset,
      mediaKind: mediaKindOf(input.kind),
      title: `${posix.basename(placed.asset)} from ${input.final.host}`,
      originalUrl: request.url,
      pageUrl: request.pageUrl ?? request.url,
      host: input.final.host,
      sha256: input.sha256,
      bytes: input.bytes,
      contentType: input.contentType,
      retrievedBy: {
        agent: request.agent ?? "user",
        turnId: request.turnId ?? null,
        model: request.model ?? null,
      },
      policyMode: policy.mode,
      at: this.options.now(),
    });
    const ledger = readLedger(project.dir);
    // The commit: the file and its record land together, with no await in between.
    guard.commit();
    if (!placed.reused) moveIntoProject(input.downloaded, placed.destination);
    writeLedger(project.dir, {
      schema: ledger.schema,
      records: [
        ...ledger.records.filter((entry) => entry.id !== record.id && entry.asset !== placed.asset),
        record,
      ],
    });
    return {
      url: request.url,
      finalUrl: input.finalUrl,
      kind: input.kind,
      mimeType: baseType(input.contentType),
      bytes: input.bytes,
      path: placed.asset,
    };
  }

  /** The free file name in the site's `files/` folder: an identical file is reused, a different one gets `-2`. */
  private place(
    project: ResolvedProject,
    folder: string,
    name: string,
    bytes: number,
    sha256: string,
  ): { asset: string; destination: string; reused: boolean } {
    let candidate = name;
    for (let n = 2; ; n += 1) {
      const asset = posix.join(folder, candidate);
      const destination = pinWithinProject(project.dir, asset);
      if (!destination) {
        throw new ResearchFailure("invalid_request", `${asset} is outside the project`);
      }
      if (!existsSync(destination)) return { asset, destination, reused: false };
      if (statSync(destination).size === bytes && sha256OfFile(destination) === sha256) {
        return { asset, destination, reused: true };
      }
      const dot = candidate.lastIndexOf(".");
      candidate = `${dot > 0 ? candidate.slice(0, dot) : candidate}-${n}${dot > 0 ? candidate.slice(dot) : ""}`;
    }
  }

  private commitRecording(
    project: ResolvedProject,
    request: RecordWebsiteRequest,
    guard: RequestGuard,
    policy: AssetSearchPolicy,
    input: {
      outFile: string;
      final: URL;
      finalUrl: string;
      width: number;
      height: number;
      duration: number;
      bytes: number;
      notes: string[];
    },
  ): RecordWebsiteResult {
    guard.assertLive();
    const host = input.final.host;
    const folder = posix.join(WEBSITE_ASSET_DIR, hostFolder(host), "recordings");
    const base = `${hostFolder(host)}-${stamp(this.options.now())}`;
    let name = `${base}.mp4`;
    for (let n = 2; existsSync(join(project.dir, folder, name)); n += 1) name = `${base}-${n}.mp4`;
    const asset = posix.join(folder, name);
    const destination = pinWithinProject(project.dir, asset);
    if (!destination) {
      throw new ResearchFailure("invalid_request", `${asset} is outside the project`);
    }
    const record = websiteProvenance({
      asset,
      mediaKind: "video",
      title:
        `Recording of ${host}${input.final.pathname || "/"} (${secondsLabel(input.duration)} s)`.slice(
          0,
          200,
        ),
      originalUrl: request.url,
      pageUrl: request.url,
      host,
      sha256: sha256OfFile(input.outFile),
      bytes: input.bytes,
      contentType: "video/mp4",
      retrievedBy: {
        agent: request.agent ?? "user",
        turnId: request.turnId ?? null,
        model: request.model ?? null,
      },
      policyMode: policy.mode,
      at: this.options.now(),
    });
    const ledger = readLedger(project.dir);
    // The commit: the recording and its record land together, with no await in between.
    guard.commit();
    moveIntoProject(input.outFile, destination);
    writeLedger(project.dir, {
      schema: ledger.schema,
      records: [
        ...ledger.records.filter((entry) => entry.id !== record.id && entry.asset !== asset),
        record,
      ],
    });
    return {
      path: asset,
      finalUrl: input.finalUrl,
      width: input.width,
      height: input.height,
      duration: input.duration,
      bytes: input.bytes,
      notes: input.notes,
    };
  }
}
