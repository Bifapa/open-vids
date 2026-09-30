import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetSearchMode } from "@hyperframes/agent-protocol";
import { createStoryFixture, type StoryFixture } from "../story/testSupport.js";
import type { MediaInspection, MediaToolkit } from "./normalize.js";
import { ResearchService } from "./service.js";
import { PolicyFetcher, type Transport } from "./sources/policyFetch.js";
import { PolicyStore } from "./sources/policyStore.js";
import type { WebSearchBackend, WebSearchHit } from "./sources/types.js";
import { UrlGuard, type DnsResolver } from "./sources/urlPolicy.js";

export const PUBLIC_IP = "93.184.216.34";

/** A recorded JSON/HTML fixture of the connector tests. */
export function fixtureText(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./sources/fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

/** A fresh Response per request (a body can be read once, and cancelling half of a clone never settles). */
export type Answer = (url: URL) => Response | Promise<Response>;

export const json =
  (value: unknown, status = 200): Answer =>
  () =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });

export const html =
  (body: string, status = 200): Answer =>
  () =>
    new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

export const media =
  (body: string, contentType: string, status = 200): Answer =>
  () =>
    new Response(body, { status, headers: { "content-type": contentType } });

export const httpStatus =
  (code: number): Answer =>
  () =>
    new Response("", { status: code });

export const redirect =
  (location: string): Answer =>
  () =>
    new Response(null, { status: 302, headers: { location } });

/** An offline network: URLs are answered by the first matching rule; everything else is a 404. */
export class FakeNet {
  readonly calls: string[] = [];
  private readonly rules: Array<{ match: (url: URL) => boolean; answer: Answer }> = [];

  /** A rule for an exact URL, or for every URL `match` accepts. */
  when(match: string | ((url: URL) => boolean), answer: Answer): this {
    const test = typeof match === "string" ? (url: URL) => url.toString() === match : match;
    this.rules.unshift({ match: test, answer });
    return this;
  }

  readonly transport: Transport = async (raw) => {
    this.calls.push(raw);
    const url = new URL(raw);
    const rule = this.rules.find((entry) => entry.match(url));
    if (!rule) return new Response("not found", { status: 404 });
    return rule.answer(url);
  };

  hosts(): string[] {
    return [...new Set(this.calls.map((call) => new URL(call).hostname))];
  }
}

/** Every host resolves to a public address unless `private` names it. */
export function resolver(privateHosts: Record<string, string> = {}): DnsResolver {
  return async (host) => [privateHosts[host] ?? PUBLIC_IP];
}

/**
 * The media "files" of the tests are short texts: the first word says what ffprobe would report. Conversion writes the
 * input behind a marker, so a converted file differs from its original.
 */
export function inspectionOf(text: string): MediaInspection {
  const base: MediaInspection = {
    kind: null,
    container: null,
    videoCodec: null,
    audioCodec: null,
    pixelFormat: null,
    width: null,
    height: null,
    duration: null,
  };
  const word = text.split(/[\s:]/)[0];
  switch (word) {
    case "H264":
      return {
        ...base,
        kind: "video",
        container: "mov,mp4,m4a,3gp,3g2,mj2",
        videoCodec: "h264",
        audioCodec: "aac",
        pixelFormat: "yuv420p",
        width: 1920,
        height: 1080,
        duration: 12,
      };
    case "VP9":
      return {
        ...base,
        kind: "video",
        container: "matroska,webm",
        videoCodec: "vp9",
        audioCodec: "opus",
        duration: 8,
      };
    case "LONGH264":
      return {
        ...base,
        kind: "video",
        container: "mov,mp4,m4a,3gp,3g2,mj2",
        videoCodec: "h264",
        duration: 3600,
      };
    case "JPEG":
      return { ...base, kind: "picture", container: "jpeg", width: 4000, height: 3000 };
    case "TIFF":
      return { ...base, kind: "picture", container: "tiff", width: 4000, height: 3000 };
    case "MP3":
      return { ...base, kind: "audio", container: "mp3", audioCodec: "mp3", duration: 30 };
    case "OGG":
      return { ...base, kind: "audio", container: "ogg", audioCodec: "vorbis", duration: 30 };
    default:
      return base;
  }
}

export interface FakeToolkit extends MediaToolkit {
  converted: string[];
}

export function fakeToolkit(): FakeToolkit {
  const converted: string[] = [];
  return {
    converted,
    async inspect(file) {
      return inspectionOf(readFileSync(file, "utf8"));
    },
    async convert(input, output, kind) {
      converted.push(kind);
      writeFileSync(output, `CONVERTED-${kind}:${readFileSync(input, "utf8")}`);
    },
  };
}

export function fakeWebSearch(hits: WebSearchHit[] = []): WebSearchBackend & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(query, limit) {
      queries.push(query);
      return hits.slice(0, limit);
    },
  };
}

export interface ResearchFixture {
  story: StoryFixture;
  net: FakeNet;
  toolkit: FakeToolkit;
  store: PolicyStore;
  fetcher: PolicyFetcher;
  service: ResearchService;
  web: ReturnType<typeof fakeWebSearch>;
  project: StoryFixture["project"];
  /** The files under assets/research/. */
  researchFiles(): string[];
  read(path: string): string;
  cleanup(): void;
}

export function createResearchFixture(
  options: { mode?: AssetSearchMode; dns?: Record<string, string>; hits?: WebSearchHit[] } = {},
): ResearchFixture {
  const story = createStoryFixture();
  const policyDir = mkdtempSync(join(tmpdir(), "openvids-research-policy-"));
  const store = new PolicyStore({ dir: policyDir });
  if (options.mode) store.setMode(options.mode);
  const net = new FakeNet();
  const toolkit = fakeToolkit();
  const web = fakeWebSearch(options.hits);
  const fetcher = new PolicyFetcher({
    transport: net.transport,
    guard: new UrlGuard(resolver(options.dns)),
  });
  const service = new ResearchService({
    story: story.service,
    store,
    fetcher,
    webSearch: web,
    toolkit,
  });
  return {
    story,
    net,
    toolkit,
    store,
    fetcher,
    service,
    web,
    project: story.project,
    researchFiles() {
      try {
        return readdirSync(join(story.project.dir, "assets/research")).sort();
      } catch {
        return [];
      }
    },
    read: (path) => readFileSync(join(story.project.dir, path), "utf8"),
    cleanup() {
      story.cleanup();
      rmSync(policyDir, { recursive: true, force: true });
    },
  };
}
