import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  STORY_GRAPH_PATH,
  STORY_GRAPH_SCHEMA,
  parseStoryGraph,
  type StoryGraph,
} from "@hyperframes/agent-protocol";
import { replaceFileAtomically } from "../helpers/atomicFile.js";
import {
  DELETED_VERSION,
  createWriteToken,
  fileContentVersion,
  recordFileWriteReceipt,
} from "../helpers/fileVersion.js";
import { pinWithinProject, resolveWithinProject } from "../helpers/safePath.js";
import { StoryFailure } from "./errors.js";

export interface StoredStory {
  graph: StoryGraph;
  /** `sha256:<hex>` of the file's bytes. */
  version: string;
}

/** The content version of a file's bytes as a bare token (the HTTP ETag form carries quotes models drop). */
export function storyVersion(content: string | Uint8Array): string {
  return fileContentVersion(content).replace(/^"|"$/g, "");
}

/** Version tokens travel through models: accept them bare, quoted like an ETag, or as bare hex. */
export function bareToken(token: string): string {
  const unquoted = token.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  return /^[0-9a-f]{64}$/.test(unquoted) ? `sha256:${unquoted}` : unquoted;
}

/** The stored graph, or null when there is none yet. A damaged file is refused, never silently replaced. */
export function readStoredStory(projectDir: string): StoredStory | null {
  const abs = resolveWithinProject(projectDir, STORY_GRAPH_PATH);
  if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return null;
  const bytes = readFileSync(abs);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf-8"));
  } catch {
    throw new StoryFailure("invalid_request", `${STORY_GRAPH_PATH} is not valid JSON`);
  }
  const parsed = parseStoryGraph(raw);
  if (!parsed.ok) {
    throw new StoryFailure(
      "invalid_request",
      `${STORY_GRAPH_PATH} is damaged: ${parsed.error.message}`,
    );
  }
  return { graph: parsed.value, version: storyVersion(bytes) };
}

/**
 * The same read for the user's own canvas: a damaged file reads as "no story yet", so Studio opens an empty canvas and
 * the first save starts a new graph instead of the panel dead-ending on an error. With `keepDamaged` (a save about to
 * replace it) the damaged bytes are first set aside as `graph.json.bak`. The agent's reads stay strict.
 */
export function readStoredStoryOrNone(
  projectDir: string,
  keepDamaged: boolean,
): StoredStory | null {
  try {
    return readStoredStory(projectDir);
  } catch (error) {
    if (!(error instanceof StoryFailure)) throw error;
    const abs = resolveWithinProject(projectDir, STORY_GRAPH_PATH);
    if (keepDamaged && abs) copyFileSync(abs, `${abs}.bak`);
    return null;
  }
}

/** The bare version of the graph file's bytes as they are on disk now, or null when there is no file. */
export function currentStoryVersion(projectDir: string): string | null {
  const abs = resolveWithinProject(projectDir, STORY_GRAPH_PATH);
  if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return null;
  return storyVersion(readFileSync(abs));
}

/** Refuses (`conflict`) when the graph file is not the one the caller read, i.e. changed while it worked. */
export function assertStoryUnchanged(projectDir: string, readVersion: string | null): void {
  if (currentStoryVersion(projectDir) === readVersion) return;
  throw new StoryFailure(
    "conflict",
    `${STORY_GRAPH_PATH} changed while the story was being worked on; read it again`,
  );
}

/**
 * Writes the graph (pretty JSON, atomically) and returns its new version. No history claim: the caller decides.
 * With `readVersion` (the version the graph was read at, null for none) the write is refused when the file moved on.
 * The write leaves a receipt holding the bytes it replaced, as Studio's own file writes do: a later claim of this
 * write (the user's save on top of an agent's unclaimed edit) can then cut the history exactly where it began.
 */
export function writeStoredStory(
  projectDir: string,
  graph: StoryGraph,
  readVersion?: string | null,
): string {
  const abs = pinWithinProject(projectDir, STORY_GRAPH_PATH);
  if (!abs) throw new StoryFailure("invalid_request", `${STORY_GRAPH_PATH} is outside the project`);
  if (readVersion !== undefined) assertStoryUnchanged(projectDir, readVersion);
  const content = `${JSON.stringify(graph, null, 2)}\n`;
  mkdirSync(dirname(abs), { recursive: true });
  const exists = existsSync(abs);
  const overwrote = exists ? readFileSync(abs) : undefined;
  replaceFileAtomically(abs, content, exists ? statSync(abs).mode : 0o644);
  recordFileWriteReceipt(abs, {
    path: STORY_GRAPH_PATH,
    version: fileContentVersion(content),
    writeToken: createWriteToken(),
    ...(overwrote !== undefined && { overwrote }),
  });
  return storyVersion(content);
}

/** The graph file as project history names a version (the `overwrote` of a claim): quoted hash, or `deleted`. */
export function storyFileVersion(projectDir: string): string {
  const version = currentStoryVersion(projectDir);
  return version === null ? DELETED_VERSION : `"${version}"`;
}

export function emptyGraph(now: number, by: "ai" | "user"): StoryGraph {
  return {
    schema: STORY_GRAPH_SCHEMA,
    id: `story-${randomUUID().slice(0, 8)}`,
    title: "Story",
    brief: "",
    settings: { composition: null, captionPreset: null },
    nodes: [],
    edges: [],
    attachments: [],
    removedByUser: [],
    review: null,
    build: null,
    updatedAt: now,
    updatedBy: by,
  };
}

/** A new node/edge/attachment id: a kind prefix and eight hex digits, checked against the ids in use. */
export function newId(prefix: string, taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `${prefix}-${randomUUID().slice(0, 8)}`;
    if (!taken.has(id)) return id;
  }
}

/** Structural equality of two plain JSON values (object key order does not matter). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => sameJson(entry, b[index]))
    );
  }
  const left = Object.entries(a);
  const right = new Map(Object.entries(b));
  return (
    left.length === right.size &&
    left.every(([key, value]) => right.has(key) && sameJson(value, right.get(key)))
  );
}
