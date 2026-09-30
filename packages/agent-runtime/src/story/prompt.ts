import {
  researchKindOf,
  type MissingAssetNode,
  type StoryAction,
  type StoryActionOptions,
  type StoryView,
} from "@hyperframes/agent-protocol";

const COMMON = `This is a Story Mode turn: the video is planned as the project's Story Graph (read_story), an editable map that the user also reshapes by hand. The user's hand edits are decisions, not mistakes: fields marked "(set by user)", nodes/links/attachments the user created (you may only fill in an empty transition on a link the user made), and links/attachments the user removed outrank your earlier plan; locked nodes are never changed. edit_story refuses a change that would override any of that (locked / user_decision): accept the refusal and plan around it.`;

const PLAN = `Action: plan. Build or revise the graph with edit_story from the cached analysis.
- Long footage: analyze_media (cached — never pass force) and read_analysis/read_transcript; group the semantic segments into chapters with sourceRanges [{source, segments:[...]}], one chapter per narrative beat with a role, purpose, description, estimatedDuration and captions when the user wants them. If the footage has no semantic segmentation yet, have it made first (Editor: read_transcript → save_segments).
- Attach existing project assets (inspect_project) as video, picture and music nodes to the chapters that use them; add motion-graphics nodes using preset names found with browse_presets; add a missing-asset node for material the story needs but the project does not have.
- Connect the chapters in play order (connect/set_order) with short transitions.
- Do not touch the timeline: no edit_timeline, build_rough_cut or render_video in this turn. Reply with the shape of the story and any material the user still has to provide.`;

const REVIEW = `Action: review. The graph below contains the user's manual changes.
- Never restore the previous AI variant: not reorders, not durations, not removed links or attachments, not renamed fields.
- Never change a locked node or its attachments.
- Adapt the UNLOCKED supporting decisions so the story works with the user's changes, and make those edits with edit_story in this turn (do not leave them to the Editor or the build: Build Story plays every chapter's source ranges exactly as they are and never shortens or re-times a chapter). Work through every item under "Needs attention": a chapter whose length the user changed gets source ranges that fit it (read_analysis segments / read_transcript to choose what to keep: drop lower-priority segments of that chapter or switch to sentence ranges), links the user made get a transition that fits the new order, the neighbours' transitions and descriptions follow the new order, attachments (B-roll, graphics, music) are re-fitted, missing-asset nodes are added where the new shape needs material.
- Record the outcome with edit_story set_story.reviewSummary (what changed and why, a few sentences), then reply with only the meaningful changes. If nothing needs to change, say so and still record the review.
- Do not touch the timeline in this turn.`;

const BUILD_REPLACES = `The user asked for a FULL build: build_story must run exactly once in this turn, even when the "Timeline sync" section says the timeline is in sync (a full build is the user's explicit choice, not a sync check). Build Story regenerates EVERY section: the user's manual edits to clips the story generated (trims, moves, volume, ...) are replaced and listed in the result, and the built sections of locked chapters are kept unless the user allowed them for this turn. Clips no chapter owns (manual additions, cutaways) are kept. Report the replaced edits and the kept locked chapters.`;

const BUILD_WITH_EDITOR = `Action: build. Compile the story into the timeline. Delegate the Editor: build_story (pass the version from read_story as baseVersion), then inspect_timeline to verify the timeline matches the graph, and report per chapter (span on the timeline, clips, warnings, missing material). ${BUILD_REPLACES} Do not edit the graph in this turn and never render unless the user asked for a file.`;

const BUILD_ALONE = `Action: build. Compile the story into the timeline yourself: build_story (pass the version from read_story as baseVersion), then inspect_timeline to verify the timeline matches the graph, and report per chapter (span on the timeline, clips, warnings, missing material). ${BUILD_REPLACES} Do not edit the graph in this turn and never render unless the user asked for a file.`;

