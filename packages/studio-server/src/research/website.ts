import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, posix } from "node:path";
import {
  WEBSITE_ASSET_DIR,
  WEBSITE_LIMITS,
  WEBSITE_SOURCE_ID,
  type AssetProvenance,
  type AssetSearchMode,
  type ProvenanceMediaKind,
  type ReadWebsiteRequest,
  type ReadWebsiteResult,
  type SavedWebsiteFiles,
  type SavedWebsiteFont,
  type WebsiteScreenshot,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import { pinWithinProject } from "../helpers/safePath.js";
import type {
  ResolvedProject,
  StudioApiAdapter,
  WebsiteFile,
  WebsiteInspection,
} from "../types.js";
import { ResearchFailure } from "./errors.js";
import { readLedger, writeLedger } from "./provenance.js";
import { RequestRegistry, type RequestGuard } from "./requestRegistry.js";
import type { PolicyStore } from "./sources/policyStore.js";
import { assertInAllowedSites, type UrlGuard } from "./sources/urlPolicy.js";
import type { WebsiteGrantStore } from "./websiteGrants.js";

type InspectWebsite = NonNullable<StudioApiAdapter["inspectWebsite"]>;

export interface WebsiteReaderOptions {
  store: PolicyStore;
  guard: UrlGuard;
  /** Runs the page in headless Chrome outside this process (the CLI child); absent where there is no browser. */
  inspect: InspectWebsite | undefined;
  requests: RequestRegistry;
  /** The one-time grants ("Allow once") that let a turn read while `readLinkedPages` is off. */
  grants: WebsiteGrantStore;
  /** Serializes writes to a project with the other research writes. */
  lock: <T>(project: ResolvedProject, task: () => Promise<T>) => Promise<T>;
  now: () => number;
}

const SAFE_NAME = /[^a-z0-9._-]+/g;

/** A file name that is safe inside a project folder: lower case, no directories, a known extension kept. */
export function safeFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const cleaned = base
    .toLowerCase()
    .replace(SAFE_NAME, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+$/, "");
  if (cleaned === "") return fallback;
  const dot = cleaned.lastIndexOf(".");
  if (cleaned.length <= 80 || dot < 0) return cleaned.slice(0, 80);
  return `${cleaned.slice(0, 80 - (cleaned.length - dot))}${cleaned.slice(dot)}`;
}

