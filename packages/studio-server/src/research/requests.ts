import {
  ASSET_SEARCH_MODES,
  RESEARCH_LIMITS,
  RESEARCH_MEDIA_KINDS,
  WEBSITE_FILE_MODES,
  WEBSITE_GRANT_ACCESS,
  WEBSITE_LIMITS,
  MAX_ALLOWED_SITES,
  isRecord,
  type AddTrustedSourceRequest,
  type AgentId,
  type AssetSearchMode,
  type AssetSearchRequest,
  type ImportAssetRequest,
  type InspectUrlRequest,
  type RecordWebsiteRequest,
  type ResearchMediaKind,
  type ResolveMissingRequest,
  type ReadWebsiteRequest,
  type UpdateAssetSearchPolicyRequest,
  type UpdateTrustedSourceRequest,
  type WebsiteFileRequest,
  type WebsiteGrantRequest,
} from "@hyperframes/agent-protocol";
import { agentIdOf } from "./agents.js";
import { ResearchFailure } from "./errors.js";

const ID_CHARS = 128;

function body(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(raw))
    throw new ResearchFailure("invalid_request", "The request body must be a JSON object");
  const extra = Object.keys(raw).find((key) => !allowed.includes(key));
  if (extra) throw new ResearchFailure("invalid_request", `Unknown field "${extra}"`);
  return raw;
}

function text(value: unknown, field: string, max: number, empty = false): string {
  if (typeof value !== "string")
    throw new ResearchFailure("invalid_request", `${field} must be text`);
  const trimmed = value.trim();
  if (!empty && trimmed === "")
    throw new ResearchFailure("invalid_request", `${field} must not be empty`);
  if (trimmed.length > max)
    throw new ResearchFailure("invalid_request", `${field} exceeds ${max} characters`);
  return trimmed;
}

function kind(value: unknown, field: string): ResearchMediaKind {
  const found = RESEARCH_MEDIA_KINDS.find((entry) => entry === value);
  if (found === undefined) {
    throw new ResearchFailure(
      "invalid_request",
      `${field} must be one of ${RESEARCH_MEDIA_KINDS.join(", ")}`,
    );
  }
  return found;
}

export function parsePolicyUpdate(raw: unknown): UpdateAssetSearchPolicyRequest {
  const value = body(raw, ["mode", "websites"]);
  if (value.mode === undefined && value.websites === undefined) {
    throw new ResearchFailure("invalid_request", "Give mode or websites");
  }
  const request: UpdateAssetSearchPolicyRequest = {};
  if (value.mode !== undefined) {
    const mode: AssetSearchMode | undefined = ASSET_SEARCH_MODES.find(
      (entry) => entry === value.mode,
    );
    if (mode === undefined) {
      throw new ResearchFailure(
        "invalid_request",
        `mode must be ${ASSET_SEARCH_MODES.join(" or ")}`,
      );
    }
    request.mode = mode;
  }
  if (value.websites !== undefined) {
    const websites = body(value.websites, ["readLinkedPages", "fullAccess"]);
    if (websites.readLinkedPages === undefined && websites.fullAccess === undefined) {
      throw new ResearchFailure("invalid_request", "websites needs readLinkedPages or fullAccess");
    }
    if (websites.readLinkedPages !== undefined && typeof websites.readLinkedPages !== "boolean") {
      throw new ResearchFailure("invalid_request", "readLinkedPages must be true or false");
    }
    if (websites.fullAccess !== undefined && typeof websites.fullAccess !== "boolean") {
      throw new ResearchFailure("invalid_request", "fullAccess must be true or false");
    }
    request.websites = {
      ...(typeof websites.readLinkedPages === "boolean" && {
        readLinkedPages: websites.readLinkedPages,
      }),
      ...(typeof websites.fullAccess === "boolean" && { fullAccess: websites.fullAccess }),
    };
  }
  return request;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value))
    throw new ResearchFailure("invalid_request", `${field} must be a list`);
  return value.map((entry) => text(entry, field, RESEARCH_LIMITS.urlChars));
}