const REBUILD = `Action: rebuild. Bring the timeline in line with the graph after the user changed it, touching only what changed (Rebuild affected sections). rebuild_story regenerates only the units the graph changed, moves sections that only moved, keeps everything else byte-identical, keeps manual edits to generated clips under the "keep" policy, and never rebuilds a locked chapter without the user's permission. The scope and policy below are the user's choices for this turn; rebuild_story applies them itself and you cannot change them.
- The graph above ends with a "Timeline sync" section (what a rebuild would regenerate, move or keep, the manual edits to generated clips and who made them, locked chapters that stay pending). Call read_story only if you need a fresh version or the graph may have changed.
- Call rebuild_story exactly once, passing the version from read_story as baseVersion (if it is refused as a conflict, read_story and call it again). Do not delegate it, do not edit the graph (no edit_story) and do not touch the timeline any other way: no edit_timeline, build_rough_cut or render_video in this turn.
- If the timeline already matches the graph the result says so and writes nothing: tell the user that and stop.
- Then report, per chapter by title: what was rebuilt, moved or removed; which manual edits were kept or replaced and why (kept: the "keep" policy or a clip locked on the timeline; replaced: the user chose "replace"); the locked chapters that stay pending until the user allows them in the Story workspace; and any warnings. Do not undo or redo anything yourself: the user can Revert this turn.`;

/** The user's options for the turn, stated for the model. */
function optionsText(action: StoryAction | null, options: StoryActionOptions | null): string {
  if (action !== "build" && action !== "rebuild") return "";
  const allowed = options?.allowLocked?.length
    ? `the user allowed these locked chapters to be rebuilt: ${options.allowLocked.join(", ")}`
    : "no locked chapter may be rebuilt (locked chapters stay as they are)";
  if (action === "build") return `Options for this turn: ${allowed}.`;
  const scope = options?.chapters
    ? `only the changed sections of ${options.chapters.length > 0 ? options.chapters.join(", ") : "no chapter"} are regenerated (order changes and removals still apply)`
    : "every affected section is regenerated";
  const policy =
    options?.manualEdits === "replace"
      ? "manual edits to generated clips in a section that must change are REPLACED (the user chose this)"
      : "manual edits to generated clips in a section that must change are KEPT (policy keep)";
  return `Options for this turn: ${scope}; ${policy}; ${allowed}.`;
}

/** What a resolve turn is about: the unlocked Missing Asset nodes the user wants filled. */
export interface ResolveScope {
  /** One line per node, for the model. */
  lines: string[];
  /** Ids the user asked for that are missing from the graph or locked (nothing will be done for them). */
  skipped: string[];
}

/** The Missing Asset nodes a resolve turn covers: the user's list (storyOptions.missing), else every unlocked one. */
export function resolveScope(
  view: StoryView | null,
  options: StoryActionOptions | null,
): ResolveScope {
  const graph = view?.graph ?? null;
  if (!graph) return { lines: [], skipped: options?.missing ?? [] };
  const chosen = options?.missing;
  const missing = graph.nodes.filter(
    (node): node is MissingAssetNode => node.kind === "missing" && !node.locked,
  );
  const inScope = chosen ? missing.filter((node) => chosen.includes(node.id)) : missing;
  const titles = new Map(graph.nodes.map((node) => [node.id, node.title]));
  const lines = inScope.map((node) => {
    const uses = graph.attachments
      .filter((attachment) => attachment.node === node.id)
      .map(
        (attachment) =>
          `${attachment.chapter} “${titles.get(attachment.chapter) ?? attachment.chapter}” (${attachment.placement}${attachment.duration !== null ? `, ${attachment.duration} s` : ""})`,
      );
    return `- ${node.id} “${node.title}” · search for ${researchKindOf(node.mediaKind)} (${node.mediaKind}) · need: ${node.need.replace(/\s+/g, " ").trim() || "not described"}${node.neededDuration !== null ? ` · about ${node.neededDuration} s` : ""} · used in ${uses.join("; ") || "no chapter yet"}`;
  });
  const skipped = chosen ? chosen.filter((id) => !inScope.some((node) => node.id === id)) : [];
  return { lines, skipped };
}