/** The folder name of a host under `assets/web/`: `example.com`, `docs.example.co.uk`. */
export function hostFolder(host: string): string {
  const cleaned = host
    .toLowerCase()
    .replace(SAFE_NAME, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned === "" ? "site" : cleaned.slice(0, 80);
}

function sha256Of(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface WebsiteProvenanceInput {
  /** Project-relative path the file was written to. */
  asset: string;
  mediaKind: ProvenanceMediaKind;
  title: string;
  /** The URL the bytes came from, as requested. */
  originalUrl: string;
  pageUrl: string;
  /** The site's host (`example.com`). */
  host: string;
  sha256: string;
  bytes: number;
  contentType: string | null;
  retrievedBy: AssetProvenance["retrievedBy"];
  policyMode: AssetSearchMode;
  at: number;
}

/**
 * A provenance record for a file saved from a website reference: source `website`, license unknown (the site's own
 * terms were not checked). The id is derived from the bytes and the URL, so saving the same file again replaces its
 * record instead of adding one.
 */
export function websiteProvenance(input: WebsiteProvenanceInput): AssetProvenance {
  return {
    id: `prov-${createHash("sha256").update(`${input.sha256}\0${input.originalUrl}`).digest("hex").slice(0, 12)}`,
    asset: input.asset,
    mediaKind: input.mediaKind,
    title: input.title,
    originalUrl: input.originalUrl,
    pageUrl: input.pageUrl,
    source: { id: WEBSITE_SOURCE_ID, name: input.host, trusted: false },
    author: null,
    authorUrl: null,
    license: "Unknown",
    licenseId: "unknown",
    licenseUrl: null,
    licenseConfidence: "none",
    licenseStatus: "unknown",
    licenseBasis: "Website reference: the site's own terms were not checked",
    attribution: `From ${input.host} (website reference)`,
    retrievedAt: input.at,
    retrievedBy: input.retrievedBy,
    policyMode: input.policyMode,
    sha256: input.sha256,
    originalSha256: input.sha256,
    bytes: input.bytes,
    contentType: input.contentType ?? "application/octet-stream",
    converted: null,
    storyNode: null,
    need: null,
  };
}

interface PlannedFile {
  /** Project-relative path. */
  asset: string;
  file: WebsiteFile;
  kind: ProvenanceMediaKind;
  title: string;
  originalUrl: string;
}

/**
 * The website style reader: checks the Websites setting and the address rules, has the page rendered by the CLI
 * child, answers the extracted style with the screenshots and, for `save`, writes the screenshots, logo and
 * self-hosted fonts into `assets/web/<host>/` with a provenance record each (so Sources & Licenses and the export
 * license check see them). A request with a `requestId` is cancellable through the research commit point.
 */
export class WebsiteReader {
  constructor(private readonly options: WebsiteReaderOptions) {}

  async read(
    project: ResolvedProject,
    request: ReadWebsiteRequest,
    client?: AbortSignal,
  ): Promise<ReadWebsiteResult> {
    const policy = this.options.store.get();
    if (
      !policy.websites.readLinkedPages &&
      !this.options.grants.allows(project.dir, request.turnId, "read")
    ) {
      throw new ResearchFailure(
        "blocked_by_policy",
        "Reading linked websites is turned off. The user can allow it in Settings → Asset Search → Websites.",
      );
    }
    assertInAllowedSites(request.url, request.allowedSites);
    const { url } = await this.options.guard.vetPublic(request.url);
    const inspect = this.options.inspect;
    if (!inspect) {
      throw new ResearchFailure(
        "unsupported",
        "This Studio cannot render web pages (no browser capability)",
      );
    }

    const guard = this.options.requests.begin(project.dir, request.requestId, client);
    try {
      const outcome = await inspect({ url: url.href, signal: guard.signal }).catch(
        (error: unknown) => {
          guard.assertLive();
          const message = error instanceof Error ? error.message : String(error);
          throw new ResearchFailure("network", `Could not read ${url.hostname}: ${message}`);
        },
      );
      guard.assertLive();
      if ("error" in outcome) throw new ResearchFailure(outcome.error.code, outcome.error.message);
      // The browser follows redirects itself: a page that ended off the linked sites is dropped unread and unsaved.
      assertInAllowedSites(outcome.site.finalUrl, request.allowedSites);

      const screenshots = outcome.screenshots
        .filter((shot) => shot.data.byteLength <= WEBSITE_LIMITS.screenshotBytes)
        .map(
          (shot): WebsiteScreenshot => ({
            name: shot.name,
            mimeType: shot.mimeType,
            data: Buffer.from(shot.data).toString("base64"),
            width: shot.width,
            height: shot.height,
          }),
        );
      if (!request.save) return { site: outcome.site, screenshots };
      const saved = await guard.race(
        this.options.lock(project, () =>
          Promise.resolve(this.save(project, outcome, request, policy.mode, guard)),
        ),
      );
      return { site: outcome.site, screenshots, saved };
    } catch (error) {
      throw guard.normalize(error);
    } finally {
      this.options.requests.end(guard);
    }
  }

  private plan(inspection: WebsiteInspection): PlannedFile[] {
    const { site } = inspection;
    const dir = posix.join(WEBSITE_ASSET_DIR, hostFolder(site.host));
    const planned: PlannedFile[] = [];
    const taken = new Set<string>();
    const add = (
      folder: string,
      file: WebsiteFile,
      kind: ProvenanceMediaKind,
      title: string,
      originalUrl: string,
    ) => {
      let name = safeFileName(file.name, "file");
      const dot = name.lastIndexOf(".");
      for (let n = 2; taken.has(posix.join(folder, name)); n += 1) {
        const stem = dot > 0 ? name.slice(0, dot) : name;
        name = `${stem}-${n}${dot > 0 ? name.slice(dot) : ""}`;
      }
      const asset = posix.join(folder, name);
      taken.add(asset);
      planned.push({ asset, file, kind, title, originalUrl });
    };
    for (const shot of inspection.screenshots) {
      const part = shot.name.startsWith("full") ? "full page" : "above the fold";
      add(dir, shot, "picture", `Screenshot of ${site.host} (${part})`, site.finalUrl);
    }
    if (inspection.logo) {
      add(dir, inspection.logo, "picture", `Logo of ${site.host}`, inspection.logo.url);
    }
    for (const font of inspection.fonts.slice(0, WEBSITE_LIMITS.savedFonts)) {
      if (font.data.byteLength > WEBSITE_LIMITS.fontFileBytes) continue;
      const style = font.style === "italic" ? " italic" : "";
      add(
        posix.join(dir, "fonts"),
        font,
        "font",
        `Font ${font.family} ${font.weight}${style} from ${site.host}`,
        font.url,
      );
    }
    return planned;
  }

  /** Writes the planned files and their provenance; the commit point sits right before the first write. */
  private save(
    project: ResolvedProject,
    inspection: WebsiteInspection,
    request: ReadWebsiteRequest,
    mode: AssetSearchMode,
    guard: RequestGuard,
  ): SavedWebsiteFiles {
    guard.assertLive();
    const { site } = inspection;
    const planned = this.plan(inspection);
    const targets = planned.map((entry) => {
      const destination = pinWithinProject(project.dir, entry.asset);
      if (!destination) {
        throw new ResearchFailure("invalid_request", `${entry.asset} is outside the project`);
      }
      return { entry, destination };
    });
    const now = this.options.now();
    const ledger = readLedger(project.dir);
    const records = targets.map(
      ({ entry }): AssetProvenance =>
        websiteProvenance({
          asset: entry.asset,
          mediaKind: entry.kind,
          title: entry.title,
          originalUrl: entry.originalUrl,
          pageUrl: site.finalUrl,
          host: site.host,
          sha256: sha256Of(entry.file.data),
          bytes: entry.file.data.byteLength,
          contentType: entry.file.mimeType,
          retrievedBy: {
            agent: request.agent ?? "user",
            turnId: request.turnId ?? null,
            model: request.model ?? null,
          },
          policyMode: mode,
          at: now,
        }),
    );

    // The commit: files and records land together, with no await in between.
    guard.commit();
    for (const { entry, destination } of targets) {
      mkdirSync(dirname(destination), { recursive: true });
      const unchanged =
        existsSync(destination) &&
        statSync(destination).size === entry.file.data.byteLength &&
        sha256Of(readFileSync(destination)) === sha256Of(entry.file.data);
      if (!unchanged) replaceFileAtomically(destination, entry.file.data, 0o644);
    }
    const written = new Set(records.map((record) => record.asset));
    writeLedger(project.dir, {
      schema: ledger.schema,
      records: [...ledger.records.filter((record) => !written.has(record.asset)), ...records],
    });

    const fonts: SavedWebsiteFont[] = planned.flatMap((entry) => {
      const font = inspection.fonts.find((candidate) => candidate === entry.file);
      return entry.kind === "font" && font
        ? [{ family: font.family, weight: font.weight, style: font.style, path: entry.asset }]
        : [];
    });
    const logo = inspection.logo
      ? (planned.find((entry) => entry.file === inspection.logo)?.asset ?? null)
      : null;
    return {
      dir: posix.join(WEBSITE_ASSET_DIR, hostFolder(site.host)),
      files: planned.map((entry) => entry.asset),
      logo,
      screenshots: planned
        .filter((entry) => inspection.screenshots.some((shot) => shot === entry.file))
        .map((entry) => entry.asset),
      fonts,
    };
  }
}
