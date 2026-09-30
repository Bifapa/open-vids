import { existsSync, statSync } from "node:fs";
import {
  STORY_GRAPH_PATH,
  isChapter,
  storyOrder,
  validateStoryGraph,
  type SaveStoryRequest,
  type StoryBuildRequest,
  type StoryBuildResult,
  type StoryEditRequest,
  type StoryEditResponse,
  type StoryGraph,
  type StoryNodeFacts,
  type StoryOrder,
  type StorySourceRange,
  type StorySourceRangeInput,
  type StoryView,
  type ApplyEditsResponse,
  type PresetInfo,
  type TimelineSnapshot,
} from "@hyperframes/agent-protocol";
import { isAnalysisFailure } from "../analysis/errors.js";
import type { AnalysisService, SourceAnalysisData } from "../analysis/service.js";
import { serialized } from "../analysis/store.js";
import { isEditFailure, type EditFailure } from "../editing/errors.js";
import { MAIN_COMPOSITION } from "../editing/inventory.js";
import { assetKindOf, MediaFacts, type MediaProber } from "../editing/mediaFacts.js";
import { applyEdits } from "../editing/operations.js";
import { listPresets } from "../editing/presets.js";
import { serializedEdits } from "../editing/queue.js";
import { normalizeCompositionPath, readTimeline } from "../editing/service.js";
import { resolveProjectRelative } from "../editing/timeline.js";
import { resolveWithinProject } from "../helpers/safePath.js";
import type { HistoryWho } from "../history/historyLog.js";
import type { ResolvedProject, StudioApiAdapter } from "../types.js";
import { cleanChapterAroll, type AnalysisLookup } from "./aroll.js";
import { applyUserAuthorship } from "./authorship.js";
import { compileStory } from "./build.js";
import { StoryFailure } from "./errors.js";
import { timelineFacts } from "./facts.js";
import {
  bareToken,
  emptyGraph,
  readStoredStory,
  sameJson,
  writeStoredStory,
  type StoredStory,
} from "./graphIo.js";
import { applyStoryOperations, type MediaKind, type OpsEnv } from "./ops.js";

/** Studio's own history author (the same person `routes/history.ts` records saves as). */
const PERSON: HistoryWho = { kind: "person", name: "You" };
/** A burst of canvas edits is one Studio history entry, closed after this long without a save. */
const USER_SAVE_IDLE_MS = 4_000;
const USER_SAVE_LABEL = "Edited story";
const USER_SAVE_KEY = "story-graph";
const DEFAULT_FRAME_WIDTH = 320;
const RANGE_END_TOLERANCE = 0.5;

/** What the story service asks of the analysis service (a seam for tests). */
export type StoryAnalysis = Pick<AnalysisService, "sourceData" | "cleanOrphans" | "framePreview">;

export interface StoryServiceOptions {
  /** ffprobe reader (tests). */
  probe?: MediaProber;
}

const NO_ORDER: StoryOrder = { chapters: [], notes: [] };

const withoutStamp = (graph: StoryGraph) => ({ ...graph, updatedAt: 0, updatedBy: "ai" });

function conflict(what: string, expected: string | null, actual: string | null): StoryFailure {
  return new StoryFailure(
    "conflict",
    `The story ${what} changed since you read it (you had ${expected ?? "none"}, it is ${actual ?? "empty"}); read it again`,
  );
}

function fromEdit(error: EditFailure): StoryFailure {
  const { code, message, opIndex } = error.error;
  const where = opIndex === undefined ? "" : ` (edit ${opIndex + 1} of the build)`;
  switch (code) {
    case "conflict":
      return new StoryFailure("conflict", message);
    case "unknown_asset":
      return new StoryFailure("unknown_asset", `${message}${where}`);
    case "unknown_preset":
      return new StoryFailure("unknown_preset", `${message}${where}`);
    default:
      return new StoryFailure(
        "invalid_request",
        `The timeline refused the build: ${message}${where}`,
      );
  }
}

/**
 * The story of one Studio server: the Story Graph file, what the user and agents may do to it, its facts, and the
 * compiler that turns it into the timeline.
 */
export class StoryService {
  private readonly facts: MediaFacts;
  private readonly materialCache = new Map<
    string,
    { key: string; lengths: Map<string, number | null> }
  >();

  constructor(
    private readonly adapter: StudioApiAdapter,
    private readonly analysis: StoryAnalysis,
    options: StoryServiceOptions = {},
  ) {
    this.facts = new MediaFacts(options.probe);
  }

