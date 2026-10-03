import {
  ATTACHMENT_PLACEMENTS,
  CHAPTER_STATUSES,
  MISSING_MEDIA_KINDS,
  STORY_LIMITS,
  STORY_NARRATIVE_ROLES,
  STORY_NODE_KINDS,
  STORY_OPERATION_NAMES,
  isRecord,
  type AgentId,
  type ChatMode,
  type SpecialistId,
  type StoryAction,
  type StoryOperationName,
} from "@hyperframes/agent-protocol";
import type { HostTool, HostToolResult, ToolActivity } from "../backend.js";

export const STORY_TOOL_NAMES = {
  read: "read_story",
  edit: "edit_story",
  build: "build_story",
  rebuild: "rebuild_story",
} as const;

export type StoryToolName = (typeof STORY_TOOL_NAMES)[keyof typeof STORY_TOOL_NAMES];

export function isStoryToolName(name: string): name is StoryToolName {
  return Object.values<string>(STORY_TOOL_NAMES).includes(name);
}

type Executor = (name: string, args: unknown, signal: AbortSignal) => Promise<HostToolResult>;

/** The mode of the turn the tools are built for. */
export interface StoryTurnMode {
  mode: ChatMode;
  /** The Story workspace action the turn runs (`review`, `build`, `rebuild`), if any. */
  action: StoryAction | null;
}

/** Whether the turn may write the timeline: every turn except a story-mode turn that is not a build. */
export function timelineWritesAllowed({ mode, action }: StoryTurnMode): boolean {
  return mode !== "story" || action === "build";
}

/**
 * Which story tools an agent gets. Everyone on the team can read the story, in any mode. The Director edits it in
 * story-mode turns that plan or review it; the turn that builds it gives `build_story` to the Editor, or to the
 * Director when there is no Editor, and freezes the graph while it compiles. A rebuild turn gives `rebuild_story` to the
 * Director alone (the user's scope and policy are fixed by the turn) and freezes the graph too. A resolve turn is
 * Research's (see research/tools.ts): everyone may read the story but nobody edits it, builds it or rebuilds it there.
 * Jev gets none.
 */
export function storyToolsFor(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  turn: StoryTurnMode,
): StoryToolName[] {
  const { read, edit, build, rebuild } = STORY_TOOL_NAMES;
  if (agent === "jev") return [];
  const tools: StoryToolName[] = [read];
  if (
    agent === "director" &&
    turn.mode === "story" &&
    turn.action !== "build" &&
    turn.action !== "rebuild" &&
    turn.action !== "resolve"
  )
    tools.push(edit);
  if (agent === "director" && turn.action === "rebuild") tools.push(rebuild);
  if (
    turn.action === "build" &&
    (agent === "editor" || (agent === "director" && !enabled.includes("editor")))
  )
    tools.push(build);
  return tools;
}

// ── Descriptions ─────────────────────────────────────────────────────────────

const STORY_MODEL = `The Story Graph is the project's plan of the video, an editable map the user also reshapes by hand in the Story workspace. Chapters (narrative roles: ${STORY_NARRATIVE_ROLES.join(", ")}) play in a sequence; "sequence links" connect a chapter to the one that plays next (a chapter has at most one next and one previous, no loops). Material nodes — video, picture, music, motion (a motion-graphics preset) and missing (material that does not exist yet) — are attached to the chapters that use them (an attachment has a placement start/middle/end/throughout, an optional offset and duration); a music node attached to several chapters plays across all of them. Node ids (ch1, v2, ...) are stable.`;

const USER_PRECEDENCE = `What the user did by hand outranks your earlier plan: fields in "User decisions" (marked "(set by user)") keep their values, nodes/links/attachments the user created stay, and links/attachments the user removed stay removed. Locked nodes (and their attachments) are never changed. A change that would override any of this is refused with user_decision or locked — accept it and plan around it.`;

