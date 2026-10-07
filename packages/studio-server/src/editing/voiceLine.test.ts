// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  VOICE_SCRIPT_SCHEMA,
  parseApplyEditsRequest,
  type VoiceScript,
  type VoiceTake,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { classifyMediaColor } from "../helpers/mediaMetadata.js";
import { isEditFailure } from "./errors.js";
import { MediaFacts } from "./mediaFacts.js";
import { applyEdits } from "./operations.js";
import { readTimeline } from "./service.js";
import { createTestProject, type TestProject } from "./testProject.js";

let project: TestProject | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

const TAKE: VoiceTake = {
  id: "take-1",
  file: "assets/voice/hello-12345678.wav",
  start: 1.5,
  end: 4,
  speakerText: "Hello",
  style: "",
  presetId: "preset-1",
  model: "gemini-3.8-flash-tts",
  voiceId: "Kore",
  requestHash: "a".repeat(64),
  scene: "scene-1",
  usdCost: null,
  createdAt: 1,
  createdBy: { agent: "user", turnId: null },
};

function setUp(
  script: Partial<VoiceScript["lines"][number]>[] = [
    { id: "intro", takes: [TAKE], selectedTakeId: "take-1" },
  ],
) {
  const made = createTestProject();
  project = made;
  made.write("assets/voice/hello-12345678.wav", "audio");
  const stored: VoiceScript = {
    schema: VOICE_SCRIPT_SCHEMA,
    language: "en",
    voice: null,
    updatedAt: 1,
    lines: script.map((line, index) => ({
      id: `line-${index}`,
      text: "Hello",
      speakerText: "Hello",
      style: "",
      presetId: null,
      takes: [],
      selectedTakeId: null,
      ...line,
    })),
  };
  mkdirSync(dirname(join(made.project.dir, ".hyperframes/voice/takes.json")), { recursive: true });
  writeFileSync(join(made.project.dir, ".hyperframes/voice/takes.json"), JSON.stringify(stored));
  const facts = new MediaFacts(async (path) => ({
    kind: path.endsWith(".wav") ? "audio" : "unknown",
    color: classifyMediaColor(null),
    durationSeconds: 6,
  }));
  return { made, facts };
}

async function apply(made: TestProject, facts: MediaFacts, operations: unknown[]) {
  const parsed = parseApplyEditsRequest({ operations });
  if (!parsed.ok) throw new Error(parsed.message);
  return applyEdits(
    { project: made.project, compositionPath: "index.html", adapter: made.adapter, facts },
    parsed.value,
  );
}

describe("add_clip voiceLine", () => {
  it("places the selected take with its range and joins the voiceover group", async () => {
    const { made, facts } = setUp();
    const { results } = await apply(made, facts, [
      { op: "add_clip", voiceLine: "intro", start: 1, track: 7 },
    ]);
    const html = made.read("index.html");
    expect(html).toContain('data-ov-voice-line="intro"');
    expect(html).toContain('data-audio-group="voiceover"');
    expect(html).toContain('src="assets/voice/hello-12345678.wav"');
    expect(html).toContain('data-media-start="1.5"');
    expect(html).toContain('data-duration="2.5"');
    expect(html).toMatch(/<hf-audio-group [^>]*id="voiceover"[^>]*data-label="Voiceover"/);
    const timeline = await readTimeline(made.project, "index.html", facts);
    const clip = timeline.clips.find((entry) => entry.id === results[0]?.clipId);
    expect(clip).toMatchObject({ kind: "audio", start: 1, duration: 2.5, mediaStart: 1.5 });
  });

  it("creates the audio group once and an explicit duration wins", async () => {
    const { made, facts } = setUp();
    await apply(made, facts, [{ op: "add_clip", voiceLine: "intro", start: 0, track: 7 }]);
    await apply(made, facts, [
      { op: "add_clip", voiceLine: "intro", start: 5, track: 7, duration: 1 },
    ]);
    const html = made.read("index.html");
    expect(html.match(/<hf-audio-group/g)).toHaveLength(1);
    expect(html.match(/data-ov-voice-line="intro"/g)).toHaveLength(2);
    expect(html).toContain('data-duration="1"');
  });

  it("refuses an unknown line and a line without a take", async () => {
    const { made, facts } = setUp([
      { id: "x", takes: [TAKE], selectedTakeId: "take-1" },
      { id: "y" },
    ]);
    for (const voiceLine of ["missing", "y"]) {
      try {
        await apply(made, facts, [{ op: "add_clip", voiceLine, start: 0, track: 1 }]);
        throw new Error("expected the edit to be refused");
      } catch (error) {
        expect(isEditFailure(error)).toBe(true);
      }
    }
    expect(made.read("index.html")).not.toContain("data-ov-voice-line");
  });
});

describe("add_clip voiceLine parsing", () => {
  it("accepts the line without an asset and refuses a bad id", () => {
    const ok = parseApplyEditsRequest({
      operations: [{ op: "add_clip", voiceLine: "intro", start: 0, track: 1 }],
    });
    expect(ok.ok).toBe(true);
    // A model filling every listed field sends `asset: ""` next to the line (seen in a live turn).
    const emptyAsset = parseApplyEditsRequest({
      operations: [{ op: "add_clip", asset: "", voiceLine: "intro", start: 0, track: 1 }],
    });
    expect(emptyAsset.ok).toBe(true);
    const bad = parseApplyEditsRequest({
      operations: [{ op: "add_clip", voiceLine: "../x", start: 0, track: 1 }],
    });
    expect(bad.ok).toBe(false);
    const noAsset = parseApplyEditsRequest({
      operations: [{ op: "add_clip", start: 0, track: 1 }],
    });
    expect(noAsset.ok).toBe(false);
  });
});
