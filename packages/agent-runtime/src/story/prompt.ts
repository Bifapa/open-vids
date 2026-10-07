import {
  researchKindOf,
  type MissingAssetNode,
  type StoryAction,
  type StoryActionOptions,
  type StoryView,
} from "@hyperframes/agent-protocol";

const COMMON = `This is a Story Mode turn: the video is planned as the project's Story Graph (read_story), an editable map that the user also reshapes by hand. The user's hand edits are decisions, not mistakes: fields marked "(set by user)", nodes/links/attachments the user created (you may only fill in an empty transition on a link the user made), and links/attachments the user removed outrank your earlier plan; locked nodes are never changed. edit_story refuses a change that would override any of that (locked / user_decision): accept the refusal and plan around it.`;

const PICKED_FRAGMENTS = `The user can pick the fragment of a video/audio file the AI may use (inspect_project marks it "USER-PICKED FRAGMENT"): the build places only that fragment, and you never ask to change it unless it cannot work — then explain why.`;

const PLAN = `Action: plan. Build or revise the graph with edit_story from the cached analysis.
- Long footage: analyze_media (cached — never pass force) and read_analysis/read_transcript; group the semantic segments into chapters with sourceRanges [{source, segments:[...]}], one chapter per narrative beat with a role, purpose, description, estimatedDuration and captions when the user wants them. If the footage has no semantic segmentation yet, have it made first (read_transcript → save_segments: the Editor's job, yours when the Editor is off). read_story pages long stories: chapter=<id> reads one chapter in full.
- Attach existing project assets (inspect_project) as video, picture and music nodes to the chapters that use them; add motion-graphics nodes using preset names found with browse_presets; add a missing-asset node for material the story needs but the project does not have.
- Connect the chapters in play order (connect/set_order) with short transitions.
- Do not touch the timeline: no edit_timeline, build_rough_cut or render_video in this turn. Reply with the shape of the story and any material the user still has to provide.`;

const REVIEW = `Action: review. The graph below contains the user's manual changes.
- Never restore the previous AI variant: not reorders, not durations, not removed links or attachments, not renamed fields.
- Never change a locked node or its attachments.
- Adapt the UNLOCKED supporting decisions so the story works with the user's changes, and make those edits with edit_story in this turn (do not leave them to the Editor or the build: Build Story plays every chapter's source ranges as they are, and only when the user set a chapter's length does it trim a clearly longer A-roll proportionally, losing the tail of every piece, so choose what to keep yourself). Work through every item under "Needs attention": a chapter whose length the user changed gets source ranges that fit it (read_analysis segments / read_transcript to choose what to keep: drop lower-priority segments of that chapter or switch to sentence ranges), links the user made get a transition that fits the new order, the neighbours' transitions and descriptions follow the new order, attachments (B-roll, graphics, music) are re-fitted, missing-asset nodes are added where the new shape needs material.
- Record the outcome with edit_story set_story.reviewSummary (what changed and why, a few sentences), then reply with only the meaningful changes. If nothing needs to change, say so and still record the review.
- Do not touch the timeline in this turn.`;

const BUILD_REPLACES = `The user asked for a FULL build: build_story must run exactly once in this turn, even when the "Timeline sync" section says the timeline is in sync (a full build is the user's explicit choice, not a sync check). Build Story regenerates EVERY section: the user's manual edits to clips the story generated (trims, moves, volume, ...) are replaced and listed in the result, and the built sections of locked chapters are kept unless the user allowed them for this turn. Clips no chapter owns (manual additions, cutaways) are kept. Report the replaced edits and the kept locked chapters.`;

/** What changes the build turn's steps: who compiles the graph, and who fetches material (if anyone can). */
interface BuildVariant {
  editorEnabled: boolean;
  /** The runtime has a research host: somebody can fetch material (the Asset Search policy is read on the first call at the latest). */
  researchReady: boolean;
  /** The Research specialist is on: otherwise the Director fetches with the tools it inherits. */
  researchEnabled: boolean;
  /** The runtime has the voiceover host: narrated chapters get their voice generated before the build. */
  voice: boolean;
}

