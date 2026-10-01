import {
  RESEARCH_LIMITS,
  RESEARCH_MEDIA_KINDS,
  isRecord,
  type AgentId,
  type AssetCandidate,
  type AssetSearchPolicy,
  type AssetSearchRequest,
  type ChatIntent,
  type ImportAssetRequest,
  type InspectUrlRequest,
  type ReadWebsiteRequest,
  type ResearchMediaKind,
  type SpecialistId,
  type StoryActionOptions,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { errorMessage } from "../errors.js";
import type { StoryTurnMode } from "../story/tools.js";
import {
  formatImport,
  formatInspect,
  formatResearchError,
  formatResolve,
  formatSearch,
  formatSources,
} from "./format.js";
import { formatWebsite } from "./formatWebsite.js";
import { ResearchToolError, type ResearchHost } from "./host.js";
import { isLinkedSite, linkedSites } from "./linkedSites.js";
import {
  RESEARCH_TOOL_NAMES,
  isResearchToolName,
  researchToolsFor,
  type KnownCandidate,
  type ResearchToolName,
} from "./tools.js";

export interface TurnResearchOptions {
  host: ResearchHost;
  /** The running turn: stamped on every import so the server attributes the asset to it (and Revert undoes it). */
  turnId: string;
  /** The turn's abort signal: aborting the turn aborts every in-flight call. */
  turnSignal: AbortSignal;
  /** The chat's enabled specialists and the turn's mode: who may call what is decided here, not by the model. */
  enabled: readonly SpecialistId[];
  turn: StoryTurnMode;
  /** The user's choices for a `resolve` turn: the Missing Asset nodes the turn may resolve. */
  storyOptions: StoryActionOptions | null;
  /** What the user wants from the turn: a Plan or Ask turn never saves a website's files into the project. */
  intent: ChatIntent;
  /**
   * What the user wrote in this chat so far: the first prompt, later messages and steering — never assistant text,
   * search results or page contents. The websites linked in it are the only ones `read_website` may open.
   */
  userTexts: () => readonly string[];
  /** The model the Research run uses (`provider/modelId`), recorded in the provenance. */
  model: () => string | null;
}

const refuse = (text: string): HostToolResult => ({ text, isError: true });

const invalid = (message: string) => new ResearchToolError("invalid_request", message);

function argsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) throw invalid("arguments must be a JSON object");
  return args;
}