const DESCRIPTIONS: Record<StoryToolName, string> = {
  read_story: `Read the project's Story Graph as text: title, brief and version, the play order, every chapter (role, estimated length — marked "(set by user)" when the user chose it —, the length of its cleaned A-roll material, source ranges, captions, attachments, where it sits on the timeline if the story was built), the materials, the sequence links and who made them, a "User decisions" section (everything the user set by hand, created or removed) and the locked nodes. Read it before planning, reviewing or building, and again after edits to verify. ${STORY_MODEL} ${USER_PRECEDENCE}`,
  edit_story: `Change the Story Graph with a batch of operations. The batch is atomic: if any operation is refused nothing is written and the error names the failing operation (operations[N]) and its code. Creates the story when none exists. Operations run in order; a node added with "ref" can be named as "@ref" later in the same batch (ids of new nodes are returned). Pass baseVersion (from read_story) to refuse the batch when the graph changed since. You never set canvas positions: new nodes are laid out for you and existing ones never move. The change appears on the Story canvas by itself and belongs to this turn's checkpoint, so the user can revert it. ${STORY_MODEL} ${USER_PRECEDENCE}
Operations (each has "op" plus):
- add_node: node {kind, ...fields}, optional ref. chapter fields: title (required), purpose, description, narrativeRole, estimatedDuration (s), status, sourceRanges, aRoll/bRoll/graphics/audio (intent text), captions (true = word-synced captions on build). video: title, asset (an existing project path), sourceIn, sourceOut, usageIntent. picture: title, asset, usageIntent. music: title, asset (or null = only an intent), bpm, volume (0–1 under speech, about 0.2–0.4), usageIntent. motion: title, preset (a name from browse_presets), skill, inputs, duration, usageIntent. missing: title, mediaKind (${MISSING_MEDIA_KINDS.join("/")}), need (what is wanted), neededDuration.
- sourceRanges (A-roll of a chapter, in play order) are given as {source, segments:["g3","g4"]} (whole analysis segments — the normal way for long footage), {source, firstSentence:"s12", lastSentence:"s19"} or {source, from, to} in source seconds. The service resolves them to times; the source must be analyzed for segments/sentences (analyze_media; it is cached).
- update_node: id, set {fields of that node's kind}.
- remove_node: id (its links and attachments go with it).
- connect: from, to (chapters), optional transition — adds a sequence link, or changes the transition text of an existing one. disconnect: from, to.
- set_order: chapters [every chapter id, once, in play order] — rewires the whole sequence.
- attach: node, chapter, optional placement, offset (seconds from the chapter start; overrides placement), duration. detach: node, chapter.
- resolve_missing: id (a Missing Asset node), asset (an existing project media file), optional title, usageIntent, sourceIn, sourceOut — replaces the Missing Asset node with a video/picture/music node for that file, keeping its attachments and remembering what it resolved. To find material outside the project delegate Research instead (import_asset resolves the node itself).
- set_story: title, brief, captionPreset, composition, reviewSummary (records the result of a review).`,
  build_story: `Build the Story Graph into the real timeline as ONE atomic edit — the FULL build: every chapter's section is regenerated. Chapters are laid back to back in play order; each chapter's A-roll is its source ranges cleaned like a rough cut (bad takes, fillers and long pauses removed), B-roll/pictures/graphics/music attached to it are placed on their own tracks, captions are written for chapters that want them, and every created clip remembers the story node it was built for. Earlier story clips and the raw A-roll of the story's sources are replaced, and so are the user's manual edits to clips the story generated (trims, moves, volume, ...) — they are listed in the result as replaced edits. The built sections of locked chapters are kept as they are unless the user allowed them for this turn (you cannot allow them yourself); every other clip (manual additions, cutaways) is kept and reported. Returns the span of each chapter, what was replaced/kept, the replaced edits, the locked chapters that were kept, and warnings (missing material, unanalyzed sources). Pass baseVersion (from read_story) to refuse the build when the graph changed since you read it. The change belongs to this turn's checkpoint, so the user can revert it. Placed media respects the user's picked fragments (inspect_project: "USER-PICKED FRAGMENT"): only the picked part of a file is ever used. Verify afterwards with inspect_timeline. Pass dryRun true to see the result without writing anything.`,
  rebuild_story: `Rebuild affected sections: bring the timeline in line with the Story Graph after the graph changed since it was built, touching only what changed. It regenerates only the units (a chapter's A-roll, one attached B-roll/picture/motion, a music bed, captions) whose intent the graph changed, adds the sections of new chapters and removes the sections of deleted ones, moves sections that only moved (new order, or an earlier section changed length) with their content untouched, and keeps everything else byte-identical. Manual edits the user or an AI made to generated clips are kept in a unit that has to change unless the user chose to replace them for this turn; clips no chapter owns (manual additions, cutaways) are never removed and move with the section they sit in. Locked chapters are never regenerated unless the user allowed them from the Story workspace (you cannot allow them yourself); they may still move in time as a whole and are reported as pending. The scope (chapters), the manual-edit policy and the locked permissions come from the user's choices for this turn and cannot be widened. If the timeline already matches the graph nothing is written. Returns what was rebuilt, removed and moved by chapter, the kept and replaced manual edits, the locked chapters left pending and warnings. Pass baseVersion (from read_story) to refuse the rebuild when the graph changed since you read it. The change belongs to this turn's checkpoint, so the user can revert it. Placed media respects the user's picked fragments (inspect_project: "USER-PICKED FRAGMENT"): only the picked part of a file is ever used. Pass dryRun true to see the result without writing anything.`,
};