function kindList(value: unknown): ResearchMediaKind[] {
  if (!Array.isArray(value)) throw new ResearchFailure("invalid_request", "kinds must be a list");
  return value.map((entry) => kind(entry, "kinds"));
}

export function parseAddSource(raw: unknown): AddTrustedSourceRequest {
  const value = body(raw, ["name", "domains", "kinds", "homepage", "licenseNote"]);
  return {
    name: text(value.name, "name", RESEARCH_LIMITS.nameChars),
    domains: stringList(value.domains, "domains"),
    ...(value.kinds !== undefined && { kinds: kindList(value.kinds) }),
    ...(value.homepage !== undefined && {
      homepage:
        value.homepage === null ? null : text(value.homepage, "homepage", RESEARCH_LIMITS.urlChars),
    }),
    ...(value.licenseNote !== undefined && {
      licenseNote: text(value.licenseNote, "licenseNote", RESEARCH_LIMITS.noteChars, true),
    }),
  };
}

export function parseUpdateSource(raw: unknown): UpdateTrustedSourceRequest {
  const value = body(raw, ["enabled", "name", "domains", "kinds", "licenseNote"]);
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new ResearchFailure("invalid_request", "enabled must be true or false");
  }
  return {
    ...(typeof value.enabled === "boolean" && { enabled: value.enabled }),
    ...(value.name !== undefined && { name: text(value.name, "name", RESEARCH_LIMITS.nameChars) }),
    ...(value.domains !== undefined && { domains: stringList(value.domains, "domains") }),
    ...(value.kinds !== undefined && { kinds: kindList(value.kinds) }),
    ...(value.licenseNote !== undefined && {
      licenseNote: text(value.licenseNote, "licenseNote", RESEARCH_LIMITS.noteChars, true),
    }),
  };
}

export function parseSearchRequest(raw: unknown): AssetSearchRequest {
  const value = body(raw, ["query", "mediaKind", "sources", "limit"]);
  let limit: number | undefined;
  if (value.limit !== undefined) {
    if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1) {
      throw new ResearchFailure("invalid_request", "limit must be a whole number from 1");
    }
    limit = Math.min(value.limit, RESEARCH_LIMITS.searchResults);
  }
  return {
    query: text(value.query, "query", RESEARCH_LIMITS.queryChars),
    mediaKind: kind(value.mediaKind, "mediaKind"),
    ...(value.sources !== undefined && {
      sources: stringList(value.sources, "sources").map((source) => source.slice(0, ID_CHARS)),
    }),
    ...(limit !== undefined && { limit }),
  };
}

export function parseInspectRequest(raw: unknown): InspectUrlRequest {
  const value = body(raw, ["url", "mediaKind"]);
  return {
    url: text(value.url, "url", RESEARCH_LIMITS.urlChars),
    ...(value.mediaKind !== undefined && { mediaKind: kind(value.mediaKind, "mediaKind") }),
  };
}

function agentOf(value: unknown): AgentId | "user" {
  const agent = agentIdOf(value);
  if (agent === null)
    throw new ResearchFailure("invalid_request", "agent must be an agent id or user");
  return agent;
}

