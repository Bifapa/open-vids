import {
  RESEARCH_LIMITS,
  WEBSITE_FILE_MODES,
  WEBSITE_LIMITS,
  type AgentId,
  type AssetCandidate,
  type ChatIntent,
  type InspectUrlRequest,
  type PermissionAction,
  type PermissionKind,
  type ReadWebsiteRequest,
  type RecordWebsiteRequest,
  type SpecialistId,
  type StoryActionOptions,
  type WebsiteFileRequest,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { errorMessage } from "../errors.js";
import type { PermissionBroker } from "../permissions.js";
import type { StoryTurnMode } from "../story/tools.js";
import {
  argsRecord,
  invalid,
  optionalKind,
  optionalSide,
  optionalText,
  parseSearch,
  refuse,
  requiredText,
} from "./args.js";
import {
  DownloadGate,
  NO_DOWNLOAD,
  PERMISSION_WHAT,
  permissionRefusalText,
} from "./downloadGate.js";
import {
  formatInspect,
  formatResearchError,
  formatResolve,
  formatSearch,
  formatSources,
} from "./format.js";
import { formatRecordWebsite, formatWebsite, formatWebsiteFile } from "./formatWebsite.js";
import { formatSpecDraft, websiteStyleToSpecDraft } from "../design/website.js";
import { ResearchToolError, type ResearchHost } from "./host.js";
import { ImportFlow } from "./importFlow.js";
import { registrableDomain, websiteHostOf } from "./linkedSites.js";
import { SiteScope } from "./siteScope.js";
import {
  DEFAULT_RESEARCH_ACCESS,
  RESEARCH_TOOL_NAMES,
  isResearchToolName,
  researchToolsFor,
  type KnownCandidate,
  type ResearchAccess,
  type ResearchToolName,
  websiteFileMode,
} from "./tools.js";
import type { WebsiteAccess } from "./websiteResources.js";

/** The user's Websites settings as a turn read them (Settings → Asset Search → Websites). */
export interface WebsiteSettings {
  readLinkedPages: boolean;
  fullAccess: boolean;
}

/** What {@link TurnResearch.askPermission} settled as: a refusal, or the note that the user allowed the call. */
interface AskOutcome {
  refusal: HostToolResult | null;
  note: string | null;
  /** Whether a request was shown to the user at all (false: no broker, or the setting is on). */
  asked: boolean;
  /** The answer came from an earlier request of this turn (no new card was shown for this call). */
  reused: boolean;
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
   * access may fetch only pages of a linked site or an exact URL from that memory. It is kept per chat next to the
   * chat's data, so it survives turns and restarts (entries expire after a week).
   */
  websites: WebsiteAccess;
  /**
   * What the user wrote in this chat so far: the first prompt, later messages and steering — never assistant text,
   * search results or page contents. The websites linked in it (see `chatLinkedSites`) are the only ones
   * `read_website` may open.
   */
  userTexts: () => readonly string[];
  /** What the user wrote in this turn only (its prompt and steering): the only place a download approval can come from. */
  turnUserTexts: () => readonly string[];
  /** Sites the user removed from the chat's linked list; the runtime refuses them however often they are mentioned. */
  excludedSites?: () => readonly string[];
  /**
   * The user's "ask before downloading assets" setting. When true, every download (`import_asset`, `read_website` with
   * `save`, `get_website_file` in save mode, `record_website`) needs the user's approval in this turn: a Story "Find
   * missing material" action, or a message of the turn that tells the agents to download/import
   * (`approvesDownload`; a bare yes does not count, a negation cancels it), or an answer to the `asset_download` card
   * the call publishes and waits on. Never the model's
   * own text. Without a permission broker such a call is refused instead.
   */
  askBeforeDownloads: boolean;
  /**
   * Whether `build_story` already ran in this turn (the Story executor's `hasBuilt`). In a build turn the graph is
   * frozen from then on: `import_asset` with `resolveMissing` and `resolve_missing_asset` are refused.
   */
  storyBuilt?: () => boolean;
  /**
   * A design turn that makes a system from a website: a successful `read_website` result ends with the draft spec the
   * site's style maps to (see design/website.ts), so the model starts from exact colours, fonts and motion.
   */
  designDraft?: boolean;
  /** The model the calling agent runs (`provider/modelId`), recorded in the provenance of what it imports. */
  model: (agent: AgentId) => string | null;
}

/** Joins the notes the model reads before a tool's result (a permission answer, a download answer). */
function joinNotes(...notes: Array<string | null>): string | null {
  const present = notes.filter((note) => note !== null);
  return present.length === 0 ? null : present.join(" ");
}

function withNote(result: HostToolResult, note: string | null): HostToolResult {
  return note === null ? result : { ...result, text: `${note}\n\n${result.text}` };
}

/**
 * The research tools of one running turn, bound to that turn's project, abort signal and team. Like the editing and
 * story executors it tracks its in-flight calls so {@link shutdown} can stop the turn's research before the checkpoint
 * transaction closes: an import or resolution already sent to the server writes project files, so it is awaited to its
 * end (the host cancels it on abort and keeps waiting for the server's answer, see {@link ResearchHost}), and no new
 * call is accepted afterwards. A write the host could not settle is reported by {@link shutdown} as unsettled.
 *
 * Who may call what is re-checked here with {@link researchToolsFor}: the Director reaches the search and import tools
 * only while Research is off in the chat (its work moves to the Director, with the same policy and approvals), and
 * no agent reaches a tool it was not given however it names it. The fields of a request that describe the caller
 * (turn, agent, model) are set here and
 * whatever the model sends for them is dropped; requests never carry an Asset Search policy mode — the Studio server
 * enforces the user's policy on every call.
 */
export class TurnResearch {
  private accepting = true;
  private readonly stop = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly unsettled: string[] = [];
  private readonly candidates = new Map<string, KnownCandidate>();
  private readonly gate: DownloadGate;
  private readonly sites: SiteScope;
  private readonly imports: ImportFlow;
  /** The Websites settings last read; refreshed after a refusal so a change in Settings mid-turn is honoured. */
  private websiteSettings: WebsiteSettings | null;

  constructor(private readonly options: TurnResearchOptions) {
    this.websiteSettings = options.websiteSettings ?? null;
    this.gate = new DownloadGate({
      askBeforeDownloads: options.askBeforeDownloads,
      turn: options.turn,
      turnUserTexts: options.turnUserTexts,
      permissions: options.permissions ?? null,
    });
    this.sites = new SiteScope({
      userTexts: options.userTexts,
      turnUserTexts: options.turnUserTexts,
      ...(options.excludedSites && { excludedSites: options.excludedSites }),
      websites: options.websites,
      permissions: options.permissions ?? null,
    });
    this.imports = new ImportFlow({
      host: options.host,
      turnId: options.turnId,
      model: options.model,
      gate: this.gate,
    });
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
    this.gate.remember(candidates);
  }

  /** In a build turn, once the story is built the graph is frozen: a node resolved later would not reach the timeline. */
  private storyFrozenRefusal(): HostToolResult | null {
    if (this.options.turn.action !== "build" || !(this.options.storyBuilt?.() ?? false))
      return null;
    return refuse(
      "The story was already built in this turn, so the graph is frozen: a Missing Asset node resolved now would not reach the timeline. Import the file without resolveMissing (just the candidate or url) and report its project path, so it can be placed on the timeline with edit_timeline.",
    );
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
   * The site a URL belongs to: its registrable domain, or the exact host when it has none (an address with no domain
   * name), so a website card always names a site and a grant never means "every site".
   */
  private siteOf(url: string): string | null {
    const host = websiteHostOf(url);
    return host === null ? null : (registrableDomain(host) ?? host);
  }

  /**
   * Asks the user in chat when the setting a call needs is off, and waits for their answer. Nothing is asked when the
   * setting is on, or when there is no broker to show the request (the call then fails like before). The answer
   * covers the site of `url` only ("Turn on" covers every site).
   */
  private async askPermission(
    kind: PermissionKind,
    action: PermissionAction,
    url: string,
    caller: AgentId,
    signal: AbortSignal,
  ): Promise<AskOutcome> {
    const broker = this.options.permissions ?? null;
    if (!broker || this.websiteSettingOn(kind))
      return { refusal: null, note: null, asked: false, reused: false };
    const site = this.siteOf(url);
    const reused = broker.peek(kind, site)?.state !== undefined;
    const request = await broker.ask({ kind, action, site, agent: caller }, signal);
    if (request.state === "allowed_once" || request.state === "enabled") {
      const what = PERMISSION_WHAT[request.kind];
      return {
        refusal: null,
        note:
          request.state === "allowed_once"
            ? `The user allowed ${what}${site === null ? "" : ` on ${site}`} once from the chat for this turn.`
            : `The user turned ${what} on.`,
        asked: true,
        reused,
      };
    }
    return {
      refusal: refuse(permissionRefusalText(request, site)),
      note: null,
      asked: true,
      reused,
    };
  }

  /**
   * Runs a website call. A `blocked_by_policy` refusal means Studio does not honour what the turn believes it has —
   * the setting was switched off in Settings mid-turn, or Studio restarted and forgot the turn's "Allow once" — so
   * the policy is re-read, the broker drops its stale "allowed" answer and the user is asked again, once. The refusal
   * is final (`retryWithAsk` false) only when this very call just showed a new card and Studio still refused.
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
      this.options.permissions?.reset(call.kind, this.siteOf(call.url));
      const asked = await this.askPermission(
        call.kind,
        call.action,
        call.url,
        call.caller,
        call.signal,
      );
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
    if (!this.sites.isLinked(url)) {
      return refuse(
        `blocked_by_policy: ${url} is not a page of a website the user linked in this chat. ${this.sites.linkedNote()} You may read only a site the user sent a link to (the same site, including www. and subdomains); ask the user for the link — do not guess, search for or try another address.`,
      );
    }
    if (save && intent !== "edit") {
      return refuse(
        "This is an Ask turn: the user wants an answer only, so read_website cannot save files. Call it without save to read the style, and answer from what you read.",
      );
    }
    const asked = await this.askPermission("read_linked_pages", "read", url, caller, signal);
    if (asked.refusal) return asked.refusal;
    const gate = save
      ? await this.gate.check({
          action: "download",
          url,
          caller,
          asset: this.gate.assetOfUrl(url),
          signal,
        })
      : NO_DOWNLOAD;
    if (gate.refusal) return gate.refusal;
    // The turn id is sent even without save: a grant of this turn ("Allow once") passes the setting's check on the server.
    const allowedSites = this.sites.allowedSitesFor(
      url,
      "read_linked_pages",
      this.websiteSettingOn("read_linked_pages"),
    );
    const request: ReadWebsiteRequest = {
      url,
      allowedSites,
      turnId,
      ...(save && {
        save,
        agent: caller,
        model: this.options.model(caller),
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
      retryWithAsk: !asked.asked || asked.reused,
      note: asked.note,
    });
    if ("refusal" in outcome) return outcome.refusal;
    // A redirect may have left the linked sites (an open redirect on a linked page): nothing of the page is shown
    // or remembered then, or the read would hand the agent, and its later file requests, any public site.
    const left = this.sites.redirectedAway(url, outcome.value.site.finalUrl, allowedSites);
    if (left) return left;
    await this.options.websites.resources.rememberRead(this.options.websites.chatId, outcome.value);
    const formatted = formatWebsite(outcome.value, {
      fullAccess: (this.options.access ?? DEFAULT_RESEARCH_ACCESS).websiteFiles,
    });
    const withDraft = this.options.designDraft
      ? {
          ...formatted,
          text: `${formatted.text}\n\n${formatSpecDraft(websiteStyleToSpecDraft(outcome.value.site, outcome.value.saved))}`,
        }
      : formatted;
    return withNote(withDraft, joinNotes(outcome.note, gate.note));
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
    const mode = websiteFileMode(requiredText(record, "mode", 16));
    if (!mode) throw invalid(`mode must be one of ${WEBSITE_FILE_MODES.join(", ")}`);
    const pageUrl = optionalText(record, "pageUrl", RESEARCH_LIMITS.urlChars);
    const scope = await this.sites.fileScope(url);
    if (scope) return scope;
    if (mode === "save" && this.options.intent !== "edit") {
      return refuse(
        'This is an Ask turn: the user wants an answer only, so get_website_file cannot save a file. Read it with mode "read" and answer from its text.',
      );
    }
    const action: PermissionAction = mode === "save" ? "download" : "read_code";
    const asked = await this.askPermission("website_full_access", action, url, caller, signal);
    if (asked.refusal) return asked.refusal;
    const gate =
      mode === "save"
        ? await this.gate.check({
            action: "download",
            url,
            caller,
            asset: this.gate.assetOfUrl(url),
            signal,
          })
        : NO_DOWNLOAD;
    if (gate.refusal) return gate.refusal;
    // The turn id is sent even for a read: a grant of this turn ("Allow once") passes the setting's check on the server.
    const allowedSites = this.sites.allowedSitesFor(
      url,
      "website_full_access",
      this.websiteSettingOn("website_full_access"),
    );
    const request: WebsiteFileRequest = {
      url,
      mode,
      allowedSites,
      turnId,
      ...(pageUrl !== undefined && { pageUrl }),
      ...(mode === "save" && {
        agent: caller,
        model: this.options.model(caller),
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
      retryWithAsk: !asked.asked || asked.reused,
      note: asked.note,
    });
    if ("refusal" in outcome) return outcome.refusal;
    const left = this.sites.redirectedAway(url, outcome.value.finalUrl, allowedSites);
    if (left) return left;
    const formatted = { text: formatWebsiteFile(outcome.value) };
    return withNote(formatted, joinNotes(outcome.note, gate.note));
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
    const scope = await this.sites.fileScope(url);
    if (scope) return scope;
    if (this.options.intent !== "edit") {
      return refuse(
        "This is an Ask turn: the user wants an answer only, so record_website is not available.",
      );
    }
    const asked = await this.askPermission("website_full_access", "record", url, caller, signal);
    if (asked.refusal) return asked.refusal;
    const gate = await this.gate.check({
      action: "record",
      url,
      caller,
      asset: this.gate.assetOfUrl(url),
      signal,
    });
    if (gate.refusal) return gate.refusal;
    const allowedSites = this.sites.allowedSitesFor(
      url,
      "website_full_access",
      this.websiteSettingOn("website_full_access"),
    );
    const request: RecordWebsiteRequest = {
      url,
      allowedSites,
      seconds,
      ...(selector !== undefined && { selector }),
      ...(scroll === true && { scroll: true }),
      ...(width !== undefined && { width }),
      ...(height !== undefined && { height }),
      turnId,
      agent: caller,
      model: this.options.model(caller),
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
      retryWithAsk: !asked.asked || asked.reused,
      note: asked.note,
    });
    if ("refusal" in outcome) return outcome.refusal;
    const left = this.sites.redirectedAway(url, outcome.value.finalUrl, allowedSites);
    if (left) return left;
    const formatted = { text: formatRecordWebsite(outcome.value) };
    return withNote(formatted, joinNotes(outcome.note, gate.note));
  }

  private async run(
    name: ResearchToolName,
    args: unknown,
    signal: AbortSignal,
    caller: AgentId,
  ): Promise<HostToolResult> {
    const { host, turnId } = this.options;
    // The policy could not be read when the turn started: the first research call tries again.
    if (this.websiteSettings === null) await this.refreshWebsiteSettings(signal);
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
      case RESEARCH_TOOL_NAMES.import:
        return this.imports.run(argsRecord(args), signal, caller, (missing) => {
          this.checkScope(missing);
          return this.storyFrozenRefusal();
        });
      case RESEARCH_TOOL_NAMES.resolve: {
        const record = argsRecord(args);
        const missing = requiredText(record, "missing", 66);
        const asset = requiredText(record, "asset", 1_024);
        this.checkScope(missing);
        const frozen = this.storyFrozenRefusal();
        if (frozen) return frozen;
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
