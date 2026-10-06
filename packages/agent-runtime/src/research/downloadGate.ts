import type {
  AgentId,
  AssetCandidate,
  PermissionAsset,
  PermissionKind,
  PermissionRequest,
} from "@hyperframes/agent-protocol";
import { approvesDownload, downloadApprovalRefusal, downloadDeclinedRefusal } from "../autonomy.js";
import type { HostToolResult } from "../backend.js";
import type { PermissionBroker } from "../permissions.js";
import type { StoryTurnMode } from "../story/tools.js";
import { refuse } from "./args.js";
import { registrableDomain, websiteHostOf } from "./linkedSites.js";

/** What each permission kind covers, in the words of the model-facing notes and refusals. */
export const PERMISSION_WHAT: Record<PermissionKind, string> = {
  read_linked_pages: "reading linked pages",
  website_full_access: "full access to linked sites",
  asset_download: "downloading outside material",
  restricted_asset: "importing a restricted-license asset",
  long_render: "a long render",
  voice_generation: "generating the voiceover",
};

/** What the model reads when the user refused, or the turn ended before they answered. */
export function permissionRefusalText(request: PermissionRequest, site: string | null): string {
  if (request.kind === "asset_download" && request.state === "denied")
    return downloadDeclinedRefusal();
  if (request.kind === "restricted_asset" && request.state === "denied")
    return "Not imported: the user did not allow this restricted-license asset (non-commercial or no-derivatives terms). Pick another candidate with a clear or attribution license, or continue without it, and say in your report what is missing. Do not ask again for this asset.";
  const what = PERMISSION_WHAT[request.kind];
  const where = site === null ? "" : ` on ${site}`;
  if (request.state === "denied")
    return `The user chose “Don't allow”: ${what}${where} is not allowed in this turn. Continue without it, and do not ask again in this turn.`;
  if (request.state === "expired")
    return `The turn ended before the user answered whether to allow ${what}${where}; the call was refused. Continue without it, and do not retry this turn.`;
  return `blocked_by_policy: ${what}${where} is not allowed. Continue without it.`;
}

/** Longest title or source name shown on a card. */
const CARD_TEXT_CHARS = 160;

const shortened = (value: string): string =>
  value.length > CARD_TEXT_CHARS ? `${value.slice(0, CARD_TEXT_CHARS - 1).trimEnd()}…` : value;

/** The file name of a URL's path (decoded), or its host when the path names nothing. */
function urlTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname
      .split("/")
      .filter((part) => part !== "")
      .at(-1);
    if (last === undefined) return shortened(parsed.hostname);
    try {
      return shortened(decodeURIComponent(last));
    } catch {
      return shortened(last);
    }
  } catch {
    return shortened(url);
  }
}

/** What a download call settled as: a refusal for the model, or the note that the user allowed it from the chat. */
export interface DownloadOutcome {
  refusal: HostToolResult | null;
  note: string | null;
}

/** No download was involved in the call (a read), so there is nothing to gate. */
export const NO_DOWNLOAD: DownloadOutcome = { refusal: null, note: null };

/** One download the gate decides on. */
export interface DownloadCall {
  action: "download" | "record";
  /** The URL the call fetches, when the runtime knows it (the card names its site). */
  url: string | null;
  caller: AgentId;
  asset: PermissionAsset | undefined;
  /** The calling tool's signal: cancelling the run that asked takes its card down. */
  signal?: AbortSignal | undefined;
}

export interface DownloadGateOptions {
  /** The user's "ask before downloading" setting as the turn read it. */
  askBeforeDownloads: boolean;
  turn: StoryTurnMode;
  /** What the user wrote in this turn only: the only text a download approval can come from. */
  turnUserTexts: () => readonly string[];
  /** Null when requests cannot be shown in a chat (tests without one): unapproved downloads are then refused. */
  permissions: PermissionBroker | null;
}

/**
 * The one gate every download of a turn goes through (`import_asset`, `read_website` with save, `get_website_file` in
 * save mode, `record_website`). A call is approved when the user does not want to be asked, in a Story resolve turn,
 * when one of the turn's messages approves ({@link approvesDownload}), or when they allowed a card of this turn that
 * was about saving something. Otherwise the call publishes an `asset_download` card and waits for the answer; with no
 * broker it is refused with the text flow ({@link downloadApprovalRefusal}). Never the model's own text approves.
 */
export class DownloadGate {
  /** What Research's results said about the candidates of this turn, so a card can name the material. */
  private readonly known = new Map<
    string,
    { title: string; source: string; license: string; restricted: boolean; mediaUrl: string }
  >();