const RESOLVE_RESEARCH = `Action: resolve ("Find missing material"). Research looks for the material of the Missing Asset nodes listed below, within the user's Asset Search policy, imports what fits and resolves each node with it. The scope below is the user's choice for this turn.
- Delegate Research with self-contained tasks: for each node its id, title, media kind, the need text, the needed length and where it is used (the chapters). With more than 4 nodes start several Research tasks of up to 4 nodes each (they queue on Research), then wait_for_agents. Tell Research to import with resolveMissing set to the node id, to report source, author and license for each asset, and to say what it could not find or what the policy blocked.
- Do not edit the graph (no edit_story), do not build or rebuild it, and do not touch the timeline: this turn only brings material into the project and resolves the nodes. You cannot search or import yourself.
- Afterwards read_story to confirm which nodes are resolved, then reply per node: the asset and where it came from (source, author, license and its status), flag any license that is unknown or restricted, and list the nodes that stay missing with the reason (nothing suitable, blocked by the policy, locked). Finish by telling the user to run Build Story (or Rebuild affected sections) to put the new material on the timeline.`;

const RESOLVE_NO_RESEARCH = `Action: resolve ("Find missing material"). Research is not available in this turn (it is disabled in this chat, or Studio could not read the Asset Search policy), and nobody else may look for material outside the project. Do nothing: no delegation, no edit_story, no build, no timeline change. Tell the user why nothing was done and that Research has to be enabled in the chat's agent settings (or that Studio's Asset Search policy could not be read) before missing material can be found.`;

/** The rules block of a story-mode turn for the given action. */
export function storyModeRules(
  action: StoryAction | null,
  editorEnabled: boolean,
  options: StoryActionOptions | null = null,
  resolve: { researchReady: boolean; scope: ResolveScope | null } | null = null,
): string {
  const body =
    action === "review"
      ? REVIEW
      : action === "rebuild"
        ? REBUILD
        : action === "resolve"
          ? resolve?.researchReady
            ? RESOLVE_RESEARCH
            : RESOLVE_NO_RESEARCH
          : action === "build"
            ? editorEnabled
              ? BUILD_WITH_EDITOR
              : BUILD_ALONE
            : PLAN;
  const chosen = optionsText(action, options);
  const scope =
    action === "resolve" && resolve?.researchReady
      ? `\n${resolveScopeText(resolve.scope, options)}`
      : "";
  return `<story-mode action="${action ?? "plan"}">\n${COMMON}\n${body}${chosen ? `\n${chosen}` : ""}${scope}\n</story-mode>`;
}

function resolveScopeText(scope: ResolveScope | null, options: StoryActionOptions | null): string {
  if (!scope) {
    return `Missing Asset nodes to resolve: the story could not be read when the turn started; read_story to see them${options?.missing ? ` (only ${options.missing.join(", ")})` : ""}.`;
  }
  const { lines, skipped } = scope;
  const skippedText =
    skipped.length > 0
      ? `\nNot in scope (locked, already resolved or not found): ${skipped.join(", ")}.`
      : "";
  if (lines.length === 0)
    return `Missing Asset nodes to resolve: none. Tell the user there is nothing to find and stop.${skippedText}`;
  return `Missing Asset nodes to resolve (${lines.length}):\n${lines.join("\n")}${skippedText}`;
}

/** The `<story-graph>` and `<story-mode>` blocks appended to the prompt of a story-mode turn. */
export function renderStoryBlocks(input: {
  action: StoryAction | null;
  editorEnabled: boolean;
  /** The user's choices for a build/rebuild/resolve turn (the Story workspace's dialog), if any. */
  storyOptions: StoryActionOptions | null;
  /** The rendered graph as of the turn's start, or null when the story service could not be read. */
  graph: string | null;
  /** The story as of the turn's start (null when unreadable): a resolve turn lists its Missing Asset nodes. */
  view: StoryView | null;
  /** Research is enabled in the chat and the user's Asset Search policy could be read. */
  researchReady: boolean;
}): string {
  const graph =
    input.graph ??
    "The story could not be read when the turn started; call read_story before doing anything else.";
  const resolve =
    input.action === "resolve"
      ? {
          researchReady: input.researchReady,
          scope: input.view ? resolveScope(input.view, input.storyOptions) : null,
        }
      : null;
  return `<story-graph>\n${graph}\n</story-graph>\n\n${storyModeRules(input.action, input.editorEnabled, input.storyOptions, resolve)}`;
}
