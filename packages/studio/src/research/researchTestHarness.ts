import { vi } from "vitest";
import {
  LICENSE_STATUSES,
  type AssetSearchPolicy,
  type LicenseStatus,
  type ProjectSourceEntry,
  type ProjectSourcesView,
  type TrustedSource,
} from "@hyperframes/agent-protocol";

export function sourceEntry(overrides: Partial<ProjectSourceEntry> = {}): ProjectSourceEntry {
  return {
    id: "prov-1",
    asset: "assets/research/ocean.mp4",
    mediaKind: "video",
    title: "Ocean waves",
    originalUrl: "https://upload.wikimedia.org/ocean.webm",
    pageUrl: "https://commons.wikimedia.org/wiki/File:Ocean.webm",
    source: { id: "wikimedia-commons", name: "Wikimedia Commons", trusted: true },
    author: "Jane Doe",
    authorUrl: "https://commons.wikimedia.org/wiki/User:Jane",
    license: "CC BY 4.0",
    licenseId: "cc_by",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    licenseConfidence: "high",
    licenseStatus: "attribution",
    licenseBasis: "Wikimedia Commons API (LicenseShortName)",
    attribution: "“Ocean waves” by Jane Doe, CC BY 4.0, via Wikimedia Commons",
    retrievedAt: Date.UTC(2026, 8, 30),
    retrievedBy: { agent: "research", turnId: "t1", model: "claude-haiku" },
    policyMode: "trusted",
    sha256: "sha256:aa",
    originalSha256: "sha256:bb",
    bytes: 1000,
    contentType: "video/mp4",
    converted: null,
    storyNode: "m1",
    need: "Waves at dusk",
    present: true,
    usedIn: ["index.html"],
    issues: [],
    ...overrides,
  };
}

/** A view whose summary and credits follow its records, the way the server computes them. */
export function sourcesView(records: ProjectSourceEntry[]): ProjectSourcesView {
  const counts: Record<LicenseStatus, number> = {
    clear: 0,
    attribution: 0,
    restricted: 0,
    unknown: 0,
  };
  for (const status of LICENSE_STATUSES) {
    counts[status] = records.filter((record) => record.licenseStatus === status).length;
  }
  return {
    records,
    summary: {
      ...counts,
      total: records.length,
      missingFiles: records.filter((record) => !record.present).length,
    },
    credits: records
      .filter((record) => record.present && record.licenseStatus !== "clear")
      .map((record) => record.attribution),
    mode: "trusted",
  };
}

export function trustedSource(overrides: Partial<TrustedSource> = {}): TrustedSource {
  return {
    id: "wikimedia-commons",
    name: "Wikimedia Commons",
    builtIn: true,
    enabled: true,
    connector: "wikimedia_commons",
    domains: ["wikimedia.org"],
    kinds: ["video", "picture", "audio"],
    description: "Free media repository.",
    licenseNote: "Every file states its license.",
    homepage: "https://commons.wikimedia.org",
    ...overrides,
    apiKey: overrides.apiKey ?? null,
  };
}

export function policyFixture(overrides: Partial<AssetSearchPolicy> = {}): AssetSearchPolicy {
  return {
    mode: "trusted",
    sources: [trustedSource()],
    removedBuiltIns: [],
    websites: { readLinkedPages: true, fullAccess: false },
    updatedAt: 1000,
    ...overrides,
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

/** A non-200 answer of a fake route. */
export class HttpReply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

/**
 * A `fetch` that answers from a route table (`"GET /api/research/policy": (body) => answer`, an `HttpReply` for a
 * failure), records every request, and answers anything else with a 404.
 */
export function researchFetch(routes: Record<string, (body: unknown) => unknown>): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });
    const route = routes[`${method} ${url.split("?")[0]}`];
    const answer = route ? route(body) : new HttpReply(404, { error: { message: "Not found" } });
    const reply = answer instanceof HttpReply ? answer : new HttpReply(200, answer);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetch: fetchImpl, requests };
}
