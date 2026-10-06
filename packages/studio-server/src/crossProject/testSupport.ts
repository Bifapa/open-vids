import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PROVENANCE_PATH,
  PROVENANCE_SCHEMA,
  STORY_GRAPH_PATH,
  STORY_GRAPH_SCHEMA,
  type AssetProvenance,
  type ChapterNode,
  type MusicNode,
  type StoryGraph,
} from "@hyperframes/agent-protocol";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";

export interface TestProject {
  /** Real folder. */
  dir: string;
  write(path: string, content?: string | Buffer): void;
}

export interface CrossProjectFixture {
  /** The open project. */
  own: TestProject;
  /** The adapter's view: the open project plus whatever `add` registered, each by key. */
  adapter: Pick<StudioApiAdapter, "resolveProject" | "externalProjects">;
  project: ResolvedProject;
  /** A project the host knows under `key`. */
  add(key: string, name: string): TestProject;
  /** A folder that belongs to no project. */
  outside: TestProject;
  cleanup(): void;
}

function makeProject(dir: string): TestProject {
  return {
    dir,
    write(path, content = path) {
      const abs = join(dir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
  };
}

export function createCrossProjectFixture(
  options: { capability?: boolean } = {},
): CrossProjectFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ov-cross-")));
  const fresh = (name: string): TestProject => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return makeProject(dir);
  };
  const own = fresh("own");
  const known = new Map<string, { name: string; dir: string; openedAt: number }>();
  known.set("ownkey0000000000", { name: "Open project", dir: own.dir, openedAt: 1 });
  const project: ResolvedProject = { id: "own", dir: own.dir };
  const adapter: CrossProjectFixture["adapter"] = {
    resolveProject: (id) => (id === "own" ? project : null),
    ...(options.capability !== false && {
      externalProjects: {
        list: async () =>
          [...known.entries()].map(([key, entry]) => ({
            key,
            name: entry.name,
            openedAt: entry.openedAt,
          })),
        resolve: async (key) => {
          const entry = known.get(key);
          return entry ? { key, name: entry.name, dir: entry.dir } : null;
        },
      },
    }),
  };
  return {
    own,
    adapter,
    project,
    add(key, name) {
      const other = fresh(key);
      known.set(key, { name, dir: other.dir, openedAt: known.size + 1 });
      return other;
    },
    outside: fresh("outside"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A complete provenance record of an audio file; `overrides` change what a test is about. */
export function provenanceRecord(
  asset: string,
  overrides: Partial<AssetProvenance> = {},
): AssetProvenance {
  return {
    id: `prov-${asset.replace(/\W+/g, "").slice(0, 8)}`,
    asset,
    mediaKind: "audio",
    title: "A track",
    originalUrl: "https://example.org/track.mp3",
    pageUrl: "https://example.org/track",
    source: { id: "openverse", name: "Openverse", trusted: true },
    author: "Jane Doe",
    authorUrl: null,
    license: "CC BY 4.0",
    licenseId: "cc_by",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    licenseConfidence: "high",
    licenseStatus: "attribution",
    licenseBasis: "API",
    attribution: "“A track” by Jane Doe, CC BY 4.0, via Openverse",
    retrievedAt: 1_700_000_000_000,
    retrievedBy: { agent: "director", turnId: "turn-1", model: null },
    policyMode: "trusted",
    sha256: "0".repeat(64),
    originalSha256: "0".repeat(64),
    bytes: 3,
    contentType: "audio/mpeg",
    converted: null,
    storyNode: null,
    need: null,
    ...overrides,
  };
}

export function writeLedgerFile(project: TestProject, records: AssetProvenance[]): void {
  project.write(PROVENANCE_PATH, JSON.stringify({ schema: PROVENANCE_SCHEMA, records }, null, 2));
}

const base = (id: string, title: string, x: number) => ({
  id,
  title,
  position: { x, y: 0 },
  locked: false,
  createdBy: "user" as const,
  userEdited: [],
});

export function chapter(id: string, title: string, x: number, description: string): ChapterNode {
  return {
    ...base(id, title, x),
    kind: "chapter",
    purpose: "",
    description,
    narrativeRole: "main",
    estimatedDuration: 8,
    status: "approved",
    sourceRanges: [],
    aRoll: "",
    bRoll: "",
    captions: false,
    graphics: "",
    audio: "",
    previewFrame: null,
  };
}

export function musicNode(id: string, asset: string | null, soundEffect = false): MusicNode {
  return {
    ...base(id, `Music ${id}`, 0),
    kind: "music",
    asset,
    bpm: null,
    volume: 0.4,
    usageIntent: "",
    ...(soundEffect && {
      resolvedFrom: {
        missing: "miss-1",
        mediaKind: "sfx" as const,
        need: "a hit",
        at: 1,
        turnId: null,
      },
    }),
  };
}

export function writeStory(
  project: TestProject,
  nodes: StoryGraph["nodes"],
  edges: StoryGraph["edges"] = [],
): void {
  const graph: StoryGraph = {
    schema: STORY_GRAPH_SCHEMA,
    id: "story-1",
    title: "Launch film",
    brief: "A short launch film",
    settings: { composition: null, captionPreset: null },
    nodes,
    edges,
    attachments: [],
    removedByUser: [],
    review: null,
    build: null,
    updatedAt: 1,
    updatedBy: "user",
  };
  project.write(STORY_GRAPH_PATH, JSON.stringify(graph, null, 2));
}