  private lock<T>(project: ResolvedProject, task: () => Promise<T>): Promise<T> {
    return serialized(`story\0${project.dir}`, task);
  }

  /** Analysis of a source, memoized for one request; null when the file is not a project media file. */
  private lookupFor(project: ResolvedProject): AnalysisLookup {
    const seen = new Map<string, Promise<SourceAnalysisData | null>>();
    return (source) => {
      let pending = seen.get(source);
      if (!pending) {
        pending = this.analysis.sourceData(project, source).catch((error: unknown) => {
          if (isAnalysisFailure(error)) return null;
          throw error;
        });
        seen.set(source, pending);
      }
      return pending;
    };
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** The graph with its order and per-node facts. Also sweeps orphaned analysis (throttled). */
  async view(project: ResolvedProject): Promise<StoryView> {
    await this.analysis.cleanOrphans(project);
    return this.viewOf(project, readStoredStory(project.dir));
  }

  private async viewOf(project: ResolvedProject, stored: StoredStory | null): Promise<StoryView> {
    if (!stored)
      return { graph: null, version: null, order: NO_ORDER, facts: {}, composition: null };
    const { graph } = stored;
    const composition = graph.settings.composition ?? MAIN_COMPOSITION;
    let timeline: TimelineSnapshot | null = null;
    try {
      timeline = await readTimeline(project, normalizeCompositionPath(composition), this.facts);
    } catch (error) {
      if (!isEditFailure(error)) throw error;
    }
    const onTimeline = timelineFacts(graph, timeline);
    const lengths = await this.materialLengths(project, stored);
    const facts: Record<string, StoryNodeFacts> = {};
    for (const node of graph.nodes) {
      const entry: StoryNodeFacts = { timeline: onTimeline.get(node.id) ?? null };
      if (isChapter(node) && lengths.has(node.id)) entry.materialDuration = lengths.get(node.id);
      facts[node.id] = entry;
    }
    return {
      graph,
      version: stored.version,
      order: storyOrder(graph),
      facts,
      composition,
    };
  }

  /** Cleaned A-roll length of every chapter that has ranges, cached until the graph or an analysis changes. */
  private async materialLengths(
    project: ResolvedProject,
    stored: StoredStory,
  ): Promise<Map<string, number | null>> {
    const lookup = this.lookupFor(project);
    const chapters = stored.graph.nodes.filter(isChapter).filter((c) => c.sourceRanges.length > 0);
    const sources = [
      ...new Set(chapters.flatMap((c) => c.sourceRanges.map((r) => r.source))),
    ].sort();
    const versions = await Promise.all(
      sources.map(async (source) => (await lookup(source))?.version ?? "missing"),
    );
    const key = `${stored.version}\0${sources.map((source, i) => `${source}@${versions[i]}`).join("\0")}`;
    const cached = this.materialCache.get(project.dir);
    if (cached?.key === key) return cached.lengths;
    const lengths = new Map<string, number | null>();
    for (const chapter of chapters) {
      lengths.set(chapter.id, (await cleanChapterAroll(chapter, lookup)).length);
    }
    this.materialCache.set(project.dir, { key, lengths });
    return lengths;
  }

  // ── User save ─────────────────────────────────────────────────────────────

  /** Studio saves the whole graph after a manual edit; authorship is worked out against the stored graph. */
  save(project: ResolvedProject, request: SaveStoryRequest): Promise<StoryView> {
    return this.lock(project, async () => {
      const stored = readStoredStory(project.dir);
      if (
        (stored?.version ?? null) !==
        (request.baseVersion === null ? null : bareToken(request.baseVersion))
      ) {
        throw conflict("graph", request.baseVersion, stored?.version ?? null);
      }
      const graph = applyUserAuthorship(stored?.graph ?? null, request.graph, Date.now());
      const problems = validateStoryGraph(graph);
      if (problems.length > 0) throw new StoryFailure("invalid_request", problems.join(" "));
      if (stored && sameJson(withoutStamp(stored.graph), withoutStamp(graph))) {
        return this.viewOf(project, stored);
      }
      writeStoredStory(project.dir, graph);
      await this.claimForUser(project);
      return this.viewOf(project, readStoredStory(project.dir));
    });
  }

  /** Files the user's save in project history as "You": canvas bursts merge into one entry, never a checkpoint. */
  private async claimForUser(project: ResolvedProject): Promise<void> {
    try {
      const history = await this.adapter.history?.(project);
      await history?.claim(PERSON, USER_SAVE_LABEL, [STORY_GRAPH_PATH], {
        coalesceKey: USER_SAVE_KEY,
        idleMs: USER_SAVE_IDLE_MS,
      });
    } catch {
      // History is best effort: the save itself already happened.
    }
  }

  // ── Agent edits ───────────────────────────────────────────────────────────

  private opsEnv(project: ResolvedProject, turnId: string | null): OpsEnv {
    const lookup = this.lookupFor(project);
    let presets: Promise<PresetInfo[]> | null = null;
    const registry = () => (presets ??= listPresets(this.adapter, {}));
    return {
      now: Date.now(),
      turnId,
      resolveRanges: (inputs) => this.resolveRanges(lookup, inputs),
      mediaFile: async (path) => {
        const relative = resolveProjectRelative(MAIN_COMPOSITION, path);
        if (relative === null) return null;
        const kind = assetKindOf(relative);
        if (kind !== "video" && kind !== "audio" && kind !== "image") return null;
        const asset = await this.facts.read(project.dir, relative);
        if (!asset) return null;
        const mediaKind: MediaKind = kind;
        return { path: relative, kind: mediaKind };
      },
      hasPreset: async (name) =>
        (await registry()).some((preset) => preset.kind !== "caption" && preset.name === name),
      hasCaptionPreset: async (name) => {
        if (!this.adapter.captionSkinsDir?.()) return true;
        return (await registry()).some(
          (preset) => preset.kind === "caption" && preset.name === name,
        );
      },
      hasComposition: (path) => {
        const abs = resolveWithinProject(project.dir, path);
        return abs !== null && path.endsWith(".html") && existsSync(abs) && statSync(abs).isFile();
      },
      cleanedLength: async (ranges) => {
        const cleaned = await cleanChapterAroll({ title: "", sourceRanges: ranges }, lookup);
        return cleaned.total;
      },
    };
  }

  /** Turns an agent's range inputs into stored ranges (segment ranges, sentence spans, raw times). */
  private async resolveRanges(
    lookup: AnalysisLookup,
    inputs: StorySourceRangeInput[],
  ): Promise<StorySourceRange[]> {
    const resolved: StorySourceRange[] = [];
    for (const input of inputs) {
      const data = await lookup(input.source);
      if (!data) {
        throw new StoryFailure(
          "unknown_asset",
          `${input.source} is not a video or audio file in this project`,
        );
      }
      if ("segments" in input) {
        if (!data.segments) {
          throw new StoryFailure(
            "not_analyzed",
            `${data.source} has no fresh segments; analyze it (analyze_media) before naming segments`,
          );
        }
        for (const id of input.segments) {
          const segment = data.segments.segments.find((entry) => entry.id === id);
          if (!segment) {
            throw new StoryFailure("invalid_request", `${data.source} has no segment "${id}"`);
          }
          resolved.push({ source: data.source, from: segment.start, to: segment.end, segment: id });
        }
      } else if ("firstSentence" in input) {
        if (!data.transcript) {
          throw new StoryFailure(
            "not_analyzed",
            `${data.source} has no transcript; analyze it (analyze_media) before naming sentences`,
          );
        }
        const { sentences } = data.transcript;
        const first = sentences.findIndex((entry) => entry.id === input.firstSentence);
        const last = sentences.findIndex((entry) => entry.id === input.lastSentence);
        if (first < 0 || last < 0) {
          throw new StoryFailure(
            "invalid_request",
            `${data.source} has no sentence "${first < 0 ? input.firstSentence : input.lastSentence}"`,
          );
        }
        if (first > last) {
          throw new StoryFailure(
            "invalid_request",
            `${input.firstSentence} comes after ${input.lastSentence}`,
          );
        }
        resolved.push({
          source: data.source,
          from: sentences[first]?.start ?? 0,
          to: sentences[last]?.end ?? 0,
          segment: null,
        });
      } else {
        if (data.duration !== null) {
          if (input.from >= data.duration || input.to > data.duration + RANGE_END_TOLERANCE) {
            throw new StoryFailure(
              "invalid_request",
              `${input.from}–${input.to} s is outside ${data.source} (${data.duration} s)`,
            );
          }
        }
        resolved.push({ source: data.source, from: input.from, to: input.to, segment: null });
      }
    }
    return resolved;
  }

  /** An agent's atomic batch (see `applyStoryOperations`). Written unclaimed: history attributes it to the turn. */
  edit(project: ResolvedProject, request: StoryEditRequest): Promise<StoryEditResponse> {
    return this.lock(project, async () => {
      const stored = readStoredStory(project.dir);
      if (request.baseVersion !== undefined) {
        const expected = bareToken(request.baseVersion);
        if (expected !== (stored?.version ?? null))
          throw conflict("graph", expected, stored?.version ?? null);
      }
      const now = Date.now();
      const outcome = await applyStoryOperations(
        this.opsEnv(project, request.turnId ?? null),
        stored?.graph ?? null,
        () => emptyGraph(now, "ai"),
        request.operations,
      );
      const graph: StoryGraph = { ...outcome.graph, updatedAt: now, updatedBy: "ai" };
      if (!stored || !sameJson(withoutStamp(stored.graph), withoutStamp(graph))) {
        writeStoredStory(project.dir, graph);
      }
      return {
        view: await this.viewOf(project, readStoredStory(project.dir)),
        results: outcome.results,
      };
    });
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  /**
   * Compiles the graph into the timeline in one atomic edit (see `compileStory`), then records the build on the graph.
   * Nothing is claimed in history: the build belongs to the agent turn that asked for it.
   */
  build(project: ResolvedProject, request: StoryBuildRequest): Promise<StoryBuildResult> {
    return this.lock(project, () =>
      serializedEdits(project.dir, async () => {
        const stored = readStoredStory(project.dir);
        if (!stored) throw new StoryFailure("no_story", "There is no story to build yet");
        if (request.baseVersion !== undefined) {
          const expected = bareToken(request.baseVersion);
          if (expected !== stored.version) throw conflict("graph", expected, stored.version);
        }
        const { graph } = stored;
        const compositionPath = normalizeCompositionPath(graph.settings.composition ?? undefined);
        let timeline: TimelineSnapshot;
        try {
          timeline = await readTimeline(project, compositionPath, this.facts);
        } catch (error) {
          if (isEditFailure(error)) {
            throw new StoryFailure(
              "unknown_asset",
              `No composition "${compositionPath}" to build into`,
            );
          }
          throw error;
        }
        const compiled = await compileStory(
          {
            project,
            adapter: this.adapter,
            facts: this.facts,
            lookup: this.lookupFor(project),
            turnId: request.turnId,
          },
          graph,
          timeline,
        );
        const dryRun = request.dryRun === true;
        const summary = compiled.chapters;
        let timelineVersion = timeline.version;
        let clipIds: Array<string | null> = compiled.operations.map(() => null);
        if (!dryRun) {
          let response: ApplyEditsResponse;
          try {
            response = await applyEdits(
              { project, compositionPath, adapter: this.adapter, facts: this.facts },
              { operations: compiled.operations, baseVersion: timeline.version },
            );
          } catch (error) {
            throw isEditFailure(error) ? fromEdit(error) : error;
          }
          timelineVersion = response.timeline.version;
          clipIds = response.results.map((result) => result.clipId);
          writeStoredStory(project.dir, {
            ...graph,
            build: {
              at: Date.now(),
              turnId: request.turnId ?? null,
              composition: compositionPath,
              version: timelineVersion,
              duration: compiled.duration,
              chapters: summary.map(({ node, start, end, clips }) => ({ node, start, end, clips })),
              warnings: compiled.warnings,
            },
            updatedAt: Date.now(),
            updatedBy: "ai",
          });
        }
        return {
          dryRun,
          composition: compositionPath,
          timelineVersion,
          duration: compiled.duration,
          chapters: summary,
          materials: compiled.materials.map((material) => ({
            node: material.node,
            chapter: material.chapter,
            clipId: clipIds[material.operation] ?? null,
            start: material.start,
            end: material.end,
            track: material.track,
          })),
          removedClips: compiled.removedClips,
          keptClips: compiled.keptClips,
          captions: compiled.captions,
          warnings: compiled.warnings,
          view: await this.viewOf(project, readStoredStory(project.dir)),
        };
      }),
    );
  }

  // ── Frames ────────────────────────────────────────────────────────────────

  /** A JPEG of one video frame for a card. */
  frame(
    project: ResolvedProject,
    source: string,
    time: number,
    width: number | undefined,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const clamped = Math.min(Math.max(Math.round(width ?? DEFAULT_FRAME_WIDTH), 16), 1280);
    return this.analysis.framePreview(project, source, time, clamped, signal);
  }
}
