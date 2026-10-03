import {
  RESEARCH_LIMITS,
  RESEARCH_MEDIA_KINDS,
  WEBSITE_FILE_MODES,
  WEBSITE_LIMITS,
  isRecord,
  type AgentId,
  type AssetCandidate,
  type AssetSearchRequest,
  type ChatIntent,
  type ImportAssetRequest,
  type InspectUrlRequest,
  type PermissionAction,
  type PermissionKind,
  type PermissionRequest,
  type ReadWebsiteRequest,
  type RecordWebsiteRequest,
  type ResearchMediaKind,
  type SpecialistId,
  type StoryActionOptions,
  type WebsiteFileRequest,
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
import { formatRecordWebsite, formatWebsite, formatWebsiteFile } from "./formatWebsite.js";
import { ResearchToolError, type ResearchHost } from "./host.js";
import { approvesDownload, downloadApprovalRefusal } from "../autonomy.js";
import { isLinkedSite, linkedSites, registrableDomain, websiteHostOf } from "./linkedSites.js";
import type { PermissionBroker } from "../permissions.js";
import {
  DEFAULT_RESEARCH_ACCESS,
  RESEARCH_TOOL_NAMES,
  isResearchToolName,
  researchToolsFor,
  type KnownCandidate,
  type ResearchAccess,
  type ResearchToolName,
} from "./tools.js";
import type { WebsiteAccess } from "./websiteResources.js";

/** The user's Websites settings as a turn read them (Settings → Asset Search → Websites). */
export interface WebsiteSettings {
  readLinkedPages: boolean;
  fullAccess: boolean;
}

/** What each permission kind covers, in the words of the model-facing notes and refusals. */
const PERMISSION_WHAT: Record<PermissionKind, string> = {
  read_linked_pages: "reading linked pages",
  website_full_access: "full access to linked sites",
};

/** What {@link TurnResearch.askPermission} settled as: a refusal, or the note that the user allowed the call. */
interface AskOutcome {
  refusal: HostToolResult | null;
  note: string | null;
  /** Whether a request was shown to the user at all (false: no broker, or the setting is on). */
  asked: boolean;
}

/** One website call guarded by {@link TurnResearch.guardedWebsiteCall}. */
interface WebsiteCall<T> {
  kind: PermissionKind;
  action: PermissionAction;
  url: string;
  caller: AgentId;
  signal: AbortSignal;
  run: () => Promise<T>;
  /** What the model reads when the call stays refused (the error carries Studio's own message). */
  refusalText: (error: ResearchToolError) => string;
  /** Whether the refusal may be answered by asking the user (false when this call already asked). */
  retryWithAsk: boolean;
  /** The note from an earlier ask of this call ("the user allowed it once"). */
  note: string | null;
}

/** What the model reads when the user refused, or the turn ended before they answered. */
function permissionRefusalText(request: PermissionRequest, site: string | null): string {
  const what = PERMISSION_WHAT[request.kind];
  const where = site === null ? "" : ` on ${site}`;
  if (request.state === "denied")
    return `The user chose “Don't allow”: ${what}${where} is not allowed in this turn. Continue without it, and do not ask again in this turn.`;
  if (request.state === "expired")
    return `The turn ended before the user answered whether to allow ${what}${where}; the call was refused. Continue without it, and do not retry this turn.`;
  return `blocked_by_policy: ${what}${where} is not allowed. Continue without it.`;
}

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
  /** What the user wants from the turn: an Ask turn never saves a website's files into the project. */
  intent: ChatIntent;
  /** Which groups this turn offers (the same access its host tools were built with); full website access defaults off. */
  access?: ResearchAccess;
  /**
   * The user's Websites settings (Settings → Asset Search → Websites) as the turn read them; null when the policy
   * could not be read. When a switch a call needs is off, the call asks the user in chat through
   * {@link permissions} instead of failing; a setting changed in Settings mid-turn is re-read after a refusal.
   */
  websiteSettings?: WebsiteSettings | null;
  /**
   * The turn's permission broker: a call whose setting is off asks the user from the chat and waits here. Null (or
   * absent) when requests cannot be shown (tests without a chat): such calls fail as before.
   */
  permissions?: PermissionBroker | null;
  /**
   * The chat this turn belongs to and the runtime's memory of the files its `read_website` results listed: full
   * access may fetch only pages of a linked site or an exact URL from that memory. It lives as long as the runtime, so
   * it survives turns; after a restart the agent reads the site again.
   */
  websites: WebsiteAccess;
  /**
   * What the user wrote in this chat so far: the first prompt, later messages and steering — never assistant text,
   * search results or page contents. The websites linked in it are the only ones `read_website` may open.
   */
  userTexts: () => readonly string[];
  /** What the user wrote in this turn only (its prompt and steering): the only place a download approval can come from. */
  turnUserTexts: () => readonly string[];
  /**
   * The user's "ask before downloading assets" setting. When true, `import_asset` and `read_website` with `save` are
   * refused until the user approved in this turn: a Story "Find missing material" action, or a message of the turn that
   * tells the agents to download/import or says yes (`approvesDownload`). Never the model's own text.
   */
  askBeforeDownloads: boolean;
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

/** A recording viewport side: an even integer within the limits, or nothing when not given. */
function optionalSide(
  record: Record<string, unknown>,
  key: "width" | "height",
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 2 ||
    value > WEBSITE_LIMITS.recordMaxSide ||
    value % 2 !== 0
  )
    throw invalid(`${key} must be an even integer between 2 and ${WEBSITE_LIMITS.recordMaxSide}`);
  return value;
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
  /** The Websites settings last read; refreshed after a refusal so a change in Settings mid-turn is honoured. */
  private websiteSettings: WebsiteSettings | null;

  constructor(private readonly options: TurnResearchOptions) {
    this.websiteSettings = options.websiteSettings ?? null;
  }

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
    const access = this.options.access ?? DEFAULT_RESEARCH_ACCESS;
    if (!researchToolsFor(caller, enabled, turn, access).some((tool) => tool === name))
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

  /** Whether the user has approved downloading in this turn (always true when they do not want to be asked). */
  private downloadsApproved(): boolean {
    if (!this.options.askBeforeDownloads) return true;
    // The Story workspace's "Find missing material" is the user's own request to fill those nodes with downloads.
    if (this.options.turn.action === "resolve") return true;
    return this.options.turnUserTexts().some(approvesDownload);
  }

  /** Whether the switch a call of `kind` needs is on in the settings last read (unknown settings let Studio decide). */
  private websiteSettingOn(kind: PermissionKind): boolean {
    const settings = this.websiteSettings;
    if (!settings) return true;
    return kind === "read_linked_pages"
      ? settings.readLinkedPages
      : settings.readLinkedPages && settings.fullAccess;
  }

  /**
   * Re-reads the policy after a `blocked_by_policy` refusal, so a switch the user changed in Settings mid-turn is
   * honoured. Keeps the last read when Studio cannot answer (the refusal is then treated as final).
   */
  private async refreshWebsiteSettings(signal: AbortSignal): Promise<void> {
    try {
      const policy = await this.options.host.policy(signal);
      this.websiteSettings = {
        readLinkedPages: policy.websites.readLinkedPages,
        fullAccess: policy.websites.fullAccess,
      };
    } catch {
      // Studio could not say: keep what the turn knows.
    }
  }

  /**
   * Asks the user in chat when the setting a call needs is off, and waits for their answer. Nothing is asked when the
   * setting is on, or when there is no broker to show the request (the call then fails like before).
   */
  private async askPermission(
    kind: PermissionKind,
    action: PermissionAction,
    url: string,
    caller: AgentId,
  ): Promise<AskOutcome> {
    const broker = this.options.permissions ?? null;
    if (!broker || this.websiteSettingOn(kind)) return { refusal: null, note: null, asked: false };
    const host = websiteHostOf(url);
    const site = host === null ? null : registrableDomain(host);
    const request = await broker.ask({ kind, action, site, agent: caller });
    if (request.state === "allowed_once" || request.state === "enabled") {
      const what = PERMISSION_WHAT[request.kind];
      return {
        refusal: null,
        note:
          request.state === "allowed_once"
            ? `The user allowed ${what} once from the chat for this turn.`
            : `The user turned ${what} on.`,
        asked: true,
      };
    }
    return { refusal: refuse(permissionRefusalText(request, site)), note: null, asked: true };
  }

  /** Whether the user's permission answer in this turn also approves the website tools' downloads. */
  private permissionAllowsDownload(): boolean {
    return this.options.permissions?.allowsWebsiteDownload() ?? false;
  }

  /**
   * Runs a website call; a `blocked_by_policy` refusal re-reads the policy and, when the switch is off after all,
   * asks the user and retries once (the setting changed in Settings mid-turn). `retryWithAsk` is false when this call
   * already asked: the answer did not make Studio pass, so the refusal is final.
   */
  private async guardedWebsiteCall<T>(
    call: WebsiteCall<T>,
  ): Promise<{ value: T; note: string | null } | { refusal: HostToolResult }> {
    try {
      return { value: await call.run(), note: call.note };
    } catch (error) {
      if (!(error instanceof ResearchToolError) || error.code !== "blocked_by_policy") throw error;
      if (!call.retryWithAsk) return { refusal: refuse(call.refusalText(error)) };
      await this.refreshWebsiteSettings(call.signal);
      if (this.websiteSettingOn(call.kind)) return { refusal: refuse(call.refusalText(error)) };
      const asked = await this.askPermission(call.kind, call.action, call.url, call.caller);
      if (asked.refusal) return { refusal: asked.refusal };
      if (!asked.asked) return { refusal: refuse(call.refusalText(error)) };
      try {
        return { value: await call.run(), note: asked.note };
      } catch (retryError) {
        if (retryError instanceof ResearchToolError && retryError.code === "blocked_by_policy")
          return { refusal: refuse(call.refusalText(retryError)) };
        throw retryError;
      }
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
        "This is an Ask turn: the user wants an answer only, so read_website cannot save files. Call it without save to read the style, and answer from what you read.",
      );
    }
    const asked = await this.askPermission("read_linked_pages", "read", url, caller);
    if (asked.refusal) return asked.refusal;
    if (save && !this.downloadsApproved() && !this.permissionAllowsDownload())
      return refuse(downloadApprovalRefusal());
    // The turn id is sent even without save: a grant of this turn ("Allow once") passes the setting's check on the server.
    const request: ReadWebsiteRequest = {
      url,
      turnId,
      ...(save && {
        save,
        agent: caller,
        model: caller === "research" ? this.options.model() : null,
      }),
    };
    const outcome = await this.guardedWebsiteCall({
      kind: "read_linked_pages",
      action: "read",
      url,
      caller,
      signal,
      run: () => host.website(request, signal),
      refusalText: (error) =>
        `blocked_by_policy: ${error.message} Reading linked websites is off and the chat could not ask the user to allow it. Tell the user, and continue without reading the site — do not retry this turn.`,
      retryWithAsk: !asked.asked,
      note: asked.note,
    });
    if ("refusal" in outcome) return outcome.refusal;
    this.options.websites.resources.rememberRead(this.options.websites.chatId, outcome.value);
    const formatted = formatWebsite(outcome.value, {
      fullAccess: (this.options.access ?? DEFAULT_RESEARCH_ACCESS).websiteFiles,
    });
    return outcome.note === null
      ? formatted
      : { ...formatted, text: `${outcome.note}\n\n${formatted.text}` };
  }

  /**
   * Full access may fetch only a page of a site the user linked in this chat, or an exact file a `read_website` of
   * such a site listed earlier (its resources, logo, favicon, og image or fonts — CDN hosts included). The check runs
   * here, before Studio is asked; null when the URL is allowed.
   */
  private websiteFileScope(url: string): HostToolResult | null {
    const sites = linkedSites(this.options.userTexts());
    if (isLinkedSite(url, sites)) return null;
    if (this.options.websites.resources.has(this.options.websites.chatId, url)) return null;
    const linked =
      sites.length > 0
        ? `The user has linked: ${sites.join(", ")}.`
        : "The user has not linked any website in this chat.";
    return refuse(
      `blocked_by_policy: ${url} is not a file of a website the user linked in this chat. ${linked} Full access covers the linked site itself and the exact files an earlier read_website of it listed (its resources, logo, favicon, og image or fonts, CDN hosts included). Call read_website on the site first and take the URL from its resource list; do not guess, search for or try another address.`,
    );
  }

  /** `get_website_file`: downloads one file of a linked site (or a file an earlier read of it listed), or reads its text. */
  private async websiteFile(
    args: unknown,
    signal: AbortSignal,
    caller: AgentId,
  ): Promise<HostToolResult> {
    const { host, turnId } = this.options;
    const record = argsRecord(args);
    const url = requiredText(record, "url", RESEARCH_LIMITS.urlChars);
    const modeValue = requiredText(record, "mode", 16);
    const mode = WEBSITE_FILE_MODES.find((entry) => entry === modeValue);
    if (!mode) throw invalid(`mode must be one of ${WEBSITE_FILE_MODES.join(", ")}`);
    const pageUrl = optionalText(record, "pageUrl", RESEARCH_LIMITS.urlChars);
    const scope = this.websiteFileScope(url);
    if (scope) return scope;
    if (mode === "save" && this.options.intent !== "edit") {
      return refuse(
        'This is an Ask turn: the user wants an answer only, so get_website_file cannot save a file. Read it with mode "read" and answer from its text.',
      );
    }
    const action: PermissionAction = mode === "save" ? "download" : "read_code";
    const asked = await this.askPermission("website_full_access", action, url, caller);
    if (asked.refusal) return asked.refusal;
    if (mode === "save" && !this.downloadsApproved() && !this.permissionAllowsDownload())
      return refuse(downloadApprovalRefusal());
    // The turn id is sent even for a read: a grant of this turn ("Allow once") passes the setting's check on the server.
    const request: WebsiteFileRequest = {
      url,
      mode,
      turnId,
      ...(pageUrl !== undefined && { pageUrl }),
      ...(mode === "save" && {
        agent: caller,
        model: caller === "research" ? this.options.model() : null,
      }),
    };
    const what = mode === "save" ? "Downloading a file from a linked site" : "Reading a site file";
    const outcome = await this.guardedWebsiteCall({
      kind: "website_full_access",
      action,
      url,
      caller,
      signal,
      run: () => host.websiteFile(request, signal),
      refusalText: (error) =>
        `blocked_by_policy: ${error.message} ${what} needs full access to linked sites and the chat could not ask the user to allow it. Tell the user, and continue without it — do not retry this turn.`,
      retryWithAsk: !asked.asked,
      note: asked.note,
    });
    if ("refusal" in outcome) return outcome.refusal;
    const formatted = { text: formatWebsiteFile(outcome.value) };
    return outcome.note === null
      ? formatted
      : { ...formatted, text: `${outcome.note}\n\n${formatted.text}` };
  }

  /** `record_website`: records a page of a linked site as an MP4 (always a write). */
  private async recordWebsite(
    args: unknown,
    signal: AbortSignal,
    caller: AgentId,
  ): Promise<HostToolResult> {
    const { host, turnId } = this.options;
    const record = argsRecord(args);
    const url = requiredText(record, "url", RESEARCH_LIMITS.urlChars);
    const seconds = record.seconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds))
      throw invalid("seconds is required and must be a number");
    if (seconds < WEBSITE_LIMITS.recordMinSeconds || seconds > WEBSITE_LIMITS.recordMaxSeconds)
      throw invalid(
        `seconds must be between ${WEBSITE_LIMITS.recordMinSeconds} and ${WEBSITE_LIMITS.recordMaxSeconds}`,
      );
    const selector = optionalText(record, "selector", WEBSITE_LIMITS.selectorChars);
    const scroll = record.scroll;
    if (scroll !== undefined && scroll !== null && typeof scroll !== "boolean")
      throw invalid("scroll must be true or false");
    const width = optionalSide(record, "width");
    const height = optionalSide(record, "height");
    const scope = this.websiteFileScope(url);
    if (scope) return scope;
    if (this.options.intent !== "edit") {
      return refuse(
        "This is an Ask turn: the user wants an answer only, so record_website is not available.",
      );
    }
    const asked = await this.askPermission("website_full_access", "record", url, caller);
    if (asked.refusal) return asked.refusal;
    if (!this.downloadsApproved() && !this.permissionAllowsDownload())
      return refuse(downloadApprovalRefusal());
    const request: RecordWebsiteRequest = {
      url,
      seconds,
      ...(selector !== undefined && { selector }),
      ...(scroll === true && { scroll: true }),
      ...(width !== undefined && { width }),
      ...(height !== undefined && { height }),
      turnId,
      agent: caller,
      model: caller === "research" ? this.options.model() : null,
    };
    const outcome = await this.guardedWebsiteCall({
      kind: "website_full_access",
      action: "record",
      url,
      caller,
      signal,
      run: () => host.recordWebsite(request, signal),
      refusalText: (error) =>
        `blocked_by_policy: ${error.message} Recording a page of a linked site needs full access to linked sites and the chat could not ask the user to allow it. Tell the user, and continue without it — do not retry this turn.`,
      retryWithAsk: !asked.asked,
      note: asked.note,
    });
    if ("refusal" in outcome) return outcome.refusal;
    const formatted = { text: formatRecordWebsite(outcome.value) };
    return outcome.note === null
      ? formatted
      : { ...formatted, text: `${outcome.note}\n\n${formatted.text}` };
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
        if (!this.downloadsApproved()) return refuse(downloadApprovalRefusal());
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
      case RESEARCH_TOOL_NAMES.file:
        return this.websiteFile(args, signal, caller);
      case RESEARCH_TOOL_NAMES.record:
        return this.recordWebsite(args, signal, caller);
    }
  }
}