/** Models send `null` for "not given". */
function optionalText(
  record: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid(`${key} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw invalid(`${key} must be at most ${max} characters`);
  return trimmed;
}

function requiredText(record: Record<string, unknown>, key: string, max: number): string {
  const value = optionalText(record, key, max);
  if (value === undefined) throw invalid(`${key} is required`);
  return value;
}

function optionalKind(record: Record<string, unknown>): ResearchMediaKind | undefined {
  const value = record.mediaKind;
  if (value === undefined || value === null) return undefined;
  const kind = RESEARCH_MEDIA_KINDS.find((candidate) => candidate === value);
  if (!kind) throw invalid(`mediaKind must be one of ${RESEARCH_MEDIA_KINDS.join(", ")}`);
  return kind;
}

function parseSearch(args: unknown): AssetSearchRequest {
  const record = argsRecord(args);
  const query = requiredText(record, "query", RESEARCH_LIMITS.queryChars);
  const mediaKind = optionalKind(record);
  if (!mediaKind) throw invalid("mediaKind is required");
  const request: AssetSearchRequest = { query, mediaKind };
  const { sources, limit } = record;
  if (sources !== undefined && sources !== null) {
    if (!Array.isArray(sources) || !sources.every((id) => typeof id === "string"))
      throw invalid("sources must be an array of source ids");
    const ids = [...new Set(sources.map((id: string) => id.trim()).filter(Boolean))];
    if (ids.length > RESEARCH_LIMITS.sources) throw invalid("too many sources");
    if (ids.length > 0) request.sources = ids;
  }
  if (limit !== undefined && limit !== null) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
      throw invalid("limit must be a positive integer");
    request.limit = Math.min(limit, RESEARCH_LIMITS.searchResults);
  }
  return request;
}

/**
 * The research tools of one running turn, bound to that turn's project, abort signal and team. Like the editing and
 * story executors it tracks its in-flight calls so {@link shutdown} can stop the turn's research before the checkpoint
 * transaction closes: an import or resolution already sent to the server writes project files, so it is awaited to its
 * end (the host cancels it on abort and keeps waiting for the server's answer, see {@link ResearchHost}), and no new
 * call is accepted afterwards. A write the host could not settle is reported by {@link shutdown} as unsettled.
 *
 * Who may call what is re-checked here with {@link researchToolsFor}, so a Director cannot reach the search or import
 * tools however it names them. The fields of a request that describe the caller (turn, agent, model) are set here and
 * whatever the model sends for them is dropped; requests never carry an Asset Search policy mode — the Studio server
 * enforces the user's policy on every call.
 */
export class TurnResearch {
  private accepting = true;
  private readonly stop = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly unsettled: string[] = [];
  private readonly candidates = new Map<string, KnownCandidate>();

  constructor(private readonly options: TurnResearchOptions) {}

  execute(
    caller: AgentId,
    name: string,
    args: unknown,
    callSignal: AbortSignal,
  ): Promise<HostToolResult> {
    if (!this.accepting)
      return Promise.resolve(refuse("The turn is finishing; research is closed."));
    if (!isResearchToolName(name)) return Promise.resolve(refuse(`Unknown research tool ${name}.`));
    const { enabled, turn } = this.options;
    if (!researchToolsFor(caller, enabled, turn).some((tool) => tool === name))
      return Promise.resolve(refuse(`${name} is not available to you in this turn.`));
    const signal = AbortSignal.any([callSignal, this.options.turnSignal, this.stop.signal]);
    const call = this.run(name, args, signal, caller).catch((error: unknown): HostToolResult => {
      if (error instanceof ResearchToolError) {
        if (error.code === "write_unsettled") this.unsettled.push(`${name}: ${error.message}`);
        return refuse(formatResearchError(error));
      }
      return refuse(`internal: ${errorMessage(error, "The research call failed")}`);
    });
    this.inflight.add(call);
    void call.finally(() => this.inflight.delete(call));
    return call;
  }

  /** A candidate the turn has seen (for activity labels); the server's record stays the source of truth. */
  candidate(id: string): KnownCandidate | undefined {
    return this.candidates.get(id);
  }

  /** The user's policy as the turn starts; null when Studio cannot say (research is then unavailable). */
  async policy(signal: AbortSignal): Promise<AssetSearchPolicy | null> {
    try {
      return await this.options.host.policy(signal);
    } catch {
      return null;
    }
  }

  /**
   * Stops accepting calls, cancels running calls, and waits for every started call to end. Resolves with the writes
   * the host could not settle (cancelled, but Studio never said whether they wrote): those may land after the
   * checkpoint closed, and the caller should say so.
   */
  async shutdown(): Promise<{ unsettledWrites: string[] }> {
    this.accepting = false;
    this.stop.abort();
    await Promise.allSettled([...this.inflight]);
    return { unsettledWrites: [...this.unsettled] };
  }

  private remember(candidates: readonly AssetCandidate[]): void {
    for (const candidate of candidates) {
      this.candidates.set(candidate.id, {
        title: candidate.title,
        license: candidate.license.name,
      });
    }
  }

  /** In a resolve turn the user's list of Missing Asset nodes is the limit; the model cannot widen it. */
  private checkScope(missing: string): void {
    const { turn, storyOptions } = this.options;
    const scope = turn.action === "resolve" ? storyOptions?.missing : undefined;
    if (scope && !scope.includes(missing)) {
      throw invalid(
        `${missing} is not one of the Missing Asset nodes this turn may resolve (${scope.join(", ") || "none"}).`,
      );
    }
  }

  /**
   * Opens a page of a site the user linked. The scope is decided here, from the user's own messages, before Studio is
   * asked; Studio then enforces the user's switch and that only public addresses are fetched.
   */
  private async readWebsite(
    args: unknown,
    signal: AbortSignal,
    caller: AgentId,
  ): Promise<HostToolResult> {
    const { host, turnId, intent } = this.options;
    const record = argsRecord(args);
    const url = requiredText(record, "url", RESEARCH_LIMITS.urlChars);
    const save = record.save === true;
    if (record.save !== undefined && record.save !== null && typeof record.save !== "boolean")
      throw invalid("save must be true or false");
    const sites = linkedSites(this.options.userTexts());
    if (!isLinkedSite(url, sites)) {
      const linked =
        sites.length > 0
          ? `The user has linked: ${sites.join(", ")}.`
          : "The user has not linked any website in this chat.";
      return refuse(
        `blocked_by_policy: ${url} is not a page of a website the user linked in this chat. ${linked} You may read only a site the user sent a link to (the same site, including www. and subdomains); ask the user for the link — do not guess, search for or try another address.`,
      );
    }
    if (save && intent !== "edit") {
      return refuse(
        `This is a ${intent === "plan" ? "Plan" : "Ask"} turn: nothing in the project changes, so read_website cannot save files. Call it without save to read the style, and say that the files are saved when the user proceeds.`,
      );
    }
    const request: ReadWebsiteRequest = {
      url,
      ...(save && {
        save,
        turnId,
        agent: caller,
        model: caller === "research" ? this.options.model() : null,
      }),
    };
    try {
      return formatWebsite(await host.website(request, signal));
    } catch (error) {
      if (error instanceof ResearchToolError && error.code === "blocked_by_policy") {
        return refuse(
          `blocked_by_policy: ${error.message} Reading linked websites is switched off in Settings → Asset Search → Websites; agents cannot change it. Tell the user, and continue without reading the site unless they enable it.`,
        );
      }
      throw error;
    }
  }

  private async run(
    name: ResearchToolName,
    args: unknown,
    signal: AbortSignal,
    caller: AgentId,
  ): Promise<HostToolResult> {
    const { host, turnId } = this.options;
    switch (name) {
      case RESEARCH_TOOL_NAMES.search: {
        const result = await host.search(parseSearch(args), signal);
        this.remember(result.candidates);
        return { text: formatSearch(result) };
      }
      case RESEARCH_TOOL_NAMES.inspect: {
        const record = argsRecord(args);
        const request: InspectUrlRequest = {
          url: requiredText(record, "url", RESEARCH_LIMITS.urlChars),
        };
        const mediaKind = optionalKind(record);
        if (mediaKind) request.mediaKind = mediaKind;
        const result = await host.inspect(request, signal);
        this.remember(result.candidates);
        return { text: formatInspect(result) };
      }
      case RESEARCH_TOOL_NAMES.import: {
        const record = argsRecord(args);
        const candidate = optionalText(record, "candidate", 120);
        const url = optionalText(record, "url", RESEARCH_LIMITS.urlChars);
        if ((candidate === undefined) === (url === undefined))
          throw invalid("pass exactly one of candidate and url");
        const request: ImportAssetRequest = {
          ...(candidate !== undefined && { candidate }),
          ...(url !== undefined && { url }),
          turnId,
          agent: "research",
          model: this.options.model(),
        };
        const fileName = optionalText(record, "name", RESEARCH_LIMITS.fileNameChars);
        if (fileName) request.name = fileName;
        const resolveMissing = optionalText(record, "resolveMissing", 66);
        if (resolveMissing) {
          this.checkScope(resolveMissing);
          request.resolveMissing = resolveMissing;
        }
        const result = await host.importAsset(request, signal);
        return { text: formatImport(result) };
      }
      case RESEARCH_TOOL_NAMES.resolve: {
        const record = argsRecord(args);
        const missing = requiredText(record, "missing", 66);
        const asset = requiredText(record, "asset", 1_024);
        this.checkScope(missing);
        return { text: formatResolve(await host.resolve({ missing, asset, turnId }, signal)) };
      }
      case RESEARCH_TOOL_NAMES.sources:
        return { text: formatSources(await host.sources(signal)) };
      case RESEARCH_TOOL_NAMES.website:
        return this.readWebsite(args, signal, caller);
    }
  }
}
