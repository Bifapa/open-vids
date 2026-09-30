import { vi, type Mock } from "vitest";
import {
  storyOrder,
  type ChapterNode,
  type SaveStoryRequest,
  type StoryAttachment,
  type StoryEdge,
  type StoryGraph,
  type StoryMaterialNode,
  type StoryView,
} from "@hyperframes/agent-protocol";
import { StoryApiError, type StoryClient } from "./storyClient";
import { emptyStoryGraph, newChapter, newMaterial } from "./storyGraphOps";

export function chapter(id: string, x: number, overrides: Partial<ChapterNode> = {}): ChapterNode {
  return { ...newChapter(id, { x, y: 0 }), title: `Chapter ${id}`, createdBy: "ai", ...overrides };
}

export function video(id: string, x: number): StoryMaterialNode {
  const node = newMaterial(id, { x, y: 300 }, { kind: "video", source: "media/broll.mp4" });
  if (!node) throw new Error("video fixture needs an asset");
  return { ...node, createdBy: "ai" };
}

export function sequence(id: string, from: string, to: string): StoryEdge {
  return { id, kind: "sequence", from, to, transition: "", createdBy: "ai" };
}

export function attachment(id: string, node: string, chapterId: string): StoryAttachment {
  return {
    id,
    node,
    chapter: chapterId,
    placement: "start",
    offset: null,
    duration: null,
    createdBy: "ai",
  };
}

/** a → b → c, with a video attached to b. */
export function sampleGraph(): StoryGraph {
  return {
    ...emptyStoryGraph("story_1", 1000, "Launch video"),
    updatedBy: "ai",
    nodes: [chapter("a", 0), chapter("b", 300), chapter("c", 600), video("v", 300)],
    edges: [sequence("e1", "a", "b"), sequence("e2", "b", "c")],
    attachments: [attachment("t1", "v", "b")],
  };
}

export function viewOf(graph: StoryGraph | null, version: string | null): StoryView {
  return {
    graph,
    version,
    order: graph ? storyOrder(graph) : { chapters: [], notes: [] },
    facts: {},
    composition: "index.html",
  };
}

export interface FakeStoryServer {
  client: StoryClient & { load: Mock<StoryClient["load"]>; save: Mock<StoryClient["save"]> };
  /** The graph and version the "server" holds. */
  state: { graph: StoryGraph | null; version: number };
  /** Saved request bodies, in order. */
  saves: SaveStoryRequest[];
  /** Something else (the agent) writes the graph: the version moves on. */
  writeElsewhere(graph: StoryGraph): void;
}

const versionOf = (version: number) => `sha256:${String(version).padStart(4, "0")}`;

/**
 * An in-memory story service with the real `baseVersion` rule: a save made on an old version is a 409 conflict,
 * a good one stores the graph and moves the version on.
 */
export function createFakeStoryServer(initial: StoryGraph | null = sampleGraph()): FakeStoryServer {
  const state = { graph: initial, version: initial ? 1 : 0 };
  const saves: SaveStoryRequest[] = [];
  const current = () => viewOf(state.graph, state.graph ? versionOf(state.version) : null);
  const client = {
    load: vi.fn<StoryClient["load"]>(async () => current()),
    save: vi.fn<StoryClient["save"]>(async (_projectId, request) => {
      saves.push(request);
      const expected = state.graph ? versionOf(state.version) : null;
      if (request.baseVersion !== expected) {
        throw new StoryApiError("conflict", "The story changed since your version.", 409);
      }
      state.graph = request.graph;
      state.version += 1;
      return current();
    }),
    inventory: vi.fn<StoryClient["inventory"]>(async () => ({
      compositions: [],
      assets: [
        {
          path: "media/broll.mp4",
          kind: "video",
          bytes: 1,
          duration: 12,
          width: 1920,
          height: 1080,
          hasAudio: true,
        },
      ],
      renders: [],
    })),
    presets: vi.fn<StoryClient["presets"]>(async () => []),
  };
  return {
    client,
    state,
    saves,
    writeElsewhere(graph) {
      state.graph = graph;
      state.version += 1;
    },
  };
}

/** Lets promise chains settle (and faked timers' callbacks run their awaits). */
export async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}
