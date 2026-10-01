import {
  RESEARCH_LIMITS,
  RESEARCH_MEDIA_KINDS,
  isRecord,
  type AgentId,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import type { BackendToolKind, HostTool, HostToolResult } from "../backend.js";
import type { StoryTurnMode } from "../story/tools.js";

export const RESEARCH_TOOL_NAMES = {
  search: "search_assets",
  inspect: "inspect_url",
  import: "import_asset",
  resolve: "resolve_missing_asset",
  sources: "read_sources",
  website: "read_website",
} as const;

export type ResearchToolName = (typeof RESEARCH_TOOL_NAMES)[keyof typeof RESEARCH_TOOL_NAMES];

export function isResearchToolName(name: string): name is ResearchToolName {
  return Object.values<string>(RESEARCH_TOOL_NAMES).includes(name);
}

type Executor = (name: string, args: unknown, signal: AbortSignal) => Promise<HostToolResult>;

/** Which groups of research tools a turn offers. */
export interface ResearchAccess {
  assets: boolean;
  websites: boolean;
}

/** Who may read a website the user linked: the Director, and the specialists that style or find material. */
const WEBSITE_READERS: readonly AgentId[] = ["director", "motion", "research"];

/**
 * Which research tools an agent gets. Research is the only specialist that can look outside the project for material:
 * it gets the search, page-reading, import and resolution tools. The Director can read the project's sources and
 * licenses (to answer and to brief Research) but never searches or imports itself; no other specialist and not Jev get
 * any. Without Research enabled in the chat nobody gets those tools, and a Story build or rebuild turn offers none.
 *
 * `read_website` (reading one site the user linked, for its style) is separate: the Director, Motion and Research get
 * it whether or not Research is enabled, because it does not search or import. `access` says which groups the turn
 * offers: the asset tools need the user's Asset Search policy to have been read, the website tool a research host.
 * A specialist only gets it when it is in the chat's team.
 */
export function researchToolsFor(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  turn: StoryTurnMode,
  access: ResearchAccess = { assets: true, websites: true },
): ResearchToolName[] {
  if (turn.action === "build" || turn.action === "rebuild") return [];
  const { search, inspect, import: importAsset, resolve, sources, website } = RESEARCH_TOOL_NAMES;
  const tools: ResearchToolName[] = [];
  if (access.assets && enabled.includes("research")) {
    if (agent === "research") tools.push(search, inspect, importAsset, resolve, sources);
    else if (agent === "director") tools.push(sources);
  }
  const reads =
    access.websites &&
    WEBSITE_READERS.includes(agent) &&
    (agent === "director" || enabled.some((specialist) => specialist === agent));
  if (reads) tools.push(website);
  return tools;
}

// ── Descriptions ─────────────────────────────────────────────────────────────

const POLICY_NOTE = `The user's Asset Search policy decides where you may look: in "trusted" mode only the enabled trusted sources listed in your task context, in "any" mode any public web page (trusted sources first). The Studio server enforces it on every call; a call the policy does not allow is refused (blocked_by_policy) and you cannot change the policy — do not look for a way around it.`;

const DESCRIPTIONS: Record<ResearchToolName, string> = {
  search_assets: `Search for video, picture or audio material outside the project. Returns candidates with an id, title, source, license (name, status clear/attribution/restricted/unknown and how confidently it was found), author, size and page URL, plus what each searched source answered, and what the policy blocked. The license facts come from the source itself — report them as given and never guess one. ${POLICY_NOTE} Search with short concrete words (the subject, in English too); use "sources" to narrow to source ids from your task context ("web" = the web search backend, available only in "any" mode).`,
  inspect_url: `Read one public web page or media URL and list the media it offers as importable candidates, with the page's own author and license information. Use it on a page a search pointed to, or a URL the user gave. Stream manifests (HLS/DASH) and protected media are not importable. ${POLICY_NOTE}`,
  import_asset: `Download a candidate (by the id from search_assets/inspect_url) — or a direct media URL — into the project under assets/research/ and record where it came from: URL, source, author and license are stored by the server from the source's own data, not from you. Converts the file for the editor when needed, and detects duplicates (an asset already in the project is reused, not downloaded again). Pass exactly one of "candidate" or "url". Pass "resolveMissing" (a Missing Asset node id from read_story) to resolve that node with the imported asset in the same step. Import only material that will actually be used. The import is part of this turn's checkpoint, so the user can revert it. ${POLICY_NOTE}`,
  resolve_missing_asset: `Resolve a Missing Asset node of the Story Graph with a media file that is already in the project (for example one imported earlier). The node becomes a video, picture or music node for that file and keeps its attachments. Refused for a locked node.`,
  read_website: `Open one website the user linked in this chat and extract its visual identity: palette with roles (background, surface, text, accent), fonts and how to load them, type scale, corner radii, shadows, button styles, design tokens, motion character (durations, easing), logo, headings and navigation labels — plus a 1440×900 and a full-page screenshot you can look at. Use it when the user links a site and asks for its style, brand or look. Only sites the user linked are allowed (the same site, including www. and subdomains, and any of its pages); for any other address the call is refused — ask the user for the link, never guess one. With save: true the screenshots, the logo and the self-hosted fonts the page actually uses are saved under assets/web/<host>/ and recorded as website references with an unknown license; pass it when the result will be used in the video (not in a Plan or Ask turn). The user can switch website reading off in Settings → Asset Search → Websites; then the call fails and you cannot change that.`,
  read_sources: `Read the project's Sources and Licenses: every imported asset with its source, author, license (status and confidence), where the file is used and what needs the user's attention, plus the credit lines the project owes.`,
};

// ── Schemas ──────────────────────────────────────────────────────────────────

const str = (description: string, maxLength?: number) => ({
  type: "string",
  description,
  ...(maxLength !== undefined && { maxLength }),
});

const mediaKind = {
  type: "string",
  enum: [...RESEARCH_MEDIA_KINDS],
  description: "video, picture or audio (music and sound effects are audio).",
};

const PARAMETERS: Record<ResearchToolName, Record<string, unknown>> = {
  search_assets: {
    type: "object",
    properties: {
      query: str("What to look for, in a few concrete words.", RESEARCH_LIMITS.queryChars),
      mediaKind,
      sources: {
        type: "array",
        maxItems: RESEARCH_LIMITS.sources,
        description: "Only these source ids (from the task context; 'web' = the web backend).",
        items: str("Source id.", 80),
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: RESEARCH_LIMITS.searchResults,
        description:
          "Results per source. The turn's Execution Quality sets the default and the maximum; a larger value is reduced to it.",
      },
    },
    required: ["query", "mediaKind"],
    additionalProperties: false,
  },
  inspect_url: {
    type: "object",
    properties: {
      url: str("The http(s) URL of a page or a media file.", RESEARCH_LIMITS.urlChars),
      mediaKind,
    },
    required: ["url"],
    additionalProperties: false,
  },
  import_asset: {
    type: "object",
    properties: {
      candidate: str("Candidate id from search_assets or inspect_url.", 120),
      url: str("A direct media URL (or a page with one main media), instead of a candidate."),
      name: str(
        "File name without extension (default: from the title).",
        RESEARCH_LIMITS.fileNameChars,
      ),
      resolveMissing: str(
        "Missing Asset node id (from read_story) to resolve with this asset.",
        66,
      ),
    },
    additionalProperties: false,
  },
  resolve_missing_asset: {
    type: "object",
    properties: {
      missing: str("Missing Asset node id from read_story.", 66),
      asset: str("Project-relative path of the media file.", 1_024),
    },
    required: ["missing", "asset"],
    additionalProperties: false,
  },
  read_sources: { type: "object", properties: {}, additionalProperties: false },
  read_website: {
    type: "object",
    properties: {
      url: str("The http(s) URL of a page of a site the user linked.", RESEARCH_LIMITS.urlChars),
      save: {
        type: "boolean",
        description:
          "Save the screenshots, logo and self-hosted fonts into assets/web/<host>/ (default false: read only).",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

// ── Activity rows ────────────────────────────────────────────────────────────

/** What the turn already knows about a candidate, so an import row can name what is being imported. */
export interface KnownCandidate {
  title: string;
  license: string;
}

export interface ResearchToolContext {
  /** Looks up a candidate from an earlier search or page read of this turn. */
  candidate?: (id: string) => KnownCandidate | undefined;
  /** The display name of a trusted source in the user's policy. */
  sourceName?: (id: string) => string | undefined;
  /** The turn's budget of candidates per search: the default `limit` of search_assets and its maximum. */
  candidateLimit?: number;
  /** Which groups are offered (default both). */
  access?: ResearchAccess;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const shorten = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;

/** The arguments of a search with `limit` defaulted to the budget and never above it (other values are left for the executor to judge). */
function clampSearchLimit(args: unknown, budget: number): unknown {
  if (!isRecord(args)) return args;
  const { limit } = args;
  if (limit === undefined || limit === null) return { ...args, limit: budget };
  if (typeof limit === "number" && limit > budget) return { ...args, limit: budget };
  return args;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function activity(
  name: ResearchToolName,
  args: unknown,
  context: ResearchToolContext,
): { category: BackendToolKind; label: string } {
  const record = isRecord(args) ? args : {};
  switch (name) {
    case "search_assets": {
      const query = shorten(text(record.query), 60);
      const kind = text(record.mediaKind);
      const sources = Array.isArray(record.sources) ? record.sources : [];
      const only = sources.length === 1 && typeof sources[0] === "string" ? sources[0] : null;
      const named = only ? context.sourceName?.(only) : undefined;
      if (named) {
        return { category: "search", label: `Searching ${named}…${query ? ` · ${query}` : ""}` };
      }
      const where = only === "web" ? "the web" : "sources";
      return {
        category: "search",
        label: `Searching ${where}${query ? ` · ${query}${kind ? ` (${kind})` : ""}` : ""}`,
      };
    }
    case "inspect_url": {
      const host = hostOf(text(record.url));
      return {
        category: "inspect",
        label: host ? `Reading a web page · ${host}` : "Reading a web page",
      };
    }
    case "import_asset": {
      const known = context.candidate?.(text(record.candidate));
      if (known) {
        return {
          category: "edit",
          label: `Importing “${shorten(known.title, 60)}” · ${known.license}`,
        };
      }
      const host = hostOf(text(record.url));
      return {
        category: "edit",
        label: host ? `Importing a file from ${host}` : "Importing an asset",
      };
    }
    case "resolve_missing_asset":
      return { category: "edit", label: "Resolving a missing asset" };
    case "read_sources":
      return { category: "inspect", label: "Reading project sources" };
    case "read_website": {
      const host = hostOf(text(record.url));
      return { category: "inspect", label: host ? `Reading ${host}` : "Reading a website" };
    }
  }
}

/** The research tools of one agent; every call goes to `execute` (the running turn's research executor). */
export function buildResearchTools(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  turn: StoryTurnMode,
  execute: Executor,
  context: ResearchToolContext = {},
): HostTool[] {
  return researchToolsFor(agent, enabled, turn, context.access).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: PARAMETERS[name],
    execute: (args, signal) =>
      execute(
        name,
        name === "search_assets" && context.candidateLimit !== undefined
          ? clampSearchLimit(args, context.candidateLimit)
          : args,
        signal,
      ),
    activity: (args) => activity(name, args, context),
  }));
}
