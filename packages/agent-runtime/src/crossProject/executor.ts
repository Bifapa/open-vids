import {
  PROJECT_MANIFEST_LIMITS,
  type AgentId,
  type ChatMessage,
  type ProjectManifest,
  type SpecialistId,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { errorMessage } from "../errors.js";
import { argsRecord, invalid, refuse, requiredText } from "../research/args.js";
import { formatResearchError } from "../research/format.js";
import { ResearchToolError } from "../research/host.js";
import type { StoryTurnMode } from "../story/tools.js";
import { chatAttachedProjects, fileParts, guardImport, type AttachedProject } from "./access.js";
import { formatImportFromProject } from "./format.js";
import type { CrossProjectHost } from "./host.js";
import { renderAttachedProjects } from "./prompt.js";
import { crossProjectToolsFor, isCrossProjectToolName } from "./tools.js";

export interface TurnCrossProjectOptions {
  host: CrossProjectHost;
  /** The running turn: stamped on every import so the server attributes the copy to it (and Revert undoes it). */
  turnId: string;
  /** The turn's abort signal: aborting the turn aborts every in-flight call. */
  turnSignal: AbortSignal;
  /** The chat's enabled specialists and the turn's mode: who may call what is decided here, not by the model. */
  enabled: readonly SpecialistId[];
  turn: StoryTurnMode;
  /**
   * The chat's messages, read on every call: the projects the user attached are the project references of its user
   * messages (the prompt, later messages and steering — a project attached by steering applies from its first call).
   */
  messages: () => readonly ChatMessage[];
  /** The model the calling agent runs (`provider/modelId`), recorded in the provenance of what it copies. */
  model: (agent: AgentId) => string | null;
}

/** Paths of the manifest a refusal shows, so the model can correct a misspelled path. */
const LISTED_IN_REFUSAL = 20;

/** The files the model asked for, as the clean list of distinct non-empty paths. */
function requestedFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw invalid("files must be a non-empty array of paths from the <attached-projects> block");
  const files = new Set<string>();
  for (const file of value) {
    if (typeof file !== "string" || file.trim() === "") throw invalid("every file must be a path");
    if (file.length > PROJECT_MANIFEST_LIMITS.pathChars)
      throw invalid(`a path is longer than ${PROJECT_MANIFEST_LIMITS.pathChars} characters`);
    files.add(file.trim());
  }
  return [...files];
}

/**
 * The cross-project tool of one running turn, bound to that turn's project, abort signal and team. Like the research
 * executor it tracks its in-flight calls so {@link shutdown} stops the turn's imports before the checkpoint closes: a
 * copy already sent to Studio writes project files, so it is awaited to its end (the host cancels it on abort and keeps
 * waiting for the server's answer, see {@link CrossProjectHost}), and no new call is accepted afterwards. A write the
 * host could not settle is reported by {@link shutdown} as unsettled.
 *
 * Everything goes through the access guard first (see `access.ts`): the project must be one the user attached in this
 * chat, and every file must be listed in the manifest of the parts they attached — the manifest Studio builds for
 * exactly those parts, fetched here, never the one in the prompt or anything the model says. A file of a part the
 * user did not attach is refused even inside an attached project, and the whole call is refused without the import
 * being sent. The fields of the request that describe the caller (turn, agent, model) are set here and whatever the
 * model sends for them is dropped.
 */
export class TurnCrossProject {
  private accepting = true;
  private readonly stop = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly unsettled: string[] = [];

  constructor(private readonly options: TurnCrossProjectOptions) {}

  /** The projects the user attached in this chat so far. */
  attached(): AttachedProject[] {
    return chatAttachedProjects(this.options.messages());
  }

  /** Whether some attached project has a file part: only then is there anything `import_from_project` could copy. */
  hasFiles(): boolean {
    return this.attached().some((project) => fileParts(project).length > 0);
  }

  /** Who has the tool this turn (the prompt block names them). */
  holders(): AgentId[] {
    const { enabled, turn } = this.options;
    const everyone: AgentId[] = ["director", ...enabled];
    return everyone.filter((agent) => crossProjectToolsFor(agent, enabled, turn).length > 0);
  }

