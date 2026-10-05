import { WEB_SOURCE_ID } from "@hyperframes/agent-protocol";
import type {
  AssetCandidate,
  AssetProvenance,
  AssetSearchResult,
  ExportLicenseCheck,
  ImportAssetResult,
  InspectUrlResult,
  LicenseInfo,
  LicenseStatus,
  ProjectSourcesView,
  ResolveMissingResult,
} from "@hyperframes/agent-protocol";
import { ResearchToolError } from "./host.js";

/**
 * What the model reads from the research tools. Everything here comes from the Studio server's records (the source's
 * own API or page), never from the model; licenses are shown with how they were found and with what they mean for the
 * user, so the model reports them instead of guessing.
 */

const RESULT_CHARS = 14_000;
const DESCRIPTION_CHARS = 140;

const cap = (text: string, limit = RESULT_CHARS): string =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const clip = (text: string, limit: number): string => {
  const flat = oneLine(text);
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
};

const seconds = (value: number): string => `${Number(value.toFixed(1))} s`;

const megabytes = (bytes: number): string =>
  bytes >= 100_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1_000))} kB`;

const STATUS_TEXT: Record<LicenseStatus, string> = {
  clear: "clear to use",
  attribution: "attribution required",
  restricted: "RESTRICTED: read its terms before using",
  unknown: "UNKNOWN: not verified, the user must check it",
};

/** "CC BY 4.0 (attribution required; found via the API, confidence high)". */
export function licenseText(license: LicenseInfo): string {
  return `${license.name} (${STATUS_TEXT[license.status]}; confidence ${license.confidence})`;
}

function sourceText(source: { name: string; trusted: boolean }): string {
  return `${source.name} (${source.trusted ? "trusted source" : "web"})`;
}

function candidateBlock(candidate: AssetCandidate, index: number): string {
  const facts = [
    candidate.author ? `by ${clip(candidate.author, 80)}` : "author unknown",
    candidate.width && candidate.height ? `${candidate.width}×${candidate.height}` : null,
    candidate.duration !== null ? seconds(candidate.duration) : null,
    candidate.bytes !== null ? megabytes(candidate.bytes) : null,
    candidate.contentType,
  ].filter(Boolean);
  const lines = [
    `${index}. id ${candidate.id} · ${candidate.mediaKind} · “${clip(candidate.title, 100)}” · ${sourceText(candidate.source)}`,
    `   license: ${licenseText(candidate.license)} · ${facts.join(" · ")}`,
  ];
  if (candidate.description.trim())
    lines.push(`   ${clip(candidate.description, DESCRIPTION_CHARS)}`);
  if (candidate.pageUrl) lines.push(`   page: ${candidate.pageUrl}`);
  if (candidate.inProject) lines.push(`   already in the project as ${candidate.inProject}`);
  return lines.join("\n");
}

const candidateList = (candidates: readonly AssetCandidate[]): string[] =>
  candidates.map((candidate, index) => candidateBlock(candidate, index + 1));

export function formatSearch(result: AssetSearchResult): string {
  const lines = [
    `Search “${clip(result.query, 100)}” (${result.mediaKind}) under the user's Asset Search policy: ${
      result.mode === "trusted"
        ? "trusted sources only"
        : "any public source (trusted sources first)"
    }. ${result.candidates.length} ${result.candidates.length === 1 ? "candidate" : "candidates"}.`,
  ];
  for (const report of result.searched) {
    lines.push(
      report.error
        ? `- ${report.source.name}: FAILED — ${clip(report.error, 200)}`
        : `- ${report.source.name}: ${report.results} ${report.results === 1 ? "result" : "results"}`,
    );
  }
  const webDown = result.searched.find(
    (report) => report.source.id === WEB_SOURCE_ID && report.error,
  );
  if (webDown) {
    lines.push(
      `The web search backend is temporarily unavailable (${clip(webDown.error ?? "", 160)}), so this result holds trusted sources only — it says nothing about the open web. Use trusted sources or inspect_url on a page you already know, try the web again later in this turn, and say in your report that the open web could not be searched.`,
    );
  }
  for (const blocked of result.blocked) {
    lines.push(
      `- ${blocked.source}: BLOCKED by the user's Asset Search policy — ${clip(blocked.reason, 200)}. Agents cannot change the policy; only the user can, in the Asset Search settings. Do not try another way around it.`,
    );
  }
  for (const note of result.notes) lines.push(`Note: ${clip(note, 240)}`);
  if (result.candidates.length === 0) {
    lines.push(
      "No candidates. Try other words (a synonym, the subject in English), another media kind, or say in the report that nothing suitable was found.",
    );
  } else {
    lines.push(
      "",
      ...candidateList(result.candidates),
      "",
      "Choose by fit to the need, then license (clear > attribution > unknown/restricted); import_asset takes the candidate id.",
    );
  }
  return cap(lines.join("\n"));
}