  constructor(private readonly options: DownloadGateOptions) {}

  remember(candidates: readonly AssetCandidate[]): void {
    for (const candidate of candidates) {
      this.known.set(candidate.id, {
        title: candidate.title,
        source: candidate.source.name,
        license: candidate.license.name,
        restricted: candidate.license.status === "restricted",
        mediaUrl: candidate.mediaUrl,
      });
    }
  }

  /** The media URL a remembered candidate would download from (for the card's site). */
  mediaUrlOf(candidate: string): string | null {
    return this.known.get(candidate)?.mediaUrl ?? null;
  }

  /** What the card shows for a file or a page of a website: the file name, and the host it comes from. */
  assetOfUrl(url: string): PermissionAsset {
    return { title: urlTitle(url), source: websiteHostOf(url), license: null };
  }

  /** What the card shows for an import: the remembered candidate (title, source, license), or the URL. */
  assetOfImport(
    candidate: string | undefined,
    url: string | undefined,
  ): PermissionAsset | undefined {
    if (url !== undefined) return this.assetOfUrl(url);
    const known = candidate === undefined ? undefined : this.known.get(candidate);
    if (!known) return undefined;
    return {
      title: shortened(known.title),
      source: shortened(known.source) || websiteHostOf(known.mediaUrl),
      license: known.license || null,
    };
  }

  /** Whether the user has approved downloading in this turn without a card of this call. */
  approved(): boolean {
    const { askBeforeDownloads, turn, turnUserTexts, permissions } = this.options;
    if (!askBeforeDownloads) return true;
    // The Story workspace's "Find missing material" is the user's own request to fill those nodes with downloads.
    if (turn.action === "resolve") return true;
    if (turnUserTexts().some(approvesDownload)) return true;
    return permissions?.allowsDownload() ?? false;
  }

  /** Lets the call through, asking the user in the chat first when it is not approved yet (and waiting for them). */
  async check(call: DownloadCall): Promise<DownloadOutcome> {
    if (this.approved()) return NO_DOWNLOAD;
    const broker = this.options.permissions;
    if (!broker) return { refusal: refuse(downloadApprovalRefusal()), note: null };
    const host = call.url === null ? null : websiteHostOf(call.url);
    const site = host === null ? null : registrableDomain(host);
    const request = await broker.ask(
      {
        kind: "asset_download",
        action: call.action,
        site,
        agent: call.caller,
        ...(call.asset !== undefined && { asset: call.asset }),
      },
      call.signal,
    );
    if (request.state === "allowed_once")
      return { refusal: null, note: "The user allowed downloads for this turn from the chat." };
    if (request.state === "enabled")
      return { refusal: null, note: "The user turned asking before downloads off." };
    return { refusal: refuse(permissionRefusalText(request, site)), note: null };
  }

  /** Whether Research's results said this candidate's license status is `restricted`. */
  isRestricted(candidate: string | undefined): boolean {
    return candidate !== undefined && (this.known.get(candidate)?.restricted ?? false);
  }

  /**
   * The card of a restricted-license import: asked for each asset on its own, whatever the user approved for
   * downloads (a restricted license — non-commercial or no-derivatives — is the one thing a blanket approval does not
   * cover). `asset` is what the card names (the server's refusal names it when the runtime never saw the candidate).
   */
  async checkRestricted(call: {
    key: string;
    url: string | null;
    caller: AgentId;
    asset: PermissionAsset | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<DownloadOutcome> {
    const broker = this.options.permissions;
    if (!broker) {
      return {
        refusal: refuse(
          "Not imported: this asset has a restricted license (non-commercial or no-derivatives terms) and the user has not allowed it. Pick another candidate with a clear or attribution license, or report that the user must decide.",
        ),
        note: null,
      };
    }
    const host = call.url === null ? null : websiteHostOf(call.url);
    const site = host === null ? null : registrableDomain(host);
    const request = await broker.ask(
      {
        kind: "restricted_asset",
        action: "download",
        site,
        agent: call.caller,
        key: call.key,
        ...(call.asset !== undefined && { asset: call.asset }),
      },
      call.signal,
    );
    if (request.state === "allowed_once")
      return {
        refusal: null,
        note: "The user allowed this restricted-license asset from the chat; tell them in your report that its license restricts use (non-commercial or no-derivatives).",
      };
    return { refusal: refuse(permissionRefusalText(request, site)), note: null };
  }
}
