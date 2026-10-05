import {
  RESEARCH_LIMITS,
  RESEARCH_MEDIA_KINDS,
  WEBSITE_FILE_MODES,
  WEBSITE_LIMITS,
  isRecord,
  type AgentId,
  type SpecialistId,
  type WebsiteFileMode,
} from "@hyperframes/agent-protocol";
import type { HostTool, HostToolResult, ToolActivity } from "../backend.js";
import type { StoryTurnMode } from "../story/tools.js";

export const RESEARCH_TOOL_NAMES = {
  search: "search_assets",
  inspect: "inspect_url",
  import: "import_asset",
  resolve: "resolve_missing_asset",
  sources: "read_sources",
  website: "read_website",
  file: "get_website_file",
  record: "record_website",
} as const;

export type ResearchToolName = (typeof RESEARCH_TOOL_NAMES)[keyof typeof RESEARCH_TOOL_NAMES];

export function isResearchToolName(name: string): name is ResearchToolName {
  return Object.values<string>(RESEARCH_TOOL_NAMES).includes(name);
}

/**
 * The mode of a `get_website_file` call as the tool reads it: surrounding whitespace is ignored, anything but an
 * exact `save` or `read` is undefined. The one reading the executor and the save gates (`savesWebsiteFiles`) share,
 * so a padded `" save"` is a save for both.
 */
export function websiteFileMode(value: unknown): WebsiteFileMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return WEBSITE_FILE_MODES.find((mode) => mode === trimmed);
}

type Executor = (name: string, args: unknown, signal: AbortSignal) => Promise<HostToolResult>;

/** Which groups of research tools a turn offers. */
export interface ResearchAccess {
  assets: boolean;
  websites: boolean;
  /**
   * The user's policy currently allows full access to the linked sites. The tools are offered either way: a call
   * whose setting is off asks the user in chat. This only decides how their results talk about downloading.
   */
  websiteFiles: boolean;
}

/** Without a caller's access: the asset and website-reading groups, but not full website access. */
export const DEFAULT_RESEARCH_ACCESS: ResearchAccess = {
  assets: true,
  websites: true,
  websiteFiles: false,
};

/** Who may read a website the user linked: the Director, and the specialists that style or find material. */
const WEBSITE_READERS: readonly AgentId[] = ["director", "motion", "research"];

/**
 * Which research tools an agent gets. Research is the only specialist that can look outside the project for material:
 * it gets the search, page-reading, import and resolution tools. The Director can read the project's sources and
 * licenses (to answer and to brief Research) but never searches or imports itself; no other specialist and not Jev get
 * any. Without Research enabled in the chat nobody gets those tools, and a Story build or rebuild turn offers none.
 *
 * `read_website` (reading one site the user linked, for its style) is separate: the Director, Motion and Research get
 * it whether or not Research is enabled, because it does not search or import. The same agents also get
 * `get_website_file` and `record_website` whenever a research host exists: when the user's full access to linked
 * sites is off, calling one asks them in chat to allow it. `access` says which groups the turn offers: the asset
 * tools need the user's Asset Search policy to have been read, the website tools a research host. A specialist only
 * gets them when it is in the chat's team.
 */
export function researchToolsFor(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  turn: StoryTurnMode,
  access: ResearchAccess = DEFAULT_RESEARCH_ACCESS,
): ResearchToolName[] {
  if (turn.action === "build" || turn.action === "rebuild") return [];
  const {
    search,
    inspect,
    import: importAsset,
    resolve,
    sources,
    website,
    file,
    record,
  } = RESEARCH_TOOL_NAMES;
  const tools: ResearchToolName[] = [];
  if (access.assets && enabled.includes("research")) {
    if (agent === "research") tools.push(search, inspect, importAsset, resolve, sources);
    else if (agent === "director") tools.push(sources);
  }
  const reads =
    access.websites &&
    WEBSITE_READERS.includes(agent) &&
    (agent === "director" || enabled.some((specialist) => specialist === agent));
  if (reads) tools.push(website, file, record);
  return tools;
}

// ── Descriptions ─────────────────────────────────────────────────────────────

const POLICY_NOTE = `The user's Asset Search policy decides where you may look: in "trusted" mode only the enabled trusted sources listed in your task context, in "any" mode any public web page (trusted sources first). The Studio server enforces it on every call; a call the policy does not allow is refused (blocked_by_policy) and you cannot change the policy — do not look for a way around it.`;

