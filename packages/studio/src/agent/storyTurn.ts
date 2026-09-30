import type {
  EditorContext,
  StartTurnRequest,
  StoryAction,
  StoryActionOptions,
} from "@hyperframes/agent-protocol";

/** Short on purpose: the story action itself tells the agent what to do. */
const STORY_ACTION_PROMPTS: Record<StoryAction, string> = {
  review: "Review the story",
  build: "Build the story",
  rebuild: "Rebuild the affected story sections",
  resolve: "Find the missing material",
};

/** The options without empty lists; null when nothing is left, so the request carries no `storyOptions`. */
function compactOptions(options: StoryActionOptions | undefined): StoryActionOptions | null {
  if (!options) return null;
  const compact: StoryActionOptions = {};
  if (options.chapters && options.chapters.length > 0) compact.chapters = options.chapters;
  if (options.manualEdits) compact.manualEdits = options.manualEdits;
  if (options.allowLocked && options.allowLocked.length > 0)
    compact.allowLocked = options.allowLocked;
  if (options.missing && options.missing.length > 0) compact.missing = options.missing;
  return Object.keys(compact).length > 0 ? compact : null;
}

/** The story-mode turn a Story workspace action starts. */
export function storyTurnRequest(
  action: StoryAction,
  options: StoryActionOptions | undefined,
  editorContext: EditorContext | undefined,
): StartTurnRequest {
  const storyOptions = compactOptions(options);
  return {
    prompt: STORY_ACTION_PROMPTS[action],
    mode: "story",
    storyAction: action,
    ...(storyOptions && { storyOptions }),
    editorContext,
  };
}
