import { WEB_SOURCE_ID, type AssetSearchPolicy } from "@hyperframes/agent-protocol";

/**
 * The user's Asset Search policy as a turn starts. `unavailable` means Studio could not be asked: research then fails
 * closed (nobody gets a research tool) and the Director says so instead of guessing.
 */
export type ResearchTurnState =
  | { status: "ready"; policy: AssetSearchPolicy }
  | { status: "unavailable"; reason: string };

const MAX_LISTED_SOURCES = 30;

const enabledSources = (policy: AssetSearchPolicy) =>
  policy.sources.filter((source) => source.enabled);

function modeText(policy: AssetSearchPolicy): string {
  return policy.mode === "trusted"
    ? "trusted sources only (nothing outside the enabled trusted sources may be searched, read or downloaded)"
    : `any public source (the enabled trusted sources are searched first; the web backend "${WEB_SOURCE_ID}" and any public http(s) page are allowed too)`;
}

/**
 * The Director's view of research, in the team roster: who can look outside the project and under which policy. The
 * Director never searches; it delegates to Research and tells the user when Research is off.
 */
export function researchTeamLine(
  researchEnabled: boolean,
  state: ResearchTurnState | undefined,
): string {
  if (!researchEnabled) {
    return "Research is disabled in this chat: nobody can look for material outside the project. If the user needs outside video, pictures or audio, tell them to enable Research in the chat's agent settings.";
  }
  if (!state || state.status === "unavailable") {
    return `Research is enabled, but the user's Asset Search policy could not be read${state ? ` (${state.reason})` : ""}, so research is unavailable this turn: do not delegate searches; tell the user.`;
  }
  const { policy } = state;
  const enabled = enabledSources(policy);
  const sources = `${enabled.length} trusted ${enabled.length === 1 ? "source" : "sources"} enabled`;
  return `Material from outside the project comes only from Research, under the user's Asset Search policy: ${policy.mode === "trusted" ? "trusted sources only" : "any public source"}, ${sources}${policy.mode === "trusted" && enabled.length === 0 ? " (so nothing can be searched until the user enables a source)" : ""}. You never search or import yourself; delegate a self-contained task to Research (what is needed, kind, length, where it is used) and read_sources shows what the project already has and its licenses. The policy is the user's: neither you nor Research can change it.`;
}

/**
 * The block Research gets with every task: the policy in force and how to work within it. `candidates` is the turn's
 * Execution Quality budget: how many candidates Research compares per search (the tool clamps `limit` to it).
 */
export function renderResearchBlock(
  state: ResearchTurnState | undefined,
  candidates: number,
): string {
  if (!state || state.status === "unavailable") {
    return `<asset-search-policy status="unavailable">\nStudio could not be asked for the user's Asset Search policy${state ? ` (${state.reason})` : ""}, so you have no search tools this turn. Say so in your report; do not try to look for material any other way.\n</asset-search-policy>`;
  }
  const { policy } = state;
  const enabled = enabledSources(policy);
  const listed = enabled
    .slice(0, MAX_LISTED_SOURCES)
    .map(
      (source) =>
        `- ${source.id} · ${source.name} · ${source.kinds.join("/")}${source.licenseNote ? ` · ${source.licenseNote}` : ""}`,
    );
  if (enabled.length > MAX_LISTED_SOURCES)
    listed.push(`- … ${enabled.length - MAX_LISTED_SOURCES} more`);
  const sourcesText =
    enabled.length > 0
      ? `Enabled trusted sources (use these ids in search_assets "sources"):\n${listed.join("\n")}`
      : "No trusted source is enabled.";
  const webText =
    policy.mode === "any"
      ? `The web backend (id "${WEB_SOURCE_ID}") and any public http(s) page (inspect_url) are allowed; trusted sources are the better first choice because their license data is structured.`
      : `The web backend ("${WEB_SOURCE_ID}") and pages outside the trusted sources are NOT allowed: the Studio server refuses them (blocked_by_policy). Do not ask for them.`;
  return `<asset-search-policy mode="${policy.mode}">
The user's Asset Search policy: ${modeText(policy)}.
${sourcesText}
${webText}
Rules:
- Stay within the policy. The Studio server enforces it on every search, page read and download and you cannot change it; a blocked call is final — report it instead of looking for a way around it.
- Match what is needed: the Missing Asset node's need, its media kind (video/picture/audio) and its neededDuration. Check duration, dimensions and the title/description of a candidate before importing.
- Prefer licenses in this order: clear (public domain/CC0), attribution required (CC BY, CC BY-SA), then unknown or restricted. Take an unknown or restricted one only when nothing better fits, and say so plainly.
- Compare at most ${candidates} candidates per search: search_assets returns at most ${candidates} results per source (this turn's Execution Quality budget; a larger limit is reduced to it). Refine the query instead of asking for more.
- Import only what will be used. To fill a Missing Asset node import with "resolveMissing" set to its id (a duplicate is reused, not downloaded twice).
- Never invent or restate license, author or source facts that the tool results do not state; the Studio server records them from the source itself.
- Report for every asset: the project path, the source, the author, the license with its status, the credit line to show, and which node it resolved; and list what you could not find or was blocked, with why.
</asset-search-policy>`;
}