const DESCRIPTIONS: Record<ResearchToolName, string> = {
  search_assets: `Search for video, picture or audio material outside the project. Returns candidates with an id, title, source, license (name, status clear/attribution/restricted/unknown and how confidently it was found), author, size and page URL, plus what each searched source answered, and what the policy blocked. The license facts come from the source itself — report them as given and never guess one. ${POLICY_NOTE} Search with short concrete words (the subject, in English too); use "sources" to narrow to source ids from your task context ("web" = the web search backend, available only in "any" mode).`,
  inspect_url: `Read one public web page or media URL and list the media it offers as importable candidates, with the page's own author and license information. Use it on a page a search pointed to, or a URL the user gave. Stream manifests (HLS/DASH) and protected media are not importable. ${POLICY_NOTE}`,
  import_asset: `Download a candidate (by the id from search_assets/inspect_url) — or a direct media URL — into the project under assets/research/ and record where it came from: URL, source, author and license are stored by the server from the source's own data, not from you. Converts the file for the editor when needed, and detects duplicates (an asset already in the project is reused, not downloaded again). Pass exactly one of "candidate" or "url". Pass "resolveMissing" (a Missing Asset node id from read_story) to resolve that node with the imported asset in the same step. Import only material that will actually be used. The import is part of this turn's checkpoint, so the user can revert it. ${POLICY_NOTE}`,
  resolve_missing_asset: `Resolve a Missing Asset node of the Story Graph with a media file that is already in the project (for example one imported earlier). The node becomes a video, picture or music node for that file and keeps its attachments. Refused for a locked node.`,
  read_website: `Open one website the user linked in this chat and extract its visual identity: palette with roles (background, surface, text, accent), fonts and how to load them, type scale, corner radii, shadows, button styles, design tokens, motion character (durations, easing), logo, headings and navigation labels — plus a 1440×900 and a full-page screenshot you can look at, and the list of files the page uses (resources: videos, images, SVG, Lottie/Rive animations, fonts, styles, scripts). Use it when the user links a site and asks for its style, brand or look. Only sites the user linked are allowed (the same site, including www. and subdomains, and any of its pages); for any other address the call is refused — ask the user for the link, never guess one. If reading linked pages is off, the call asks the user in chat to allow it and continues with their answer. With save: true the screenshots, the logo and the self-hosted fonts the page actually uses are saved under assets/web/<host>/ and recorded as website references with an unknown license; pass it when the result will be used in the video (not in a Plan or Ask turn).`,
  get_website_file: `Fetch one file of a website the user linked in this chat. If full access to linked sites is off, the call asks the user in chat to allow it and continues with their answer — just call it when the user wants a file from the site. mode "save" downloads the file into assets/web/<host>/files/ and records it as a website reference with an unknown license; mode "read" returns its raw text (page HTML, CSS, JS, JSON, SVG) and saves nothing. Allowed URLs: a file the linked site itself serves, or an exact URL an earlier read_website of it listed in its resources (its own CDN included) — anything else is refused, so read the site first and take the URL from its list. Use "read" to study how an animation really works (its CSS keyframes, JS easing, SVG/SMIL) before recreating it in GSAP; use "save" for material you will actually use: a video/audio/picture as a clip, a Lottie JSON with lottie-web (register the player as window.__hfLottie), a Rive file with its runtime, a font with @font-face. Website files are license unknown — never claim one, tell the user where it came from.`,
  record_website: `Record a page of a website the user linked in this chat as an MP4 video. If full access to linked sites is off, the call asks the user in chat to allow it and continues with their answer — just call it when the user wants a recording of the site. Real time, 1–30 seconds, optionally only one element (selector) and optionally scrolling the page; the file lands in assets/web/<host>/recordings/ as a video asset for edit_timeline. Use it to capture an animation that has no file to download (canvas, WebGL, CSS-only) so it can be cut into the video as footage; prefer get_website_file when the animation is a real Lottie/Rive/SVG/video file. The recording is a website reference with an unknown license — never claim one, tell the user it belongs to the site's owner.`,
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
  get_website_file: {
    type: "object",
    properties: {
      url: str(
        "The exact http(s) URL of a file of a site the user linked, or of a file an earlier read_website of it listed.",
        RESEARCH_LIMITS.urlChars,
      ),
      mode: {
        type: "string",
        enum: ["save", "read"],
        description:
          "save: download the file into assets/web/<host>/files/. read: return the file's raw text (page, CSS, JS, JSON, SVG); nothing is saved.",
      },
      pageUrl: str(
        "Optional: the page of the site where the file was found (recorded as its provenance page).",
        RESEARCH_LIMITS.urlChars,
      ),
    },
    required: ["url", "mode"],
    additionalProperties: false,
  },
  record_website: {
    type: "object",
    properties: {
      url: str(
        "The http(s) URL of a page of a site the user linked (the page to record).",
        RESEARCH_LIMITS.urlChars,
      ),
      seconds: {
        type: "integer",
        minimum: WEBSITE_LIMITS.recordMinSeconds,
        maximum: WEBSITE_LIMITS.recordMaxSeconds,
        description: `Recording length in seconds (real time), ${WEBSITE_LIMITS.recordMinSeconds}–${WEBSITE_LIMITS.recordMaxSeconds}.`,
      },
      selector: str(
        `CSS selector of the element to record (default: the whole viewport).`,
        WEBSITE_LIMITS.selectorChars,
      ),
      scroll: {
        type: "boolean",
        description: "Scroll smoothly from the top to the bottom of the page while recording.",
      },
      width: {
        type: "integer",
        minimum: 2,
        maximum: WEBSITE_LIMITS.recordMaxSide,
        description: `Viewport width in pixels (even, default 1920, max ${WEBSITE_LIMITS.recordMaxSide}).`,
      },
      height: {
        type: "integer",
        minimum: 2,
        maximum: WEBSITE_LIMITS.recordMaxSide,
        description: `Viewport height in pixels (even, default 1080, max ${WEBSITE_LIMITS.recordMaxSide}).`,
      },
    },
    required: ["url", "seconds"],
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
): ToolActivity {
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
      return host
        ? {
            category: "inspect",
            label: `Reading a web page · ${host}`,
            labelCode: "reading_web_page_host",
            labelParams: { host },
          }
        : { category: "inspect", label: "Reading a web page", labelCode: "reading_web_page" };
    }
    case "import_asset": {
      const known = context.candidate?.(text(record.candidate));
      if (known) {
        const title = shorten(known.title, 60);
        return {
          category: "edit",
          label: `Importing “${title}” · ${known.license}`,
          labelCode: "importing_candidate",
          labelParams: { title, license: known.license },
        };
      }
      const host = hostOf(text(record.url));
      return host
        ? {
            category: "edit",
            label: `Importing a file from ${host}`,
            labelCode: "importing_file_host",
            labelParams: { host },
          }
        : { category: "edit", label: "Importing an asset", labelCode: "importing_asset" };
    }
    case "resolve_missing_asset":
      return {
        category: "edit",
        label: "Resolving a missing asset",
        labelCode: "resolving_missing_asset",
      };
    case "read_sources":
      return {
        category: "inspect",
        label: "Reading project sources",
        labelCode: "reading_project_sources",
      };
    case "read_website": {
      const host = hostOf(text(record.url));
      return host
        ? {
            category: "inspect",
            label: `Reading ${host}`,
            labelCode: "reading_host",
            labelParams: { host },
          }
        : { category: "inspect", label: "Reading a website", labelCode: "reading_website" };
    }
    case "get_website_file": {
      const host = hostOf(text(record.url));
      const read = record.mode === "read";
      if (host) {
        return read
          ? {
              category: "inspect",
              label: `Reading a file from ${host}`,
              labelCode: "reading_site_file_host",
              labelParams: { host },
            }
          : {
              category: "edit",
              label: `Downloading a file from ${host}`,
              labelCode: "downloading_site_file_host",
              labelParams: { host },
            };
      }
      return read
        ? { category: "inspect", label: "Reading a site file", labelCode: "reading_site_file" }
        : {
            category: "edit",
            label: "Downloading a site file",
            labelCode: "downloading_site_file",
          };
    }
    case "record_website": {
      const host = hostOf(text(record.url));
      return host
        ? {
            category: "edit",
            label: `Recording ${host}`,
            labelCode: "recording_host",
            labelParams: { host },
          }
        : { category: "edit", label: "Recording a web page", labelCode: "recording_website" };
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
