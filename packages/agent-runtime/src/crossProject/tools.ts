import {
  PROJECT_MANIFEST_LIMITS,
  isRecord,
  type AgentId,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import type { HostTool, HostToolResult, ToolActivity } from "../backend.js";
import { withInheritedTools } from "../agents/inherit.js";
import type { StoryTurnMode } from "../story/tools.js";

export const CROSS_PROJECT_TOOL_NAMES = { import: "import_from_project" } as const;

export type CrossProjectToolName =
  (typeof CROSS_PROJECT_TOOL_NAMES)[keyof typeof CROSS_PROJECT_TOOL_NAMES];

export function isCrossProjectToolName(name: string): name is CrossProjectToolName {
  return Object.values<string>(CROSS_PROJECT_TOOL_NAMES).includes(name);
}

type Executor = (name: string, args: unknown, signal: AbortSignal) => Promise<HostToolResult>;

/** The agents that put media on the timeline, so the ones that may need a file of an attached project. */
const IMPORTERS: readonly AgentId[] = ["director", "editor", "motion", "audio"];

/**
 * Who may copy files from an attached project: everyone who places media (the Director, Editor, Motion and Audio).
 * When one of those specialists is off in the chat the Director has the tool anyway. Jev, Vision and Research never get
 * it (Research looks outside OpenVids; a file of the user's other project is not a search result). A Story rebuild turn
 * changes nothing but the graph's compiled sections, so it offers none. Whether the chat has attached any project is
 * decided by the turn (`availability.crossProject`) and re-checked on every call (see `TurnCrossProject`).
 */
export function crossProjectToolsFor(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  turn: StoryTurnMode,
): CrossProjectToolName[] {
  if (turn.action === "rebuild") return [];
  const onTeam = agent === "director" || enabled.some((specialist) => specialist === agent);
  if (!onTeam) return [];
  return withInheritedTools(agent, enabled, (who): CrossProjectToolName[] =>
    IMPORTERS.includes(who) ? [CROSS_PROJECT_TOOL_NAMES.import] : [],
  );
}

/** The working rule for roles: how to use what the user attached from other projects. */
export const CROSS_PROJECT_ROLE_PROMPT = `Other projects: when the turn's prompt carries an <attached-projects> block, the user attached other OpenVids projects to the chat with #. That is a link, not a copy: only the files listed there (of the parts the user ticked) are available, your file tools cannot read those projects, and nothing of them is in this project until you copy it with import_from_project {project, files} into assets/from/<project>/ — it brings the file's license record along. Copy only what you will actually use, then place the copy (the path the tool returns) with edit_timeline; never reference a path of the other project. A file the tool reports without a license record is the user's own or of unknown origin: say so when you report it.`;

const DESCRIPTION = `Copy files from another project the user attached to this chat with # into this project, under assets/from/<project>/. Only projects the user attached in this chat, and only the parts they ticked (renders, music, other audio, images, video), are available — the <attached-projects> block of your prompt lists the project, its key and the files; any other project or file is refused. Pass "project" (the key or the name from the block) and "files" (paths exactly as listed there, at most ${PROJECT_MANIFEST_LIMITS.importFiles} per call). The copy keeps the file's provenance: its source, author and license come with it unchanged, and the result says plainly when a file has no license record (the user's own file, or origin unknown). A file the project already holds (same bytes) is reused, not copied again. Copy only what you will actually use — nothing is imported by looking at the list — then place the copy with edit_timeline using the project path this tool returns.`;

const PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    project: {
      type: "string",
      maxLength: 200,
      description:
        "The key (or the name) of an attached project, from the <attached-projects> block.",
    },
    files: {
      type: "array",
      minItems: 1,
      maxItems: PROJECT_MANIFEST_LIMITS.importFiles,
      description: "Paths inside that project, exactly as the block lists them.",
      items: { type: "string", maxLength: PROJECT_MANIFEST_LIMITS.pathChars },
    },
  },
  required: ["project", "files"],
  additionalProperties: false,
};

function activity(args: unknown): ToolActivity {
  const count = isRecord(args) && Array.isArray(args.files) ? args.files.length : 0;
  return {
    category: "edit",
    label: `Copying ${count === 1 ? "1 file" : `${count} files`} from another project`,
    labelCode: "importing_from_project",
    labelParams: { count },
  };
}

/** The cross-project tools of one agent; every call goes to `execute` (the running turn's executor). */
export function buildCrossProjectTools(
  agent: AgentId,
  enabled: readonly SpecialistId[],
  turn: StoryTurnMode,
  execute: Executor,
): HostTool[] {
  return crossProjectToolsFor(agent, enabled, turn).map((name) => ({
    name,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    execute: (args, signal) => execute(name, args, signal),
    activity,
  }));
}
