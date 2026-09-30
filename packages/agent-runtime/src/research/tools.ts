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
} as const;

export type ResearchToolName = (typeof RESEARCH_TOOL_NAMES)[keyof typeof RESEARCH_TOOL_NAMES];

export function isResearchToolName(name: string): name is ResearchToolName {
  return Object.values<string>(RESEARCH_TOOL_NAMES).includes(name);
}

type Executor = (name: string, args: unknown, signal: AbortSignal) => Promise<HostToolResult>;

/**
 * Which research tools an agent gets. Research is the only specialist that can look outside the project: it gets the
 * search, page-reading, import and resolution tools. The Director can read the project's sources and licenses (to
 * answer and to brief Research) but never searches or imports itself; no other specialist and not Jev get any. Without
 * Research enabled in the chat nobody gets a research tool, and a Story build or rebuild turn offers none.
 */
export function researchToolsFor(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  turn: StoryTurnMode,
): ResearchToolName[] {
  if (!enabled.includes("research")) return [];
  if (turn.action === "build" || turn.action === "rebuild") return [];
  const { search, inspect, import: importAsset, resolve, sources } = RESEARCH_TOOL_NAMES;
  if (agent === "research") return [search, inspect, importAsset, resolve, sources];
  if (agent === "director") return [sources];
  return [];
}

// ── Descriptions ─────────────────────────────────────────────────────────────

const POLICY_NOTE = `The user's Asset Search policy decides where you may look: in "trusted" mode only the enabled trusted sources listed in your task context, in "any" mode any public web page (trusted sources first). The Studio server enforces it on every call; a call the policy does not allow is refused (blocked_by_policy) and you cannot change the policy — do not look for a way around it.`;

const DESCRIPTIONS: Record<ResearchToolName, string> = {
  search_assets: `Search for video, picture or audio material outside the project. Returns candidates with an id, title, source, license (name, status clear/attribution/restricted/unknown and how confidently it was found), author, size and page URL, plus what each searched source answered, and what the policy blocked. The license facts come from the source itself — report them as given and never guess one. ${POLICY_NOTE} Search with short concrete words (the subject, in English too); use "sources" to narrow to source ids from your task context ("web" = the web search backend, available only in "any" mode).`,
  inspect_url: `Read one public web page or media URL and list the media it offers as importable candidates, with the page's own author and license information. Use it on a page a search pointed to, or a URL the user gave. Stream manifests (HLS/DASH) and protected media are not importable. ${POLICY_NOTE}`,
  import_asset: `Download a candidate (by the id from search_assets/inspect_url) — or a direct media URL — into the project under assets/research/ and record where it came from: URL, source, author and license are stored by the server from the source's own data, not from you. Converts the file for the editor when needed, and detects duplicates (an asset already in the project is reused, not downloaded again). Pass exactly one of "candidate" or "url". Pass "resolveMissing" (a Missing Asset node id from read_story) to resolve that node with the imported asset in the same step. Import only material that will actually be used. The import is part of this turn's checkpoint, so the user can revert it. ${POLICY_NOTE}`,
  resolve_missing_asset: `Resolve a Missing Asset node of the Story Graph with a media file that is already in the project (for example one imported earlier). The node becomes a video, picture or music node for that file and keeps its attachments. Refused for a locked node.`,
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
        description: "Results per source (default 6).",
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
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const shorten = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;

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
  return researchToolsFor(agent, enabled, turn).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: PARAMETERS[name],
    execute: (args, signal) => execute(name, args, signal),
    activity: (args) => activity(name, args, context),
  }));
}
