import {
  STORY_GRAPH_SCHEMA,
  storyOrder,
  type ChapterNode,
  type StoryBuildRequest,
  type StoryBuildResult,
  type StoryEditRequest,
  type StoryEditResponse,
  type StoryGraph,
  type StoryView,
  type VideoNode,
} from "@hyperframes/agent-protocol";
import { StoryToolError, type StoryHost } from "../story/host.js";

/** A chapter with every field at its default; tests override what they care about. */
export function chapterNode(id: string, overrides: Partial<ChapterNode> = {}): ChapterNode {
  return {
    id,
    kind: "chapter",
    title: `Chapter ${id}`,
    position: { x: 0, y: 0 },
    locked: false,
    createdBy: "ai",
    userEdited: [],
    purpose: "",
    description: "",
    narrativeRole: "main",
    estimatedDuration: 30,
    status: "proposed",
    sourceRanges: [],
    aRoll: "",
    bRoll: "",
    captions: false,
    graphics: "",
    audio: "",
    previewFrame: null,
    ...overrides,
  };
}

export function videoNode(id: string, overrides: Partial<VideoNode> = {}): VideoNode {
  return {
    id,
    kind: "video",
    title: `Video ${id}`,
    position: { x: 0, y: 200 },
    locked: false,
    createdBy: "ai",
    userEdited: [],
    asset: "assets/broll.mp4",
    sourceIn: 0,
    sourceOut: null,
    usageIntent: "",
    previewFrame: null,
    ...overrides,
  };
}

export function storyGraph(overrides: Partial<StoryGraph> = {}): StoryGraph {
  return {
    schema: STORY_GRAPH_SCHEMA,
    id: "story-1",
    title: "Launch video",
    brief: "A two-minute product story",
    settings: { composition: null, captionPreset: null },
    nodes: [],
    edges: [],
    attachments: [],
    removedByUser: [],
    review: null,
    build: null,
    updatedAt: 1,
    updatedBy: "ai",
    ...overrides,
  };
}

export function storyView(graph: StoryGraph | null, version = "sha256:story-v1"): StoryView {
  return {
    graph,
    version: graph ? version : null,
    order: graph ? storyOrder(graph) : { chapters: [], notes: [] },
    facts: {},
    composition: graph ? "index.html" : null,
  };
}

/**
 * A story the way a user leaves it after reshaping the AI's plan: `ch1` is locked and its title was set by hand,
 * `ch2` has a duration the user chose and a B-roll clip the user attached, and the user removed an AI link.
 */
export function userEditedStory(): StoryView {
  return storyView(
    storyGraph({
      nodes: [
        chapterNode("ch1", {
          title: "Cold open",
          locked: true,
          userEdited: ["title"],
          narrativeRole: "hook",
          estimatedDuration: 12,
          sourceRanges: [{ source: "assets/raw-talk.mp4", from: 62, to: 90, segment: "g3" }],
          position: { x: 0, y: 0 },
        }),
        chapterNode("ch2", {
          title: "The problem",
          userEdited: ["estimatedDuration"],
          estimatedDuration: 45,
          position: { x: 400, y: 0 },
        }),
        chapterNode("ch3", { title: "Wrap up", position: { x: 800, y: 0 } }),
        videoNode("v1", {
          title: "Keyboard close-up",
          createdBy: "user",
          position: { x: 400, y: 200 },
        }),
      ],
      edges: [
        { id: "e1", kind: "sequence", from: "ch1", to: "ch2", transition: "", createdBy: "ai" },
      ],
      attachments: [
        {
          id: "a1",
          node: "v1",
          chapter: "ch2",
          placement: "middle",
          offset: null,
          duration: null,
          createdBy: "user",
        },
      ],
      removedByUser: [{ kind: "edge", from: "ch2", to: "ch3" }],
    }),
  );
}

export function sampleBuildResult(view: StoryView): StoryBuildResult {
  return {
    dryRun: false,
    composition: "index.html",
    timelineVersion: "sha256:timeline-after-build",
    duration: 57,
    chapters: [
      { node: "ch1", title: "Cold open", estimatedDuration: 12, start: 0, end: 12, clips: 3 },
      { node: "ch2", title: "The problem", estimatedDuration: 45, start: 12, end: 57, clips: 5 },
    ],
    materials: [{ node: "v1", chapter: "ch2", clipId: "clip-9", start: 30, end: 40, track: 1 }],
    removedClips: 4,
    keptClips: 2,
    captions: null,
    warnings: ["Wrap up: missing Close-up of the product box"],
    view,
  };
}

/**
 * Deterministic in-memory story host for runtime tests and embedding harnesses. It records every request and answers
 * from the fields below. It can hold an `edit` or a `build` open (`editGate`, `buildGate`) so tests can finish a turn
 * while a story write is in flight. Like the real host, a started edit or build ignores aborts.
 */
export class FakeStoryHost implements StoryHost {
  viewResult: StoryView = storyView(null);
  buildResult: StoryBuildResult | null = null;
  /** The next edit/build rejects with this error. */
  nextError: StoryToolError | null = null;
  /** While set, `edit` records the request and then waits for it before answering. */
  editGate: Promise<void> | null = null;
  /** While set, `build` records the request and then waits for it before answering. */
  buildGate: Promise<void> | null = null;

  readonly editRequests: StoryEditRequest[] = [];
  readonly editFinished: StoryEditRequest[] = [];
  readonly buildRequests: StoryBuildRequest[] = [];
  readonly buildFinished: StoryBuildRequest[] = [];
  /** The signal each edit/build was given, so tests can see when the turn stopped waiting for it. */
  readonly editSignals: AbortSignal[] = [];
  readonly buildSignals: AbortSignal[] = [];
  viewCalls = 0;

  async view(signal: AbortSignal): Promise<StoryView> {
    if (signal.aborted) throw new StoryToolError("aborted", "The operation was cancelled.");
    this.viewCalls += 1;
    return structuredClone(this.viewResult);
  }

  async edit(request: StoryEditRequest, signal: AbortSignal): Promise<StoryEditResponse> {
    if (signal.aborted) throw new StoryToolError("aborted", "The operation was cancelled.");
    this.editRequests.push(request);
    this.editSignals.push(signal);
    if (this.editGate) await this.editGate;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    this.editFinished.push(request);
    return {
      view: structuredClone(this.viewResult),
      results: request.operations.map((operation, index) => ({
        op: operation.op,
        id: operation.op === "add_node" ? `n${index + 1}` : null,
      })),
    };
  }

  async build(request: StoryBuildRequest, signal: AbortSignal): Promise<StoryBuildResult> {
    if (signal.aborted) throw new StoryToolError("aborted", "The operation was cancelled.");
    this.buildRequests.push(request);
    this.buildSignals.push(signal);
    if (this.buildGate) await this.buildGate;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    this.buildFinished.push(request);
    return structuredClone({
      ...(this.buildResult ?? sampleBuildResult(this.viewResult)),
      dryRun: request.dryRun === true,
    });
  }
}
