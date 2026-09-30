import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RegistryItem } from "@hyperframes/core";
import {
  STORY_GRAPH_PATH,
  type SegmentMap,
  type StoryEditResponse,
  type StoryGraph,
  type StoryOperation,
  type StoryView,
  type TakeAnalysis,
  type TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import { AnalysisFailure } from "../analysis/errors.js";
import type { SourceAnalysisData } from "../analysis/service.js";
import { createTestProject, fakeProber, type TestProject } from "../editing/testProject.js";
import { StoryFailure, isStoryFailure } from "./errors.js";
import { StoryService, type StoryAnalysis } from "./service.js";

const SKINS = join(import.meta.dirname, "../../../../skills/hyperframes-creative/frame-presets");

/** A composition with no clips and no length: what a project has before its first build. */
export const BLANK_HTML = `<!doctype html>
<html>
  <body>
    <div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="0"></div>
  </body>
</html>
`;

export const TALK = "assets/a.mp4";

const BLOCK: RegistryItem = {
  type: "hyperframes:block",
  name: "sparkle",
  title: "Sparkle",
  description: "Sparkles",
  dimensions: { width: 1920, height: 1080 },
  duration: 4,
  files: [
    { path: "sparkle.html", target: "compositions/sparkle.html", type: "hyperframes:composition" },
  ],
};

function word(i: number, text: string, start: number, end: number) {
  return { i, text, start, end, speaker: null };
}

/**
 * assets/a.mp4 (8 s) as the analysis would describe it: three sentences, a 1.7 s silence between the second and the
 * third, an "uh" to cut, and three segments (g1 = s1, g2 = s2, g3 = s3).
 */
export function talkTranscript(source = TALK): TranscriptArtifact {
  const words = [
    word(0, "Hello", 0.5, 0.9),
    word(1, "there", 1.0, 1.4),
    word(2, "and", 1.5, 1.7),
    word(3, "welcome.", 1.8, 2.4),
    word(4, "Today", 2.6, 3.0),
    word(5, "we", 3.1, 3.3),
    word(6, "build", 3.4, 3.8),
    word(7, "things.", 3.9, 4.3),
    word(8, "Then", 6.0, 6.4),
    word(9, "uh", 6.5, 6.7),
    word(10, "goodbye.", 6.8, 7.4),
  ];
  return {
    source,
    language: "en",
    words,
    sentences: [
      {
        id: "s1",
        start: 0.5,
        end: 2.4,
        firstWord: 0,
        lastWord: 3,
        text: "Hello there and welcome.",
        speaker: null,
      },
      {
        id: "s2",
        start: 2.6,
        end: 4.3,
        firstWord: 4,
        lastWord: 7,
        text: "Today we build things.",
        speaker: null,
      },
      {
        id: "s3",
        start: 6.0,
        end: 7.4,
        firstWord: 8,
        lastWord: 10,
        text: "Then uh goodbye.",
        speaker: null,
      },
    ],
    speechSeconds: 4.6,
  };
}

export function talkSegments(source = TALK): SegmentMap {
  const segment = (id: string, first: string, last: string, start: number, end: number) => ({
    id,
    start,
    end,
    firstSentence: first,
    lastSentence: last,
    title: `Segment ${id}`,
    summary: "",
    role: "main" as const,
    priority: "should" as const,
    speaker: null,
  });
  return {
    source,
    origin: "semantic",
    transcriptVersion: "sha256:t",
    segments: [
      segment("g1", "s1", "s1", 0.5, 2.4),
      segment("g2", "s2", "s2", 2.6, 4.3),
      segment("g3", "s3", "s3", 6.0, 7.4),
    ],
  };
}

export function talkTakes(source = TALK): TakeAnalysis {
  return {
    source,
    issues: [
      {
        id: "t1",
        kind: "filler",
        start: 6.5,
        end: 6.7,
        sentences: ["s3"],
        confidence: 0.9,
        action: "cut",
        note: "uh",
        keep: null,
      },
    ],
  };
}

export function talkAnalysis(source = TALK, version = "v1"): SourceAnalysisData {
  return {
    source,
    kind: "video",
    duration: 8,
    transcript: talkTranscript(source),
    takes: talkTakes(source),
    silence: {
      source,
      thresholdDb: -40,
      minSilence: 0.3,
      silences: [{ start: 4.3, end: 6.0 }],
      silenceSeconds: 1.7,
    },
    segments: talkSegments(source),
    version,
  };
}

/** A fake analysis service: the fixture decides which sources are analysed. */
export interface FakeAnalysis extends StoryAnalysis {
  data: Map<string, SourceAnalysisData>;
}

function fakeAnalysis(project: TestProject): FakeAnalysis {
  const data = new Map<string, SourceAnalysisData>();
  return {
    data,
    async sourceData(_project, raw) {
      const source = raw.replace(/^\.\//, "");
      const known = data.get(source);
      if (known) return known;
      const asset = await project.facts.read(project.project.dir, source);
      if (!asset || (asset.kind !== "video" && asset.kind !== "audio")) {
        throw new AnalysisFailure("unknown_source", `${source} is not a media file`);
      }
      return {
        source,
        kind: asset.kind,
        duration: asset.duration,
        transcript: null,
        takes: null,
        silence: null,
        segments: null,
        version: "unanalyzed",
      };
    },
    async cleanOrphans() {
      return null;
    },
    async framePreview() {
      throw new Error("not used");
    },
  };
}

export interface StoryFixture {
  /** The stored graph as the service reports it. */
  graph(): Promise<StoryGraph>;
  made: TestProject;
  analysis: FakeAnalysis;
  service: StoryService;
  project: TestProject["project"];
  graphFile(): StoryGraph;
  view(): Promise<StoryView>;
  /** Applies agent operations; returns the response. */
  edit(
    operations: StoryOperation[],
    extra?: { turnId?: string; baseVersion?: string },
  ): Promise<StoryEditResponse>;
  /** The refusal an agent batch gets. */
  refusal(operations: StoryOperation[]): Promise<StoryFailure["error"]>;
  cleanup(): void;
}

export function createStoryFixture(
  options: { html?: string; analysed?: boolean } = {},
): StoryFixture {
  const made = createTestProject({
    html: options.html ?? BLANK_HTML,
    adapter: {
      captionSkinsDir: () => SKINS,
      listRegistryCatalog: async () => [BLOCK],
      installRegistryBlock: async ({ blockName }) => {
        const target = BLOCK.files[0]?.target ?? "";
        const abs = join(made.project.dir, target);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(
          abs,
          `<div id="sparkle-root" data-composition-id="${blockName}" data-width="1920" data-height="1080" data-duration="4"><div class="clip" data-start="0" data-duration="4" data-track-index="0">✨</div></div>`,
        );
        return { written: [target], block: BLOCK, primary: target };
      },
    },
  });
  const analysis = fakeAnalysis(made);
  if (options.analysed !== false) analysis.data.set(TALK, talkAnalysis());
  const service = new StoryService(made.adapter, analysis, { probe: fakeProber });
  const fixture: StoryFixture = {
    made,
    analysis,
    service,
    project: made.project,
    graphFile: () => JSON.parse(readFileSync(join(made.project.dir, STORY_GRAPH_PATH), "utf-8")),
    view: () => service.view(made.project),
    async graph() {
      const { graph } = await service.view(made.project);
      if (!graph) throw new Error("there is no story yet");
      return graph;
    },
    edit: (operations, extra = {}) => service.edit(made.project, { operations, ...extra }),
    async refusal(operations) {
      try {
        await service.edit(made.project, { operations });
      } catch (error) {
        if (isStoryFailure(error)) return error.error;
        throw error;
      }
      throw new Error("expected the batch to be refused");
    },
    cleanup: () => made.cleanup(),
  };
  return fixture;
}

/** The id an `add_node`-style result created. */
export function created(response: StoryEditResponse, index: number): string {
  const id = response.results[index]?.id;
  if (!id) throw new Error(`operation ${index} created nothing`);
  return id;
}