const BUILD_NARRATION = `3. Narration voice. For the chapters whose narration is not empty (read_story shows it as "narration" with whether its voice is generated): if the project has no voice yet, call request_voice_setup first (it offers the project's voice when there is one); then call generate_voiceover ONCE with a line {id: "chapter-<chapterId>", text: <that chapter's narration, word for word>} for every narrated chapter whose voice is not generated yet or whose narration text changed since, in story order. generate_voiceover updates the script: lines you do not pass (other chapters, voiceover lines the project already has) stay as they are, so never pass a line just to keep it. build_story places the voice of the line "chapter-<chapterId>" at the start of its chapter and skips narration whose line has no generated take (warning "narration has no generated voice yet"). Generating is paid and may need the user's approval: wait for it. If the user declines or nothing is generated, go on; the report lists those chapters. Chapters without narration need no voice; never invent narration the user did not ask for. Captions of a narrated chapter follow its narration.`;

const VOICE_PLAN = `- Narration: when the user asks for a narrated video, write each chapter's narration with edit_story (the chapter field "narration": the words the narrator says over that chapter, in the video's language, one text per chapter, no stage directions). A narration the user wrote ("set by user") stays as written. The voice is generated and placed by the Build, never in this turn.`;

const BUILD_PREPARE = `1. Prepare the material. read_story and inspect_project show what the chapters need and what the project has. You may still edit the graph with edit_story in this step (user decisions and locked nodes still rule): add a missing-asset node (mediaKind video / picture / music / sfx, a concrete need, neededDuration) for each piece of material the chapters need and the project lacks — a music bed unless the user said no music (attach it to every chapter it should span: one music node attached to several chapters is one bed across them), the sound effects the chapters call for (attach each to the chapter that uses it, with an offset in seconds from the chapter start and a short duration), and the footage or pictures that the chapter descriptions or bRoll name (attach to the chapters that use them). An asset the project already has is attached to the chapter, not searched for again.`;

const BUILD_FETCH = `2. Fetch what is missing. Delegate Research with self-contained tasks of up to 4 nodes each (for each: node id, title, media kind, the need, the length, the chapters that use it) and tell it to import with resolveMissing set to the node id and to report source, author and license; then wait_for_agents. Build Story places what resolved: a music node resolved this way plays as the bed across its chapters, a resolved sound effect plays inside its chapter. Downloads may need the user's approval: Research's import call then asks them in the chat and WAITS for the answer, so keep waiting — never end the turn to ask. If the user declines, the policy blocks it or nothing fits, go on: the node stays missing and your final report lists it.`;

const BUILD_FETCH_SELF = `2. Fetch what is missing yourself. Research is off in this chat, so its work is yours: for each missing node search_assets with short concrete words for the media kind it needs (read_sources shows what the project already has), check the candidate's license, then import_asset with resolveMissing set to the node id; report source, author and license. Import only what will be used. Build Story places what resolved: a music node resolved this way plays as the bed across its chapters, a resolved sound effect plays inside its chapter. Downloads may need the user's approval: your import call then asks them in the chat and WAITS for the answer, so keep waiting — never end the turn to ask. If the user declines, the policy blocks it or nothing fits, go on: the node stays missing and your final report lists it.`;

const BUILD_NO_FETCH = `2. Outside material cannot be fetched in this turn: Studio's research service is not available, so nobody may look outside the project. Do not search. Build with the material that exists; at the end list, per missing node, what the user has to add to the project and that a Build Story after that completes the video.`;

const BUILD_FROZEN = `After the build the graph is frozen for the rest of the turn: edit_story and resolving Missing Asset nodes are refused. Material that turns up later is imported without resolveMissing and placed on the timeline with edit_timeline.`;

