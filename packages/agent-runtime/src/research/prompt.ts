import {
  RESEARCH_LIMITS,
  WEB_SOURCE_ID,
  type AssetSearchPolicy,
  type StoryAction,
} from "@hyperframes/agent-protocol";

/**
 * The user's Asset Search policy as a turn starts. `unavailable` means Studio could not be asked then: the research
 * tools stay offered and read the policy again on their first call, and the prompts say the policy is unknown.
 */
export type ResearchTurnState =
  | { status: "ready"; policy: AssetSearchPolicy }
  | { status: "unavailable"; reason: string };

const MAX_LISTED_SOURCES = 30;

/**
 * One short line about the websites settings for the agents that may read linked sites (Director, Motion, Research):
 * with a setting off, the tools are still there and a call asks the user in chat. Empty when the policy could not be
 * read (the role prompts cover that) or both settings are already on.
 */
export function websiteAccessLine(state: ResearchTurnState | undefined): string {
  if (!state || state.status !== "ready") return "";
  const { readLinkedPages, fullAccess } = state.policy.websites;
  if (readLinkedPages && fullAccess) return "";
  if (!readLinkedPages)
    return "Reading linked pages is off right now: read_website, get_website_file and record_website are still there, and a call asks the user in chat to allow it — call the tool when the user wants the site's style, its files or a recording; no need to ask them to change Settings.";
  return "Full access to linked sites is off right now: read_website reads a linked site as usual, and get_website_file or record_website ask the user in chat to allow full access — call them when the user wants a file or a recording from the site; no need to ask them to change Settings.";
}

const enabledSources = (policy: AssetSearchPolicy) =>
  policy.sources.filter((source) => source.enabled);

function modeText(policy: AssetSearchPolicy): string {
  return policy.mode === "trusted"
    ? "trusted sources only (nothing outside the enabled trusted sources may be searched, read or downloaded)"
    : `any public source (the enabled trusted sources are searched first; the web backend "${WEB_SOURCE_ID}" and any public http(s) page are allowed too)`;
}

/** The enabled trusted sources, one per line, for the agent that searches (Research, or the Director when Research is off). */
function sourcesList(policy: AssetSearchPolicy): string {
  const enabled = enabledSources(policy);
  if (enabled.length === 0) return "No trusted source is enabled.";
  const listed = enabled
    .slice(0, MAX_LISTED_SOURCES)
    .map(
      (source) =>
        `- ${source.id} · ${source.name} · ${source.kinds.join("/")}${source.licenseNote ? ` · ${source.licenseNote}` : ""}`,
    );
  if (enabled.length > MAX_LISTED_SOURCES)
    listed.push(`- … ${enabled.length - MAX_LISTED_SOURCES} more`);
  return `Enabled trusted sources (use these ids in search_assets "sources"):\n${listed.join("\n")}`;
}

function webSourceText(policy: AssetSearchPolicy): string {
  return policy.mode === "any"
    ? `The web backend (id "${WEB_SOURCE_ID}") and any public http(s) page (inspect_url) are allowed; trusted sources are the better first choice because their license data is structured. When the web backend is temporarily unavailable, a search result says so: then only trusted sources were searched.`
    : `The web backend ("${WEB_SOURCE_ID}") and pages outside the trusted sources are NOT allowed: the Studio server refuses them (blocked_by_policy). Do not ask for them.`;
}

/**
 * The Director's view of research, in the team roster: who can look outside the project and under which policy. With
 * Research on, the Director delegates it; with Research off the work moves to the Director (same tools, same policy,
 * same download approvals). In a rebuild turn nobody has research tools (the single write is `rebuild_story`),
 * whatever the settings say. An unreadable policy does not remove the tools: the first research call reads it again.
 */
export function researchTeamLine(
  researchEnabled: boolean,
  state: ResearchTurnState | undefined,
  action: StoryAction | null,
): string {
  if (action === "rebuild") {
    return 'Research cannot search or import in a Rebuild turn: do not delegate it and do not search yourself. Material from outside the project comes from a normal message, "Find missing material" or a full Build.';
  }
  const unreadable = !state || state.status === "unavailable";
  const unreadableWhy = state?.status === "unavailable" ? ` (${state.reason})` : "";
  if (!researchEnabled) {
    const tools =
      "search_assets, inspect_url, import_asset (with resolveMissing for a Missing Asset node), resolve_missing_asset and read_sources";
    if (unreadable) {
      return `Research is off in this chat, so you do its work yourself with ${tools}. The user's Asset Search policy could not be read at the start of this turn${unreadableWhy}: the tools try again when you call them; if Studio still does not answer, tell the user.`;
    }
    const { policy } = state;
    return `Research is off in this chat, so you do its work yourself with ${tools}, under the user's Asset Search policy: ${modeText(policy)}.
${sourcesList(policy)}
${webSourceText(policy)}
You work as Research would: check the project first (read_sources), search with short concrete words, compare fit then license (clear > attribution > unknown/restricted), import only what will be used, and report every asset's project path, source, author, license with its status and the credit line. A restricted-license asset asks the user for its own approval, at most ${RESEARCH_LIMITS.importsPerTurn} imports per turn, and the same download approval applies to you as to Research. The policy is the user's and cannot be changed by you.`;
  }
  if (unreadable) {
    return `Research is enabled, but the user's Asset Search policy could not be read at the start of this turn${unreadableWhy}: Research's tools try again when it calls them. Delegate as usual; if Research reports that Studio's research service does not answer, tell the user.`;
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
    return `<asset-search-policy status="unavailable">\nStudio could not be asked for the user's Asset Search policy at the start of this turn${state ? ` (${state.reason})` : ""}, so you do not know which sources are enabled. Your tools try again when you call them: search without "sources", and if a call fails with studio_unavailable say so in your report. Do not try to look for material any other way.\n</asset-search-policy>`;
  }
  const { policy } = state;
  const website = websiteAccessLine(state);
  return `<asset-search-policy mode="${policy.mode}">
The user's Asset Search policy: ${modeText(policy)}.
${sourcesList(policy)}
${webSourceText(policy)}
Rules:
- Stay within the policy. The Studio server enforces it on every search, page read and download and you cannot change it; a blocked call is final — report it instead of looking for a way around it.
- Match what is needed: the Missing Asset node's need, its media kind (video/picture/audio) and its neededDuration. Check duration, dimensions and the title/description of a candidate before importing.
- Prefer licenses in this order: clear (public domain/CC0), attribution required (CC BY, CC BY-SA), then unknown or restricted. Take an unknown or restricted one only when nothing better fits, and say so plainly. A restricted license (non-commercial or no-derivatives) always asks the user for that asset in the chat; if they decline, pick another candidate.
- Compare at most ${candidates} candidates per search: search_assets returns at most ${candidates} results per source (this turn's Execution Quality budget; a larger limit is reduced to it). Refine the query instead of asking for more.
- Import only what will be used, at most ${RESEARCH_LIMITS.importsPerTurn} imports in this turn. To fill a Missing Asset node import with "resolveMissing" set to its id (a duplicate is reused, not downloaded twice).
- Never invent or restate license, author or source facts that the tool results do not state; the Studio server records them from the source itself.
- Report for every asset: the project path, the source, the author, the license with its status, the credit line to show, and which node it resolved; and list what you could not find or was blocked, with why.
${website ? `${website}\n` : ""}</asset-search-policy>`;
}