export function parseImportRequest(raw: unknown): ImportAssetRequest {
  const value = body(raw, [
    "candidate",
    "url",
    "name",
    "resolveMissing",
    "turnId",
    "agent",
    "model",
    "requestId",
  ]);
  if ((value.candidate === undefined) === (value.url === undefined)) {
    throw new ResearchFailure("invalid_request", "Give exactly one of candidate or url");
  }
  return {
    ...(value.candidate !== undefined && {
      candidate: text(value.candidate, "candidate", ID_CHARS),
    }),
    ...(value.url !== undefined && { url: text(value.url, "url", RESEARCH_LIMITS.urlChars) }),
    ...(value.name !== undefined && {
      name: text(value.name, "name", RESEARCH_LIMITS.fileNameChars),
    }),
    ...(value.resolveMissing !== undefined && {
      resolveMissing: text(value.resolveMissing, "resolveMissing", ID_CHARS),
    }),
    ...(value.turnId !== undefined && { turnId: text(value.turnId, "turnId", ID_CHARS * 2) }),
    ...(value.agent !== undefined && { agent: agentOf(value.agent) }),
    ...(value.model !== undefined && {
      model: value.model === null ? null : text(value.model, "model", 200),
    }),
    ...(value.requestId !== undefined && {
      requestId: text(value.requestId, "requestId", ID_CHARS),
    }),
  };
}

/** The runtime's `allowedSites`: registrable domains, lower case, at most {@link MAX_ALLOWED_SITES}. */
function allowedSitesOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ALLOWED_SITES) {
    throw new ResearchFailure(
      "invalid_request",
      `allowedSites must be a list of at most ${MAX_ALLOWED_SITES} domains`,
    );
  }
  return value.map((entry): string => {
    const site = text(entry, "allowedSites", 253).toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) {
      throw new ResearchFailure("invalid_request", `allowedSites has "${site}", not a domain`);
    }
    return site;
  });
}

export function parseResolveRequest(raw: unknown): ResolveMissingRequest {
  const value = body(raw, ["missing", "asset", "title", "turnId", "requestId"]);
  return {
    missing: text(value.missing, "missing", ID_CHARS),
    asset: text(value.asset, "asset", RESEARCH_LIMITS.urlChars),
    ...(value.title !== undefined && { title: text(value.title, "title", 120) }),
    ...(value.turnId !== undefined && { turnId: text(value.turnId, "turnId", ID_CHARS * 2) }),
    ...(value.requestId !== undefined && {
      requestId: text(value.requestId, "requestId", ID_CHARS),
    }),
  };
}

export function parseWebsiteRequest(raw: unknown): ReadWebsiteRequest {
  const value = body(raw, ["url", "save", "requestId", "allowedSites", "turnId", "agent", "model"]);
  if (value.save !== undefined && typeof value.save !== "boolean") {
    throw new ResearchFailure("invalid_request", "save must be true or false");
  }
  return {
    url: text(value.url, "url", RESEARCH_LIMITS.urlChars),
    ...(value.save !== undefined && { save: value.save }),
    ...(value.requestId !== undefined && {
      requestId: text(value.requestId, "requestId", ID_CHARS),
    }),
    ...(value.allowedSites !== undefined && { allowedSites: allowedSitesOf(value.allowedSites) }),
    ...(value.turnId !== undefined && { turnId: text(value.turnId, "turnId", ID_CHARS * 2) }),
    ...(value.agent !== undefined && { agent: agentOf(value.agent) }),
    ...(value.model !== undefined && {
      model: value.model === null ? null : text(value.model, "model", 200),
    }),
  };
}

/** The `:requestId` of the cancel route. */
export function parseRequestId(raw: string | undefined): string {
  return text(raw, "requestId", ID_CHARS);
}

/** A turn id set by the runtime, wherever it appears (a route parameter or a request body). */
export function parseTurnId(raw: unknown): string {
  return text(raw, "turnId", ID_CHARS * 2);
}

/** `POST /api/projects/:id/research/website/grants`: the user allowed a Websites setting once for this turn. */
export function parseWebsiteGrantRequest(raw: unknown): WebsiteGrantRequest {
  const value = body(raw, ["turnId", "access"]);
  const access = WEBSITE_GRANT_ACCESS.find((entry) => entry === value.access);
  if (access === undefined) {
    throw new ResearchFailure(
      "invalid_request",
      `access must be ${WEBSITE_GRANT_ACCESS.join(" or ")}`,
    );
  }
  return { turnId: parseTurnId(value.turnId), access };
}