  /**
   * The `<attached-projects>` block for the turn's prompt: every attached project (or only those with a key in
   * `onlyKeys`, for steering that attached one more) with its manifest as Studio lists it now. Empty when nothing is
   * attached. When Studio cannot answer the block says so instead of failing the turn.
   */
  async promptBlock(options: { onlyKeys?: readonly string[]; offered: boolean }): Promise<string> {
    const attached = this.attached();
    const projects = options.onlyKeys
      ? attached.filter((project) => options.onlyKeys?.includes(project.key))
      : attached;
    if (projects.length === 0) return "";
    return renderAttachedProjects({
      projects,
      holders: this.holders(),
      offered: options.offered,
      // Every attached part, the story included: the synopsis comes with `story` in the asked parts.
      manifestOf: (project, signal) =>
        this.options.host.manifest(project.key, project.parts, signal),
      signal: AbortSignal.any([this.options.turnSignal, this.stop.signal]),
    });
  }

  execute(
    caller: AgentId,
    name: string,
    args: unknown,
    callSignal: AbortSignal,
  ): Promise<HostToolResult> {
    if (!this.accepting)
      return Promise.resolve(refuse("The turn is finishing; copying from projects is closed."));
    if (!isCrossProjectToolName(name))
      return Promise.resolve(refuse(`Unknown project tool ${name}.`));
    const { enabled, turn } = this.options;
    if (!crossProjectToolsFor(caller, enabled, turn).some((tool) => tool === name))
      return Promise.resolve(refuse(`${name} is not available to you in this turn.`));
    const signal = AbortSignal.any([callSignal, this.options.turnSignal, this.stop.signal]);
    const call = this.importFiles(caller, args, signal).catch((error: unknown): HostToolResult => {
      if (error instanceof ResearchToolError) {
        if (error.code === "write_unsettled") this.unsettled.push(`${name}: ${error.message}`);
        return refuse(formatResearchError(error));
      }
      return refuse(`internal: ${errorMessage(error, "The project import failed")}`);
    });
    this.inflight.add(call);
    void call.finally(() => this.inflight.delete(call));
    return call;
  }

  /**
   * Stops accepting calls, cancels running calls, and waits for every started call to end. Resolves with the writes
   * the host could not settle (cancelled, but Studio never said whether they wrote): those may land after the
   * checkpoint closed, and the caller should say so.
   */
  async shutdown(): Promise<{ unsettledWrites: string[] }> {
    this.accepting = false;
    this.stop.abort();
    await Promise.allSettled([...this.inflight]);
    return { unsettledWrites: [...this.unsettled] };
  }

  private async importFiles(
    caller: AgentId,
    args: unknown,
    signal: AbortSignal,
  ): Promise<HostToolResult> {
    const record = argsRecord(args);
    const wanted = requiredText(record, "project", 200);
    const files = requestedFiles(record.files);
    if (files.length > PROJECT_MANIFEST_LIMITS.importFiles) {
      return refuse(
        `At most ${PROJECT_MANIFEST_LIMITS.importFiles} files per call; you asked for ${files.length}. Copy the ones you need most now and call again for the rest.`,
      );
    }
    const found = guardImport(this.attached(), wanted);
    if (!found.ok) return refuse(found.refusal);
    const { project } = found;
    // Re-checked against what Studio lists for exactly the attached file parts, now: a file of a part the user did
    // not attach is not in this manifest, so it is refused even though its project is attached.
    const manifest = await this.options.host.manifest(project.key, fileParts(project), signal);
    const listed = new Set(
      manifest.files.filter((file) => project.parts.includes(file.part)).map((file) => file.path),
    );
    const unlisted = files.filter((file) => !listed.has(file));
    if (unlisted.length > 0) return refuse(notListedText(project, unlisted, manifest, listed));
    const model = this.options.model(caller);
    const result = await this.options.host.importFiles(
      {
        projectKey: project.key,
        files,
        turnId: this.options.turnId,
        agent: caller,
        ...(model !== null && { model }),
      },
      signal,
    );
    return { text: formatImportFromProject(project, result, files.length) };
  }
}

function notListedText(
  project: AttachedProject,
  unlisted: readonly string[],
  manifest: ProjectManifest,
  listed: ReadonlySet<string>,
): string {
  const shown = [...listed].slice(0, LISTED_IN_REFUSAL);
  const more = listed.size - shown.length;
  const cut = manifest.truncated
    ? ` Studio's listing of this project is cut at ${PROJECT_MANIFEST_LIMITS.files} files, so a file beyond it cannot be copied: ask the user to attach a narrower part.`
    : "";
  return `Nothing was copied. ${unlisted.length === 1 ? "This path is" : "These paths are"} not a file of the parts of "${project.name}" the user attached (${fileParts(project).join(", ")}): ${unlisted.map((file) => JSON.stringify(file)).join(", ")}. The path may be misspelled, or the file belongs to a part the user did not attach — you cannot copy it.${cut} Use paths exactly as the <attached-projects> block lists them.${shown.length > 0 ? ` Some of them: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}.` : ""}`;
}
