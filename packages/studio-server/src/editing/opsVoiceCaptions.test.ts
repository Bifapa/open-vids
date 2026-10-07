// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  VOICE_SCRIPT_SCHEMA,
  parseApplyEditsRequest,
  type VoiceScript,
  type VoiceTake,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { classifyMediaColor } from "../helpers/mediaMetadata.js";
import type { SpeechTranscription, StudioApiAdapter } from "../types.js";
import { readStoredGroups } from "./captionData.js";
import { captionsFileFor } from "./captions.js";
import { isEditFailure } from "./errors.js";
import { MediaFacts } from "./mediaFacts.js";
import { applyEdits } from "./operations.js";
import { createTestProject, type TestProject } from "./testProject.js";

const SKINS = join(import.meta.dirname, "../../../../skills/hyperframes-creative/frame-presets");

let project: TestProject | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
});

const words = (...entries: Array<[string, number, number]>) =>
  entries.map(([text, start, end]) => ({ text, start, end }));

/** "In July twenty twenty-two we left. It was fine." as the recognizer hears the first line's take. */
const INTRO_WORDS = words(
  ["in", 0.1, 0.3],
  ["july", 0.4, 0.7],
  ["twenty", 0.8, 1.1],
  ["twenty-two", 1.2, 1.7],
  ["we", 1.8, 1.9],
  ["left", 2.0, 2.3],
  ["it", 2.6, 2.7],
  ["was", 2.8, 3.0],
  ["fine", 3.1, 3.4],
);

const takeOf = (overrides: Partial<VoiceTake>): VoiceTake => ({
  id: "take-intro",
  file: "assets/voice/a.wav",
  start: 0,
  end: 4,
  speakerText: "",
  style: "",
  presetId: "preset-1",
  model: "m",
  voiceId: "v",
  requestHash: "a".repeat(64),
  scene: null,
  usdCost: null,
  createdAt: 1,
  createdBy: { agent: "user", turnId: null },
  ...overrides,
});

type Transcribe = NonNullable<StudioApiAdapter["transcribeMedia"]>;

interface Fixture {
  made: TestProject;
  facts: MediaFacts;
  transcribe: Mock<Transcribe>;
}