// ── Schemas ──────────────────────────────────────────────────────────────────

const str = (description: string, maxLength?: number) => ({
  type: "string",
  description,
  ...(maxLength !== undefined && { maxLength }),
});
const seconds = (description: string) => ({
  type: "number",
  minimum: 0,
  maximum: STORY_LIMITS.maxTime,
  description,
});
const positive = (description: string) => ({
  type: "number",
  exclusiveMinimum: 0,
  maximum: STORY_LIMITS.maxTime,
  description,
});
const nullable = (schema: Record<string, unknown>) => ({
  ...schema,
  type: [schema.type, "null"],
});
const nodeId = str("A node id from read_story, or @ref of a node added earlier in this batch.", 66);
const text = (description: string) => str(description, STORY_LIMITS.textChars);

const rangeInput = {
  anyOf: [
    {
      type: "object",
      description: "Whole analysis segments of a source, in this order.",
      properties: {
        source: str("Project-relative media path.", STORY_LIMITS.pathChars),
        segments: {
          type: "array",
          minItems: 1,
          maxItems: STORY_LIMITS.sourceRanges,
          items: str("Segment id such as g3.", STORY_LIMITS.idChars),
        },
      },
      required: ["source", "segments"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "Transcript sentences from firstSentence through lastSentence.",
      properties: {
        source: str("Project-relative media path.", STORY_LIMITS.pathChars),
        firstSentence: str("Sentence id such as s12.", STORY_LIMITS.idChars),
        lastSentence: str("Sentence id such as s19.", STORY_LIMITS.idChars),
      },
      required: ["source", "firstSentence", "lastSentence"],
      additionalProperties: false,
    },
    {
      type: "object",
      description: "An explicit range of the source, in seconds of the SOURCE file.",
      properties: {
        source: str("Project-relative media path.", STORY_LIMITS.pathChars),
        from: seconds("In-point, seconds of the source."),
        to: positive("Out-point, seconds of the source; after from."),
      },
      required: ["source", "from", "to"],
      additionalProperties: false,
    },
  ],
};

const frameRef = {
  type: ["object", "null"],
  description: "The frame the card shows: a time in a source file.",
  properties: {
    source: str("Project-relative video path.", STORY_LIMITS.pathChars),
    time: seconds("Seconds of the source."),
  },
  required: ["source", "time"],
  additionalProperties: false,
};

const title = str("Short title.", STORY_LIMITS.titleChars);

const FIELD_SCHEMAS: Record<string, Record<string, unknown>> = {
  chapter: {
    title,
    purpose: text("What the chapter is for in the story."),
    description: text("What happens in the chapter."),
    narrativeRole: { type: "string", enum: [...STORY_NARRATIVE_ROLES] },
    estimatedDuration: positive("Intended length on the timeline, seconds."),
    status: { type: "string", enum: [...CHAPTER_STATUSES] },
    sourceRanges: {
      type: "array",
      maxItems: STORY_LIMITS.sourceRanges,
      description: "A-roll material in play order (replaces the chapter's ranges).",
      items: rangeInput,
    },
    aRoll: text("A-roll intent: who or what carries the chapter."),
    bRoll: text("B-roll intent (the concrete clips are attached video/picture nodes)."),
    captions: { type: "boolean", description: "Word-synced captions for this chapter." },
    graphics: text("Graphics intent (the concrete graphics are attached motion nodes)."),
    audio: text("Audio intent (the concrete music is an attached music node)."),
    previewFrame: frameRef,
  },
  video: {
    title,
    asset: str("Existing project-relative video path.", STORY_LIMITS.pathChars),
    sourceIn: seconds("In-point in the file, seconds."),
    sourceOut: nullable(positive("Out-point in the file; null = to the end.")),
    usageIntent: text("What the clip is used for."),
    previewFrame: frameRef,
  },
  picture: {
    title,
    asset: str("Existing project-relative image path.", STORY_LIMITS.pathChars),
    usageIntent: text("What the picture is used for."),
  },
  music: {
    title,
    asset: { type: ["string", "null"], description: "Existing audio path; null = only an intent." },
    bpm: nullable({ type: "number", minimum: 20, maximum: 400, description: "Tempo." }),
    volume: { type: "number", minimum: 0, maximum: 1, description: "Gain under speech." },
    usageIntent: text("Where and why the music plays."),
  },
  motion: {
    title,
    preset: str("Block/component name from browse_presets.", STORY_LIMITS.titleChars),
    skill: { type: ["string", "null"], description: "Skill the preset comes from, if known." },
    inputs: {
      type: "object",
      description: "Preset inputs as text values.",
      additionalProperties: str("Value.", STORY_LIMITS.inputChars),
    },
    duration: nullable(positive("Length on the timeline; null = the preset's natural length.")),
    usageIntent: text("What the graphic shows."),
  },
  missing: {
    title,
    mediaKind: { type: "string", enum: [...MISSING_MEDIA_KINDS] },
    need: text("What material is needed, concretely."),
    neededDuration: nullable(positive("Length needed, seconds.")),
  },
};

const REQUIRED_FIELDS: Record<string, string[]> = {
  chapter: ["title"],
  video: ["title", "asset"],
  picture: ["title", "asset"],
  music: ["title"],
  motion: ["title", "preset"],
  missing: ["title", "need"],
};

const nodeSchema = {
  anyOf: STORY_NODE_KINDS.map((kind) => ({
    type: "object",
    properties: { kind: { type: "string", enum: [kind] }, ...FIELD_SCHEMAS[kind] },
    required: ["kind", ...(REQUIRED_FIELDS[kind] ?? [])],
    additionalProperties: false,
  })),
};

/** An update may carry the fields of any one kind; the service checks them against the node's real kind. */
const updateFields = {
  type: "object",
  description: "Fields to change (only those of the node's kind); at least one.",
  properties: Object.fromEntries(Object.values(FIELD_SCHEMAS).flatMap(Object.entries)),
  minProperties: 1,
  additionalProperties: false,
};

function operationSchema(
  op: StoryOperationName,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
) {
  return {
    type: "object",
    description,
    properties: { op: { type: "string", enum: [op] }, ...properties },
    required: ["op", ...required],
    additionalProperties: false,
  };
}

const OPERATION_SCHEMAS: Record<StoryOperationName, Record<string, unknown>> = {
  add_node: operationSchema(
    "add_node",
    "Add a chapter or a material node.",
    {
      ref: str("Name to refer to this node as @ref later in the batch.", STORY_LIMITS.idChars),
      node: nodeSchema,
    },
    ["node"],
  ),
  update_node: operationSchema(
    "update_node",
    "Change fields of a node.",
    { id: nodeId, set: updateFields },
    ["id", "set"],
  ),
  remove_node: operationSchema("remove_node", "Remove a node with its links.", { id: nodeId }, [
    "id",
  ]),
  connect: operationSchema(
    "connect",
    "Make `to` play right after `from` (both chapters), or change the transition of that link.",
    {
      from: nodeId,
      to: nodeId,
      transition: text("How the story moves on, e.g. 'match cut on the keyboard'."),
    },
    ["from", "to"],
  ),
  disconnect: operationSchema(
    "disconnect",
    "Remove the sequence link from → to.",
    { from: nodeId, to: nodeId },
    ["from", "to"],
  ),
  set_order: operationSchema(
    "set_order",
    "Rewire the sequence so the chapters play in exactly this order.",
    {
      chapters: {
        type: "array",
        minItems: 1,
        maxItems: STORY_LIMITS.nodes,
        description: "Every chapter id, once, in play order.",
        items: nodeId,
      },
    },
    ["chapters"],
  ),
  attach: operationSchema(
    "attach",
    "Use a material node in a chapter (or change the placement of an existing attachment).",
    {
      node: nodeId,
      chapter: nodeId,
      placement: { type: "string", enum: [...ATTACHMENT_PLACEMENTS] },
      offset: nullable(seconds("Seconds from the chapter start; overrides placement.")),
      duration: nullable(positive("Seconds on the timeline; null = the material's own length.")),
    },
    ["node", "chapter"],
  ),
  detach: operationSchema(
    "detach",
    "Stop using a material node in a chapter.",
    { node: nodeId, chapter: nodeId },
    ["node", "chapter"],
  ),
  set_story: operationSchema(
    "set_story",
    "Change the story's own fields.",
    {
      title: str("Story title.", STORY_LIMITS.titleChars),
      brief: text("The user's goal for the video."),
      captionPreset: { type: ["string", "null"], description: "Caption preset name." },
      composition: { type: ["string", "null"], description: "Composition the story builds into." },
      reviewSummary: text(
        "What the review changed and why, in a few sentences (shown on the canvas).",
      ),
    },
    [],
  ),
  resolve_missing: operationSchema(
    "resolve_missing",
    "Replace a Missing Asset node with a concrete node for a media file that is already in the project.",
    {
      id: nodeId,
      asset: str("Project-relative path of the media file.", STORY_LIMITS.pathChars),
      title: str(
        "Title of the new node (default: the missing node's title).",
        STORY_LIMITS.titleChars,
      ),
      usageIntent: text("What the material is used for."),
      sourceIn: seconds("video: in-point in the file, seconds."),
      sourceOut: nullable(positive("video: out-point in the file; null = to the end.")),
    },
    ["id", "asset"],
  ),
};

const PARAMETERS: Record<StoryToolName, Record<string, unknown>> = {
  read_story: { type: "object", properties: {}, additionalProperties: false },
  edit_story: {
    type: "object",
    properties: {
      baseVersion: str(
        "The version from read_story; refused with a conflict if the graph changed.",
        200,
      ),
      operations: {
        type: "array",
        minItems: 1,
        maxItems: STORY_LIMITS.operations,
        description: "Operations applied in order, atomically.",
        items: { anyOf: STORY_OPERATION_NAMES.map((name) => OPERATION_SCHEMAS[name]) },
      },
    },
    required: ["operations"],
    additionalProperties: false,
  },
  build_story: {
    type: "object",
    properties: {
      baseVersion: str(
        "The version from read_story; refused with a conflict if the graph changed.",
        200,
      ),
      dryRun: { type: "boolean", description: "Report what would be built without writing." },
    },
    additionalProperties: false,
  },
  rebuild_story: {
    type: "object",
    properties: {
      baseVersion: str(
        "The version from read_story; refused with a conflict if the graph changed.",
        200,
      ),
      dryRun: { type: "boolean", description: "Report what would change without writing." },
    },
    additionalProperties: false,
  },
};

// ── Activity rows ────────────────────────────────────────────────────────────

const OP_SUMMARY: Record<StoryOperationName, string> = {
  add_node: "add node",
  update_node: "update",
  remove_node: "remove",
  connect: "connect",
  disconnect: "disconnect",
  set_order: "reorder",
  attach: "attach",
  detach: "detach",
  set_story: "story settings",
  resolve_missing: "resolve missing asset",
};

const isOperationName = (value: unknown): value is StoryOperationName =>
  STORY_OPERATION_NAMES.some((name) => name === value);

/** "Editing the story · 4 changes (add node ×3, connect)"; never throws on malformed arguments. */
function editLabel(args: unknown): string {
  const operations = isRecord(args) && Array.isArray(args.operations) ? args.operations : [];
  if (operations.length === 0) return "Editing the story";
  const counts = new Map<string, number>();
  for (const operation of operations) {
    const name = isRecord(operation) && isOperationName(operation.op) ? operation.op : null;
    const label = name ? OP_SUMMARY[name] : "edit";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const groups = [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
  const shown = groups.length > 3 ? [...groups.slice(0, 3), "…"] : groups;
  const noun = operations.length === 1 ? "change" : "changes";
  return `Editing the story · ${operations.length} ${noun} (${shown.join(", ")})`;
}

const ACTIVITIES: Record<StoryToolName, (args: unknown) => ToolActivity> = {
  read_story: () => ({
    category: "inspect",
    label: "Reading the story",
    labelCode: "reading_story",
  }),
  edit_story: (args) => ({ category: "edit", label: editLabel(args) }),
  build_story: (args) =>
    isRecord(args) && args.dryRun === true
      ? { category: "edit", label: "Checking the story build", labelCode: "checking_story_build" }
      : { category: "edit", label: "Building the story", labelCode: "building_story" },
  rebuild_story: (args) =>
    isRecord(args) && args.dryRun === true
      ? {
          category: "edit",
          label: "Checking the story rebuild",
          labelCode: "checking_story_rebuild",
        }
      : {
          category: "edit",
          label: "Rebuilding affected sections",
          labelCode: "rebuilding_sections",
        },
};

/** The story tools of one agent; every call goes to `execute` (the running turn's story executor). */
export function buildStoryTools(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  turn: StoryTurnMode,
  execute: Executor,
): HostTool[] {
  return storyToolsFor(agent, enabled, turn).map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: PARAMETERS[name],
    execute: (args, signal) => execute(name, args, signal),
    activity: (args) => ACTIVITIES[name](args),
  }));
}
