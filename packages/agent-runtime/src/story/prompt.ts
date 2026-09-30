import type { StoryAction, StoryActionOptions } from "@hyperframes/agent-protocol";

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

/** The rules block of a story-mode turn for the given action. */
export function storyModeRules(
  action: StoryAction | null,
  editorEnabled: boolean,
  options: StoryActionOptions | null = null,
): string {
  const body =
    action === "review"
      ? REVIEW
      : action === "rebuild"
        ? REBUILD
        : action === "build"
          ? editorEnabled
            ? BUILD_WITH_EDITOR
            : BUILD_ALONE
          : PLAN;
  const chosen = optionsText(action, options);
  return `<story-mode action="${action ?? "plan"}">\n${COMMON}\n${body}${chosen ? `\n${chosen}` : ""}\n</story-mode>`;
}

/** The `<story-graph>` and `<story-mode>` blocks appended to the prompt of a story-mode turn. */
export function renderStoryBlocks(input: {
  action: StoryAction | null;
  editorEnabled: boolean;
  /** The user's choices for a build/rebuild turn (the Story workspace's dialog), if any. */
  storyOptions: StoryActionOptions | null;
  /** The rendered graph as of the turn's start, or null when the story service could not be read. */
  graph: string | null;
}): string {
  const graph =
    input.graph ??
    "The story could not be read when the turn started; call read_story before doing anything else.";
  return `<story-graph>\n${graph}\n</story-graph>\n\n${storyModeRules(input.action, input.editorEnabled, input.storyOptions)}`;
}