function setUp(
  lines: Array<{ id: string; text: string; take: VoiceTake | null }>,
  heard: SpeechTranscription | { unavailable: string } = {
    words: INTRO_WORDS,
    language: "en",
    producer: "fake",
  },
): Fixture {
  const transcribe = vi.fn(async () => heard);
  const made = createTestProject({
    adapter: { captionSkinsDir: () => SKINS, transcribeMedia: transcribe },
  });
  project = made;
  made.write("assets/voice/a.wav", "audio a");
  made.write("assets/voice/b.wav", "audio b");
  const script: VoiceScript = {
    schema: VOICE_SCRIPT_SCHEMA,
    language: "en-US",
    voice: null,
    updatedAt: 1,
    lines: lines.map(({ id, text, take }) => ({
      id,
      text,
      speakerText: text,
      style: "",
      presetId: null,
      takes: take ? [take] : [],
      selectedTakeId: take?.id ?? null,
    })),
  };
  const file = join(made.project.dir, ".hyperframes/voice/takes.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(script));
  const facts = new MediaFacts(async (path) => ({
    kind: path.endsWith(".wav") ? "audio" : "unknown",
    color: classifyMediaColor(null),
    durationSeconds: 20,
  }));
  return { made, facts, transcribe };
}

async function apply({ made, facts }: Fixture, operations: unknown[], dryRun = false) {
  const parsed = parseApplyEditsRequest({ operations, ...(dryRun && { dryRun }) });
  if (!parsed.ok) throw new Error(parsed.message);
  return applyEdits(
    { project: made.project, compositionPath: "index.html", adapter: made.adapter, facts },
    parsed.value,
  );
}

async function refusal(fixture: Fixture, operations: unknown[]) {
  try {
    await apply(fixture, operations);
  } catch (error) {
    if (isEditFailure(error)) return error.error;
    throw error;
  }
  throw new Error("expected the batch to be refused");
}

const groupsOf = (made: TestProject) =>
  (readStoredGroups(made.read(captionsFileFor("index.html"))) ?? []).map((group) => [
    group.text,
    group.start,
    group.end,
  ]);

const INTRO = {
  id: "intro",
  text: "In July 2022 we left. It was fine.",
  take: takeOf({ words: INTRO_WORDS }),
};
const NEXT = {
  id: "next",
  text: "Next one.",
  // A scene take: the line is the range 5–8 s of the file, its words relative to 5.
  take: takeOf({
    id: "take-next",
    file: "assets/voice/b.wav",
    start: 5,
    end: 8,
    words: words(["next", 0.2, 0.5], ["one", 0.6, 0.9]),
  }),
};

describe("captions_from_voiceover", () => {
  it("shows the line's source text timed by the take's words, offset to the clip", async () => {
    const f = setUp([INTRO]);
    await apply(f, [{ op: "add_clip", voiceLine: "intro", start: 3, track: 7 }]);
    const { results } = await apply(f, [{ op: "captions_from_voiceover", preset: "coral" }]);
    // "2022" took the span of "twenty twenty-two"; the sentence ends of the source text break the cues.
    expect(groupsOf(f.made)).toEqual([
      ["In July 2022 we left.", 3.1, 5.3],
      ["It was fine.", 5.6, 6.4],
    ]);
    expect(results[0]?.note).toBe("2 cues from 1 voice line, 3.1–6.4 s");
    expect(f.transcribe).not.toHaveBeenCalled();
  });

  it("uses the clip's in-point and trims words outside what the clip plays", async () => {
    const f = setUp([INTRO]);
    await apply(f, [
      { op: "add_clip", voiceLine: "intro", start: 20, track: 7, mediaStart: 1.8, duration: 1 },
    ]);
    await apply(f, [{ op: "captions_from_voiceover", preset: "coral" }]);
    // Words whose middle is in 1.8–2.8 s of the file: "we", "left", "it". "was" begins after the clip ends.
    expect(groupsOf(f.made)).toEqual([
      ["we left.", 20, 20.5],
      ["It", 20.8, 21],
    ]);
  });

  it("follows the clip's speed", async () => {
    const f = setUp([INTRO]);
    const placed = await apply(f, [{ op: "add_clip", voiceLine: "intro", start: 3, track: 7 }]);
    await apply(f, [{ op: "set_speed", clip: placed.results[0]?.clipId ?? "", rate: 2 }]);
    await apply(f, [{ op: "captions_from_voiceover", preset: "coral" }]);
    expect(groupsOf(f.made)).toEqual([
      ["In July 2022 we left.", 3.05, 4.15],
      ["It was fine.", 4.3, 4.7],
    ]);
  });

  it("merges the lines and counts a scene take from its own start", async () => {
    const f = setUp([INTRO, NEXT]);
    await apply(f, [
      { op: "add_clip", voiceLine: "next", start: 10, track: 8 },
      { op: "add_clip", voiceLine: "intro", start: 3, track: 7 },
    ]);
    const { results } = await apply(f, [{ op: "captions_from_voiceover", preset: "coral" }]);
    expect(groupsOf(f.made)).toEqual([
      ["In July 2022 we left.", 3.1, 5.3],
      ["It was fine.", 5.6, 6.4],
      ["Next one.", 10.2, 10.9],
    ]);
    expect(results[0]?.note).toContain("3 cues from 2 voice lines");
    // `lines` narrows it, and the captions are replaced, not stacked.
    await apply(f, [{ op: "captions_from_voiceover", preset: "coral", lines: ["next"] }]);
    expect(groupsOf(f.made)).toEqual([["Next one.", 10.2, 10.9]]);
    expect(f.made.read("index.html").match(/data-track-kind="captions"/g)).toHaveLength(1);
  });

  it("takes the first bundled preset when none is named", async () => {
    const f = setUp([INTRO]);
    await apply(f, [{ op: "add_clip", voiceLine: "intro", start: 3, track: 7 }]);
    await apply(f, [{ op: "captions_from_voiceover" }]);
    expect(groupsOf(f.made)).toHaveLength(2);
  });

  it("transcribes a take without words once, stores them, and captions from them", async () => {
    const f = setUp([{ ...INTRO, take: takeOf({}) }]);
    await apply(f, [{ op: "add_clip", voiceLine: "intro", start: 3, track: 7 }]);
    await apply(f, [{ op: "captions_from_voiceover", preset: "coral" }]);
    expect(f.transcribe).toHaveBeenCalledTimes(1);
    expect(f.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en", inputPath: expect.stringMatching(/a\.wav$/) }),
    );
    expect(groupsOf(f.made)[0]).toEqual(["In July 2022 we left.", 3.1, 5.3]);
    const stored: VoiceScript = JSON.parse(
      readFileSync(join(f.made.project.dir, ".hyperframes/voice/takes.json"), "utf-8"),
    );
    expect(stored.lines[0]?.takes[0]?.words).toHaveLength(INTRO_WORDS.length);
    // The next captions use the stored words.
    await apply(f, [{ op: "captions_from_voiceover", preset: "coral" }]);
    expect(f.transcribe).toHaveBeenCalledTimes(1);
  });

  it("recognises into nothing on a dry run or a refused batch, and stores the words only after a real apply", async () => {
    const f = setUp([{ ...INTRO, take: takeOf({}) }]);
    await apply(f, [{ op: "add_clip", voiceLine: "intro", start: 3, track: 7 }]);
    const takesFile = join(f.made.project.dir, ".hyperframes/voice/takes.json");
    const before = readFileSync(takesFile);
    const composition = f.made.read("index.html");

    // Studio's dry run: the captions are worked out, nothing is written anywhere.
    const planned = await apply(f, [{ op: "captions_from_voiceover", preset: "coral" }], true);
    expect(planned.changedFiles).toContain(captionsFileFor("index.html"));
    expect(readFileSync(takesFile).equals(before)).toBe(true);
    expect(f.made.read("index.html")).toBe(composition);

    // A batch refused after the captions operation ran writes nothing either.
    expect(
      await refusal(f, [
        { op: "captions_from_voiceover", preset: "coral" },
        { op: "remove_clip", clip: "no-such-clip" },
      ]),
    ).toMatchObject({ code: "unknown_clip", opIndex: 1 });
    expect(readFileSync(takesFile).equals(before)).toBe(true);

    // The real apply stores the words; the recognition made for the dry run is reused, not paid again.
    await apply(f, [{ op: "captions_from_voiceover", preset: "coral" }]);
    const stored: VoiceScript = JSON.parse(readFileSync(takesFile, "utf-8"));
    expect(stored.lines[0]?.takes[0]?.words).toHaveLength(INTRO_WORDS.length);
    expect(f.transcribe).toHaveBeenCalledTimes(1);
  });

  it("refuses when recognition is unavailable and the take has no words", async () => {
    const f = setUp([{ ...INTRO, take: takeOf({}) }], { unavailable: "no whisper" });
    await apply(f, [{ op: "add_clip", voiceLine: "intro", start: 3, track: 7 }]);
    expect(await refusal(f, [{ op: "captions_from_voiceover", preset: "coral" }])).toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("no whisper"),
    });
  });

  it("refuses with nothing to caption, an unknown preset, or a line no clip speaks", async () => {
    const f = setUp([INTRO, NEXT]);
    expect(await refusal(f, [{ op: "captions_from_voiceover", preset: "coral" }])).toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("add_clip voiceLine"),
    });
    await apply(f, [{ op: "add_clip", voiceLine: "intro", start: 3, track: 7 }]);
    expect(
      await refusal(f, [{ op: "captions_from_voiceover", preset: "coral", lines: ["next"] }]),
    ).toMatchObject({ code: "unknown_clip" });
    expect(
      await refusal(f, [{ op: "captions_from_voiceover", preset: "no-such-preset" }]),
    ).toMatchObject({ code: "unknown_preset" });
  });
});

describe("captions_from_voiceover parsing", () => {
  it("accepts the optional fields and refuses bad ones", () => {
    const parse = (op: Record<string, unknown>) =>
      parseApplyEditsRequest({ operations: [{ op: "captions_from_voiceover", ...op }] });
    expect(parse({}).ok).toBe(true);
    expect(parse({ preset: "coral", track: 9, lines: ["a", "b-1"] })).toMatchObject({
      ok: true,
      value: {
        operations: [
          { op: "captions_from_voiceover", preset: "coral", track: 9, lines: ["a", "b-1"] },
        ],
      },
    });
    expect(parse({ lines: [] }).ok).toBe(false);
    expect(parse({ lines: ["a", "a"] }).ok).toBe(false);
    expect(parse({ lines: ["bad id"] }).ok).toBe(false);
    expect(parse({ maxWords: 3 }).ok).toBe(false);
  });
});
