import {
  RESEARCH_LIMITS,
  type AgentId,
  type ImportAssetRequest,
  type ImportAssetResult,
  type PermissionAsset,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { invalid, optionalText, refuse } from "./args.js";
import type { DownloadGate } from "./downloadGate.js";
import { formatImport } from "./format.js";
import { ResearchToolError, type ResearchHost } from "./host.js";

export interface ImportFlowOptions {
  host: ResearchHost;
  /** The running turn: stamped on every import so the server attributes the asset to it (and Revert undoes it). */
  turnId: string;
  /** The model the calling agent runs, recorded in the provenance. */
  model: (agent: AgentId) => string | null;
  gate: DownloadGate;
}

/** The asset a `restricted_license` refusal names (the server sends title, license and source). */
function assetOfRefusal(error: ResearchToolError): PermissionAsset | undefined {
  const { params } = error;
  if (!params || typeof params.title !== "string") return undefined;
  return {
    title: params.title,
    source: typeof params.source === "string" ? params.source : null,
    license: typeof params.license === "string" ? params.license : null,
  };
}

/**
 * `import_asset` of one turn: the cap on imports, the download approval, the restricted-license card and the call
 * itself. The server stays the authority on licenses — it refuses a restricted candidate with `restricted_license`
 * unless the request says the user allowed it — so the runtime asks the card either way: before the call when
 * Research's results already said the candidate is restricted, after the refusal when it did not know.
 */
export class ImportFlow {
  private count = 0;

  constructor(private readonly options: ImportFlowOptions) {}

  async run(
    record: Record<string, unknown>,
    signal: AbortSignal,
    caller: AgentId,
    /** Checks the Missing Asset node a call resolves (scope and Story freeze); a refusal ends the call. */
    prepare: (resolveMissing: string) => HostToolResult | null,
  ): Promise<HostToolResult> {
    const { host, turnId, gate } = this.options;
    const candidate = optionalText(record, "candidate", 120);
    const url = optionalText(record, "url", RESEARCH_LIMITS.urlChars);
    if ((candidate === undefined) === (url === undefined))
      throw invalid("pass exactly one of candidate and url");
    const request: ImportAssetRequest = {
      ...(candidate !== undefined && { candidate }),
      ...(url !== undefined && { url }),
      turnId,
      agent: caller,
      model: this.options.model(caller),
    };
    const fileName = optionalText(record, "name", RESEARCH_LIMITS.fileNameChars);
    if (fileName) request.name = fileName;
    const resolveMissing = optionalText(record, "resolveMissing", 66);
    if (resolveMissing) {
      const refusal = prepare(resolveMissing);
      if (refusal) return refusal;
      request.resolveMissing = resolveMissing;
    }
    if (this.count >= RESEARCH_LIMITS.importsPerTurn) {
      return refuse(
        `Import limit reached: at most ${RESEARCH_LIMITS.importsPerTurn} imports per turn. Do not import more in this turn; say in your report which material is still missing, so the user can ask for it in a new message.`,
      );
    }
    // The slot is taken before the first await (the approval card can wait for minutes), so parallel imports cannot
    // all pass the check above; a call that ends without a new file gives it back.
    this.count += 1;
    let result: ImportAssetResult | null = null;
    try {
      const downloadUrl = url ?? (candidate === undefined ? null : gate.mediaUrlOf(candidate));
      const approved = await gate.check({
        action: "download",
        url: downloadUrl,
        caller,
        asset: gate.assetOfImport(candidate, url),
        signal,
      });
      if (approved.refusal) return approved.refusal;
      const notes = [approved.note];
      const key = candidate ?? url ?? "";
      if (gate.isRestricted(candidate)) {
        const restricted = await gate.checkRestricted({
          key,
          url: downloadUrl,
          caller,
          asset: gate.assetOfImport(candidate, url),
          signal,
        });
        if (restricted.refusal) return restricted.refusal;
        notes.push(restricted.note);
        request.allowRestricted = true;
      }

      try {
        result = await host.importAsset(request, signal);
      } catch (error) {
        if (
          !(error instanceof ResearchToolError) ||
          error.code !== "restricted_license" ||
          request.allowRestricted === true
        )
          throw error;
        const restricted = await gate.checkRestricted({
          key,
          url: downloadUrl,
          caller,
          // What the server says it refused (title, license, source) is more exact than a guess from the URL.
          asset: assetOfRefusal(error) ?? gate.assetOfImport(candidate, url),
          signal,
        });
        if (restricted.refusal) return restricted.refusal;
        notes.push(restricted.note);
        request.allowRestricted = true;
        result = await host.importAsset(request, signal);
      }
      const note = notes.filter((entry) => entry !== null).join(" ");
      const text = formatImport(result);
      return { text: note === "" ? text : `${note}\n\n${text}` };
    } finally {
      // A refused, failed or duplicate import wrote no new file: it does not count against the turn's limit.
      if (result === null || result.duplicate !== null) this.count -= 1;
    }
  }
}
