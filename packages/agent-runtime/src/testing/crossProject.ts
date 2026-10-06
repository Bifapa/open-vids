import type {
  ImportFromProjectRequest,
  ImportFromProjectResult,
  ProjectFilePart,
  ProjectManifest,
  ProjectManifestFile,
  ProjectPart,
  ProjectReference,
  UserMessage,
} from "@hyperframes/agent-protocol";
import { expandProjectParts } from "@hyperframes/agent-protocol";
import type { CrossProjectHost } from "../crossProject/host.js";
import { ResearchToolError } from "../research/host.js";
import { sampleProvenance } from "./research.js";

/** A manifest file of `part` at `path` (default 2 MB). */
export function manifestFile(
  path: string,
  part: ProjectFilePart,
  extra: Partial<ProjectManifestFile> = {},
): ProjectManifestFile {
  return { path, part, bytes: 2_000_000, ...extra };
}

let messageCounter = 0;

/** A `#` mention of another project, as a message reference. */
export function projectReference(
  projectKey: string,
  name: string,
  parts: ProjectPart[],
): ProjectReference {
  messageCounter += 1;
  return { id: `ref-${messageCounter}`, kind: "project", projectKey, name, parts };
}

/** A user message (a turn's prompt, or steering) with `references` attached. */
export function userMessage(
  text: string,
  references: readonly ProjectReference[] = [],
  steering = false,
): UserMessage {
  messageCounter += 1;
  return {
    id: `msg-${messageCounter}`,
    chatId: "chat",
    turnId: "turn",
    createdAt: messageCounter,
    role: "user",
    steering,
    parts: [
      { type: "text", id: `text-${messageCounter}`, text },
      ...references.map((reference) => ({
        type: "reference" as const,
        id: `part-${reference.id}`,
        reference,
      })),
    ],
  };
}

/**
 * Deterministic in-memory cross-project host for runtime tests and embedding harnesses. `projects` maps a project key
 * to what Studio would list for it; a manifest answers with the files of the asked parts only (the story synopsis
 * with `story`), like the real service. An import keeps going when its signal aborts after it reached the host (it
 * writes project files) until the commit point, where an aborted signal makes it answer `cancelled` and write nothing;
 * `importGate` holds one open before that point so tests can stop a turn while an import is in flight.
 */
export class FakeCrossProjectHost implements CrossProjectHost {
  /** What Studio knows: key → name, every file and the story synopsis. */
  readonly projects = new Map<
    string,
    { name: string; files: ProjectManifestFile[]; story: string | null; truncated?: boolean }
  >();
  /** The next `manifest` call rejects with this error. */
  nextManifestError: ResearchToolError | null = null;
  /** The next `importFiles` call rejects with this error (after the gate, before it writes). */
  nextImportError: ResearchToolError | null = null;
  /** While set, `importFiles` records the request and waits for it before the commit point. */
  importGate: Promise<void> | null = null;
  /** What `importFiles` answers; default: every requested file copied to `assets/from/<key>/<path>`. */
  importResult: ImportFromProjectResult | null = null;

  readonly manifestRequests: Array<{ key: string; parts: readonly ProjectPart[] }> = [];
  readonly importRequests: ImportFromProjectRequest[] = [];
  /** The imports that reached their commit point and wrote. */
  readonly committed: ImportFromProjectRequest[] = [];
  readonly importSignals: AbortSignal[] = [];

  async manifest(
    key: string,
    parts: readonly ProjectPart[],
    signal: AbortSignal,
  ): Promise<ProjectManifest> {
    if (signal.aborted) throw aborted();
    this.manifestRequests.push({ key, parts });
    if (this.nextManifestError) {
      const error = this.nextManifestError;
      this.nextManifestError = null;
      throw error;
    }
    const project = this.projects.get(key);
    if (!project) throw new ResearchToolError("unknown_project", "No such project.");
    const asked = expandProjectParts(parts);
    return {
      key,
      name: project.name,
      parts: asked,
      files: project.files.filter((file) => asked.some((part) => part === file.part)),
      truncated: project.truncated ?? false,
      story: asked.includes("story") ? project.story : null,
    };
  }

  async importFiles(
    request: ImportFromProjectRequest,
    signal: AbortSignal,
  ): Promise<ImportFromProjectResult> {
    if (signal.aborted) throw aborted();
    this.importRequests.push(request);
    this.importSignals.push(signal);
    if (this.importGate) await this.importGate;
    if (signal.aborted) throw new ResearchToolError("cancelled", "The copy was cancelled.");
    if (this.nextImportError) {
      const error = this.nextImportError;
      this.nextImportError = null;
      throw error;
    }
    this.committed.push(request);
    const project = this.projects.get(request.projectKey);
    return structuredClone(
      this.importResult ?? {
        imported: request.files.map((source) => ({
          source,
          asset: `assets/from/${project?.name ?? request.projectKey}/${source}`,
          bytes: project?.files.find((file) => file.path === source)?.bytes ?? 1,
          status: "copied",
          provenance: sampleProvenance({
            asset: `assets/from/${project?.name ?? request.projectKey}/${source}`,
            importedFrom: { project: project?.name ?? request.projectKey, asset: source },
          }),
        })),
        skipped: [],
      },
    );
  }
}

function aborted(): ResearchToolError {
  return new ResearchToolError("aborted", "The operation was cancelled.");
}