/** `POST /api/projects/:id/research/website/file` (full access): save a file, or read its text. */
export function parseWebsiteFileRequest(raw: unknown): WebsiteFileRequest {
  const value = body(raw, [
    "url",
    "mode",
    "pageUrl",
    "requestId",
    "allowedSites",
    "turnId",
    "agent",
    "model",
  ]);
  const mode = WEBSITE_FILE_MODES.find((entry) => entry === value.mode);
  if (mode === undefined) {
    throw new ResearchFailure("invalid_request", `mode must be ${WEBSITE_FILE_MODES.join(" or ")}`);
  }
  return {
    url: text(value.url, "url", RESEARCH_LIMITS.urlChars),
    mode,
    ...(value.pageUrl !== undefined && {
      pageUrl: text(value.pageUrl, "pageUrl", RESEARCH_LIMITS.urlChars),
    }),
    ...(value.requestId !== undefined && {
      requestId: text(value.requestId, "requestId", ID_CHARS),
    }),
    ...(value.allowedSites !== undefined && { allowedSites: allowedSitesOf(value.allowedSites) }),
    ...(value.turnId !== undefined && { turnId: text(value.turnId, "turnId", ID_CHARS * 2) }),
    ...(value.agent !== undefined && { agent: agentOf(value.agent) }),
    ...(value.model !== undefined && {
      model: value.model === null ? null : text(value.model, "model", 200),
    }),
  };
}

/** `POST /api/projects/:id/research/website/record` (full access): record a page as an MP4. */
export function parseRecordWebsiteRequest(raw: unknown): RecordWebsiteRequest {
  const value = body(raw, [
    "url",
    "seconds",
    "selector",
    "scroll",
    "width",
    "height",
    "requestId",
    "allowedSites",
    "turnId",
    "agent",
    "model",
  ]);
  const seconds = value.seconds;
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds < WEBSITE_LIMITS.recordMinSeconds ||
    seconds > WEBSITE_LIMITS.recordMaxSeconds
  ) {
    throw new ResearchFailure(
      "invalid_request",
      `seconds must be between ${WEBSITE_LIMITS.recordMinSeconds} and ${WEBSITE_LIMITS.recordMaxSeconds}`,
    );
  }
  if (value.scroll !== undefined && typeof value.scroll !== "boolean") {
    throw new ResearchFailure("invalid_request", "scroll must be true or false");
  }
  const side = (field: "width" | "height"): number | undefined => {
    const rawSide = value[field];
    if (rawSide === undefined) return undefined;
    if (
      typeof rawSide !== "number" ||
      !Number.isInteger(rawSide) ||
      rawSide < 2 ||
      rawSide > WEBSITE_LIMITS.recordMaxSide
    ) {
      throw new ResearchFailure(
        "invalid_request",
        `${field} must be a whole number from 2 to ${WEBSITE_LIMITS.recordMaxSide}`,
      );
    }
    return rawSide;
  };
  const width = side("width");
  const height = side("height");
  return {
    url: text(value.url, "url", RESEARCH_LIMITS.urlChars),
    seconds,
    ...(value.selector !== undefined && {
      selector: text(value.selector, "selector", WEBSITE_LIMITS.selectorChars),
    }),
    ...(value.scroll !== undefined && { scroll: value.scroll }),
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
    ...(value.requestId !== undefined && {
      requestId: text(value.requestId, "requestId", ID_CHARS),
    }),
    ...(value.allowedSites !== undefined && { allowedSites: allowedSitesOf(value.allowedSites) }),
    ...(value.turnId !== undefined && { turnId: text(value.turnId, "turnId", ID_CHARS * 2) }),
    ...(value.agent !== undefined && { agent: agentOf(value.agent) }),
    ...(value.model !== undefined && {
      model: value.model === null ? null : text(value.model, "model", 200),
    }),
  };
}
