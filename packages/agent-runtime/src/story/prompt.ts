import type { StoryAction } from "@hyperframes/agent-protocol";

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

const BUILD_WITH_EDITOR = `Action: build. Compile the story into the timeline. Delegate the Editor: build_story (pass the version from read_story as baseVersion), then inspect_timeline to verify the timeline matches the graph, and report per chapter (span on the timeline, clips, warnings, missing material). Do not edit the graph in this turn and never render unless the user asked for a file.`;

const BUILD_ALONE = `Action: build. Compile the story into the timeline yourself: build_story (pass the version from read_story as baseVersion), then inspect_timeline to verify the timeline matches the graph, and report per chapter (span on the timeline, clips, warnings, missing material). Do not edit the graph in this turn and never render unless the user asked for a file.`;

/** The rules block of a story-mode turn for the given action. */
export function storyModeRules(action: StoryAction | null, editorEnabled: boolean): string {
  const body =
    action === "review"
      ? REVIEW
      : action === "build"
        ? editorEnabled
          ? BUILD_WITH_EDITOR
          : BUILD_ALONE
        : PLAN;
  return `<story-mode action="${action ?? "plan"}">\n${COMMON}\n${body}\n</story-mode>`;
}

/** The `<story-graph>` and `<story-mode>` blocks appended to the prompt of a story-mode turn. */
export function renderStoryBlocks(input: {
  action: StoryAction | null;
  editorEnabled: boolean;
  /** The rendered graph as of the turn's start, or null when the story service could not be read. */
  graph: string | null;
}): string {
  const graph =
    input.graph ??
    "The story could not be read when the turn started; call read_story before doing anything else.";
  return `<story-graph>\n${graph}\n</story-graph>\n\n${storyModeRules(input.action, input.editorEnabled)}`;
}