export function formatInspect(result: InspectUrlResult): string {
  const lines = [
    `Read ${result.finalUrl}${result.finalUrl !== result.url ? ` (from ${result.url})` : ""}${result.title ? ` · “${clip(result.title, 120)}”` : ""} · ${sourceText(result.source)}`,
    `Page license: ${licenseText(result.license)}${result.author ? ` · author ${clip(result.author, 80)}` : ""}`,
  ];
  for (const note of result.notes) lines.push(`Note: ${clip(note, 240)}`);
  if (result.candidates.length === 0) {
    lines.push("The page offers no importable media.");
  } else {
    lines.push(
      `${result.candidates.length} importable ${result.candidates.length === 1 ? "file" : "files"}:`,
      ...candidateList(result.candidates),
    );
  }
  return cap(lines.join("\n"));
}

/** One line of the record an import made: what it is, where it came from, under which license. */
export function provenanceLine(record: AssetProvenance): string {
  return [
    `“${clip(record.title, 100)}”`,
    `${record.source.name} (${record.source.trusted ? "trusted source" : "web"})`,
    `license ${record.license} (${STATUS_TEXT[record.licenseStatus]}; confidence ${record.licenseConfidence})`,
    record.author ? `by ${clip(record.author, 80)}` : "author unknown",
    record.pageUrl ?? record.originalUrl,
  ].join(" · ");
}

export function formatImport(result: ImportAssetResult): string {
  const { provenance } = result;
  const lines: string[] = [];
  if (result.duplicate) {
    lines.push(
      `Already in the project: ${result.asset} (${result.duplicate.reason === "same_url" ? "same URL" : "same content"}); nothing was downloaded or written.`,
    );
  } else {
    lines.push(
      `Imported ${result.asset} (${result.fetch === "cache" ? "from the project's download cache, no network" : "downloaded"}${provenance.converted ? `; converted ${provenance.converted}` : ""}, ${megabytes(provenance.bytes)}).`,
    );
  }
  lines.push(`Source: ${provenanceLine(provenance)}`);
  if (provenance.licenseStatus !== "clear") {
    lines.push(`Credit line: ${provenance.attribution}`);
  }
  if (result.resolved) {
    lines.push(
      `Resolved Missing Asset ${result.resolved.missing} → node ${result.resolved.node} (the story now uses ${result.asset}).`,
    );
  }
  if (result.resolveError) {
    lines.push(
      `The asset is in the project but the Missing Asset node was NOT resolved — ${result.resolveError.code}: ${result.resolveError.message}. The import stands.`,
    );
  }
  for (const warning of result.warnings) lines.push(`Warning: ${clip(warning, 240)}`);
  return cap(lines.join("\n"));
}

export function formatResolve(result: ResolveMissingResult): string {
  return `Resolved Missing Asset ${result.missing} → node ${result.node} with ${result.asset}.`;
}

export function formatSources(view: ProjectSourcesView): string {
  const { summary } = view;
  const lines = [
    `Project sources and licenses (Asset Search mode: ${view.mode}): ${summary.total} imported ${summary.total === 1 ? "asset" : "assets"} — ${summary.clear} clear, ${summary.attribution} need attribution, ${summary.restricted} restricted, ${summary.unknown} unknown${summary.missingFiles > 0 ? `; ${summary.missingFiles} file(s) no longer in the project` : ""}.`,
  ];
  for (const record of view.records) {
    const used = record.usedIn.length > 0 ? `used in ${record.usedIn.join(", ")}` : "not used yet";
    lines.push(
      `- ${record.asset}${record.present ? "" : " (file missing)"} · ${provenanceLine(record)} · ${used}${record.issues.length > 0 ? ` · look at: ${record.issues.join("; ")}` : ""}`,
    );
  }
  if (view.credits.length > 0)
    lines.push("", "Credits:", ...view.credits.map((line) => `- ${line}`));
  return cap(lines.join("\n"));
}

/**
 * What a render appends to its result: the researched assets in the composition that need the user's attention and the
 * credits the video owes. An export is never blocked; the user decides.
 */
export function formatExportCheck(check: ExportLicenseCheck): string {
  if (check.assets.length === 0 && check.warnings.length === 0 && check.credits.length === 0)
    return "";
  const lines: string[] = [];
  if (check.warnings.length > 0) {
    lines.push(
      `License warnings for ${check.composition} (the render is not blocked — tell the user):`,
      ...check.warnings.map(
        (warning) =>
          `- ${warning.asset}: ${warning.license} (${warning.status}) — ${clip(warning.message, 200)}`,
      ),
    );
  } else {
    lines.push(
      `License check for ${check.composition}: ${check.assets.length} researched ${check.assets.length === 1 ? "asset" : "assets"}, no license warnings.`,
    );
  }
  if (check.credits.length > 0)
    lines.push("Credits this video owes:", ...check.credits.map((line) => `- ${line}`));
  return cap(lines.join("\n"), 4_000);
}

/** What the model sees for a failed call: a stable code and the message. */
export function formatResearchError(error: ResearchToolError): string {
  const hint =
    error.code === "blocked_by_policy"
      ? " The user's Asset Search policy does not allow this and agents cannot change it; use an allowed source or report that the user has to widen the policy."
      : error.code === "unknown_candidate"
        ? " Search again to get fresh candidate ids."
        : error.code === "rate_limited"
          ? " The source is rate-limiting this machine: do not retry it in a loop; choose another source or candidate, or report it."
          : "";
  return `${error.code}: ${error.message}${hint}`;
}