function buildRules({
  editorEnabled,
  researchReady,
  researchEnabled,
  voice,
}: BuildVariant): string {
  const builder = editorEnabled
    ? "Delegate the Editor: build_story"
    : "Compile the story yourself: build_story";
  const fetch = researchReady ? (researchEnabled ? BUILD_FETCH : BUILD_FETCH_SELF) : BUILD_NO_FETCH;
  const finishers =
    "(a specialist that is off in this chat is not delegated to: you do its part yourself)";
  const narration = voice ? `\n${BUILD_NARRATION}` : "";
  // The narration step shifts the numbers of the steps after it.
  const [build, motion, mix, verify] = voice ? [4, 5, 6, 7] : [3, 4, 5, 6];
  const ducking = voice
    ? " The narration clips (the voiceover audio group) are speech too: duck the music under them (duck_audio) and keep the sound effects clear of the words."
    : "";
  return `Action: build ("Build the video"). The user expects a finished, watchable video with sound — picture, motion graphics, music and sound effects — produced in this one turn, not a silent draft. Work through the steps in order; skip a step only when there is nothing to do in it.
${BUILD_PREPARE}
${fetch}${narration}
${build}. Build. ${builder} exactly once (pass the version from read_story as baseVersion), then inspect_timeline to see the spans, clips and warnings. ${BUILD_REPLACES} ${BUILD_FROZEN} ${PICKED_FRAGMENTS}
${motion}. Motion graphics. Delegate Motion for the scenes and titles the build cannot generate (title cards, lower thirds, the graphics the chapters describe), placed on the chapter spans from the build result ${finishers}.
${mix}. Final sound mix. Delegate Audio for the mix ${finishers}: music about 0.2–0.4 under speech and lower under sound effects, a 1–2 s fade in at the start and fade out at the end of the video, sound effects on the beats they belong to.${ducking} Make sure every chapter that needs sound has it.
${verify}. Verify with inspect_timeline, then report per chapter by title: its span, picture, graphics and sound; warnings; the manual edits replaced and the locked chapters kept; every outside asset added with source and license (flag unknown or restricted licenses); and what is still missing and what the user must do about it. Never render unless the user asked for a file: the runtime's Render QA checks the result.`;
}

const REBUILD = `Action: rebuild. Bring the timeline in line with the graph after the user changed it, touching only what changed (Rebuild affected sections). rebuild_story regenerates only the units the graph changed, moves sections that only moved, keeps everything else byte-identical, keeps manual edits to generated clips under the "keep" policy, and never rebuilds a locked chapter without the user's permission. The scope and policy below are the user's choices for this turn; rebuild_story applies them itself and you cannot change them.
- The graph above ends with a "Timeline sync" section (what a rebuild would regenerate, move or keep, the manual edits to generated clips and who made them, locked chapters that stay pending). Call read_story only if you need a fresh version or the graph may have changed.
- Call rebuild_story exactly once, passing the version from read_story as baseVersion (if it is refused as a conflict, read_story and call it again). Do not delegate it, do not edit the graph (no edit_story) and do not touch the timeline any other way: no edit_timeline, build_rough_cut or render_video in this turn. Research cannot search or import in a rebuild turn: do not delegate it; material comes from a normal message, "Find missing material" or a full Build, and a Missing Asset node that is still unresolved stays missing (say so in the report).
- If the timeline already matches the graph the result says so and writes nothing: tell the user that and stop.
- If rebuild_story is refused as unsupported (the story was never built, or its timeline was built before sync tracking existed), do not retry and do not work around it: a full Build Story is the way forward, and it replaces the manual edits to generated clips. Say so, propose it to the user (they start it from the Story workspace) and stop.
- Then report, per chapter by title: what was rebuilt, moved or removed; which manual edits were kept or replaced and why (kept: the "keep" policy or a clip locked on the timeline; replaced: the user chose "replace"); the locked chapters that stay pending until the user allows them in the Story workspace; and any warnings. Do not undo or redo anything yourself: the user can Revert this turn. ${PICKED_FRAGMENTS}`;

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
- Do not edit the graph (no edit_story), do not build or rebuild it, and do not touch the timeline: this turn only brings material into the project and resolves the nodes. You do not search or import yourself: Research does.
- Afterwards read_story to confirm which nodes are resolved, then reply per node: the asset and where it came from (source, author, license and its status), flag any license that is unknown or restricted, and list the nodes that stay missing with the reason (nothing suitable, blocked by the policy, locked). Finish by telling the user to run Build Story (or Rebuild affected sections) to put the new material on the timeline.`;

const RESOLVE_SELF = `Action: resolve ("Find missing material"). Research is off in this chat, so you do its work yourself, within the user's Asset Search policy: you look for the material of the Missing Asset nodes listed below, import what fits and resolve each node with it. The scope below is the user's choice for this turn.
- For each node: search_assets with short concrete words for the media kind it needs (read_sources shows what the project already has and where it came from; an asset the project already has is resolved with resolve_missing_asset, not searched for again), look at the candidates' license (inspect_url when a page needs a closer look), then import_asset with resolveMissing set to the node id. Import only what will be used. Report source, author and license for each asset, and say what you could not find or what the policy blocked. A download may need the user's approval: the import call then asks them in the chat and WAITS for the answer, so keep waiting — never end the turn to ask. If they decline, the policy blocks it or nothing fits, the node stays missing.
- Do not edit the graph (no edit_story), do not build or rebuild it, and do not touch the timeline: this turn only brings material into the project and resolves the nodes.
- Afterwards read_story to confirm which nodes are resolved, then reply per node: the asset and where it came from (source, author, license and its status), flag any license that is unknown or restricted, and list the nodes that stay missing with the reason (nothing suitable, blocked by the policy, locked). Finish by telling the user to run Build Story (or Rebuild affected sections) to put the new material on the timeline.`;

const RESOLVE_NO_RESEARCH = `Action: resolve ("Find missing material"). Studio's research service is not available in this turn, so nobody may look for material outside the project. Do nothing: no delegation, no edit_story, no build, no timeline change. Tell the user why nothing was done and that the research service has to be available (try again in a moment) before missing material can be found.`;

/** What the rules need to know about Research: whether it can work this turn, and the resolve turn's scope. */
export interface StoryResearch {
  researchReady: boolean;
  /** The Research specialist is on in this chat: otherwise the Director does its work with the tools it inherits. */
  researchEnabled: boolean;
  scope: ResolveScope | null;
}

/** The rules block of a story-mode turn for the given action. */
export function storyModeRules(
  action: StoryAction | null,
  editorEnabled: boolean,
  options: StoryActionOptions | null,
  research: StoryResearch,
  voice = false,
): string {
  const { researchReady, researchEnabled } = research;
  const body =
    action === "review"
      ? `${REVIEW}${voice ? `\n${VOICE_PLAN}` : ""}`
      : action === "rebuild"
        ? REBUILD
        : action === "resolve"
          ? researchReady
            ? researchEnabled
              ? RESOLVE_RESEARCH
              : RESOLVE_SELF
            : RESOLVE_NO_RESEARCH
          : action === "build"
            ? buildRules({ editorEnabled, researchReady, researchEnabled, voice })
            : `${PLAN}${voice ? `\n${VOICE_PLAN}` : ""}`;
  const chosen = optionsText(action, options);
  const scope =
    action === "resolve" && researchReady ? `\n${resolveScopeText(research.scope, options)}` : "";
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
  /** The runtime has a research host (the user's Asset Search policy is read on the first call at the latest): material can be fetched. */
  researchReady: boolean;
  /** The Research specialist is on in this chat: otherwise the Director fetches material itself. */
  researchEnabled: boolean;
  /** The runtime has the voiceover host: narration steps appear in the rules. */
  voice?: boolean;
}): string {
  const graph =
    input.graph ??
    "The story could not be read when the turn started; call read_story before doing anything else.";
  const research: StoryResearch = {
    researchReady: input.researchReady,
    researchEnabled: input.researchEnabled,
    scope:
      input.action === "resolve" && input.view
        ? resolveScope(input.view, input.storyOptions)
        : null,
  };
  return `<story-graph>\n${graph}\n</story-graph>\n\n${storyModeRules(input.action, input.editorEnabled, input.storyOptions, research, input.voice === true)}`;
}
