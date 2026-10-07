// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VoiceSynthesisResult } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { readLedger } from "../../research/provenance.js";
import { VoiceFailure } from "../errors.js";
import { createVoiceFixture, wordsOf, type VoiceFixture } from "./testSupport.js";
import { readScript } from "./takesStore.js";

let fixture: VoiceFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

const OPENAI = { providerId: "openai", model: "gpt-4o-mini-tts" } as const;

async function failureOf(work: Promise<unknown>): Promise<VoiceFailure> {
  try {
    await work;
  } catch (error) {
    if (error instanceof VoiceFailure) return error;
    throw error;
  }
  throw new Error("expected a VoiceFailure");
}

async function setUp(
  options: Parameters<typeof createVoiceFixture>[0],
  lines: string[],
): Promise<VoiceFixture> {
  fixture = createVoiceFixture(options);
  await fixture.service.setVoice(fixture.project, { presetId: fixture.preset.id });
  await fixture.service.saveScript(fixture.project, {
    language: "en",
    lines: lines.map((text, index) => ({ id: `l${index + 1}`, text })),
  });
  return fixture;
}

const voiceFiles = (f: VoiceFixture) => {
  const folder = join(f.project.dir, "assets/voice");
  return existsSync(folder) ? readdirSync(folder).sort() : [];
};

describe("synthesis, one request per line", () => {
  it("writes the files into assets/voice, selects the takes and records provenance", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there.", "This is the second line."]);
    const result = await f.service.synthesize(f.project, {
      requestId: "request-0001",
      agent: "director",
      turnId: "turn-1",
    });
    expect(f.engine.calls).toHaveLength(2);
    expect(result.requests).toBe(2);
    expect(result.usdCost).toBeGreaterThan(0);
    expect(result.lines.map((entry) => entry.lineId)).toEqual(["l1", "l2"]);

    const files = voiceFiles(f);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^hello-there-[0-9a-f]{8}\.wav$/);

    const script = readScript(f.project.dir);
    for (const line of script.lines) {
      const selected = line.takes.find((take) => take.id === line.selectedTakeId);
      expect(selected?.file).toMatch(/^assets\/voice\//);
      expect(existsSync(join(f.project.dir, selected?.file ?? "missing"))).toBe(true);
      expect(selected).toMatchObject({
        start: 0,
        presetId: "preset-1",
        scene: null,
        createdBy: { agent: "director", turnId: "turn-1" },
      });
    }
    // No scratch left behind.
    expect(readdirSync(join(f.project.dir, ".hyperframes/voice")).sort()).toEqual([
      "takes.json",
      "tmp",
    ]);
    expect(readdirSync(join(f.project.dir, ".hyperframes/voice/tmp"))).toEqual([]);

    const records = readLedger(f.project.dir).records;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      mediaKind: "audio",
      source: { id: "voice:openai", name: "OpenAI", trusted: true },
      retrievedBy: { agent: "director", turnId: "turn-1" },
    });
    expect(f.service.progress(f.project, "request-0001")).toMatchObject({
      state: "done",
      done: 2,
      total: 2,
    });
  });

  it("does not generate lines that already have a current take", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there.", "Second."]);
    await f.service.synthesize(f.project, { requestId: "request-0001" });
    const again = await f.service.synthesize(f.project, { requestId: "request-0002" });
    expect(f.engine.calls).toHaveLength(2);
    expect(again.requests).toBe(0);
    expect(again.lines.every((entry) => entry.cached)).toBe(true);
  });

  it("serves an identical request from the cache and reuses its file", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there."]);
    const first = await f.service.synthesize(f.project, { requestId: "request-0001" });
    // The same words under a new line id: the same request hash, answered by the cache, into the same file.
    await f.service.saveScript(f.project, { lines: [{ id: "l2", text: "Hello there." }] });
    const again = await f.service.synthesize(f.project, { requestId: "request-0002" });
    expect(f.engine.calls).toHaveLength(2);
    expect(again.lines[0]?.cached).toBe(true);
    expect(again.requests).toBe(0);
    expect(again.lines[0]?.take.file).toBe(first.lines[0]?.take.file);
    expect(voiceFiles(f)).toHaveLength(1);
    expect(readLedger(f.project.dir).records).toHaveLength(1);
  });

  it("force regenerates: the provider is asked again and the take is a new reading in its own file", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there."]);
    const first = await f.service.synthesize(f.project, { requestId: "request-0001" });
    const again = await f.service.synthesize(f.project, { requestId: "request-0002", force: true });
    expect(f.engine.calls).toHaveLength(2);
    expect(f.engine.calls[1]?.fresh).toBe(true);
    expect(again.requests).toBe(1);
    expect(again.lines[0]?.cached).toBe(false);
    expect(again.lines[0]?.take.id).not.toBe(first.lines[0]?.take.id);
    expect(again.lines[0]?.take.file).not.toBe(first.lines[0]?.take.file);
    expect(voiceFiles(f)).toHaveLength(2);
    const line = readScript(f.project.dir).lines[0];
    expect(line?.takes).toHaveLength(2);
    expect(line?.selectedTakeId).toBe(again.lines[0]?.take.id);
  });

  it("a forced regenerate that reads the same bytes is paid, not cached, and adds no take", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there."]);
    f.engine.deterministic = true;
    const first = await f.service.synthesize(f.project, { requestId: "request-0001" });
    const again = await f.service.synthesize(f.project, { requestId: "request-0002", force: true });
    expect(f.engine.calls).toHaveLength(2);
    expect(again.lines[0]).toMatchObject({ cached: false, duplicate: true });
    expect(again.lines[0]?.take.id).toBe(first.lines[0]?.take.id);
    expect(readScript(f.project.dir).lines[0]?.takes).toHaveLength(1);
  });

  it("check with force counts the line as paid, not cached", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there."]);
    await f.service.synthesize(f.project, { requestId: "request-0001" });
    expect((await f.service.check(f.project, {})).estimate).toMatchObject({
      cachedLines: 1,
      requests: 0,
    });
    const forced = await f.service.check(f.project, { force: true });
    expect(forced.estimate).toMatchObject({ cachedLines: 0, requests: 1 });
    expect(forced.estimate.usdCost).toBeGreaterThan(0);
    expect(f.engine.calls).toHaveLength(1);
  });

  it("adds a take when the line's text changed and keeps the old one selectable", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there."]);
    const first = await f.service.synthesize(f.project, { requestId: "request-0001" });
    await f.service.saveScript(f.project, { lines: [{ id: "l1", text: "Hello again." }] });
    expect((await f.service.script(f.project)).lines[0]?.textChanged).toBe(true);
    const second = await f.service.synthesize(f.project, { requestId: "request-0002" });
    expect(second.requests).toBe(1);
    const line = readScript(f.project.dir).lines[0];
    expect(line?.takes).toHaveLength(2);
    expect(line?.selectedTakeId).toBe(second.lines[0]?.take.id);
    const view = await f.service.selectTake(f.project, "l1", {
      takeId: first.lines[0]?.take.id ?? "",
    });
    expect(view.lines[0]?.selectedTakeId).toBe(first.lines[0]?.take.id);
    expect(f.engine.calls).toHaveLength(2);
  });

  it("regenerates when the preset's settings, style or the language changed", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there."]);
    await f.service.synthesize(f.project, { requestId: "request-0001" });
    expect((await f.service.check(f.project, {})).estimate.cachedLines).toBe(1);

    f.engine.presets.set("preset-1", { ...f.preset, settings: { speed: 1.2 } });
    await f.service.setVoice(f.project, { presetId: "preset-1" });
    expect((await f.service.check(f.project, {})).estimate).toMatchObject({
      cachedLines: 0,
      requests: 1,
    });
    const second = await f.service.synthesize(f.project, { requestId: "request-0002" });
    expect(second.requests).toBe(1);

    f.engine.presets.set("preset-1", { ...f.preset, settings: { speed: 1.2 }, style: "warm" });
    await f.service.setVoice(f.project, { presetId: "preset-1" });
    expect((await f.service.check(f.project, {})).estimate.requests).toBe(1);
    await f.service.synthesize(f.project, { requestId: "request-0003" });

    await f.service.saveScript(f.project, {
      language: "de",
      lines: [{ id: "l1", text: "Hello there." }],
    });
    expect((await f.service.check(f.project, {})).estimate.requests).toBe(1);
    expect(readScript(f.project.dir).lines[0]?.takes).toHaveLength(3);
  });

  it("checks the preset's style against the dialect before anything is paid", async () => {
    const f = await setUp({ preset: { style: "x".repeat(300) } }, ["Hello there."]);
    const check = await f.service.check(f.project, {});
    expect(check.ok).toBe(false);
    expect(check.issues.some((issue) => issue.code === "style_too_long")).toBe(true);
    const failure = await failureOf(f.service.synthesize(f.project, { requestId: "request-0001" }));
    expect(failure.code).toBe("dialect_violation");
    expect(f.engine.calls).toHaveLength(0);
  });

  it("never overwrites a file whose bytes differ: new audio under the same request gets its own name", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there."]);
    const first = await f.service.synthesize(f.project, { requestId: "request-0001" });
    const oldFile = first.lines[0]?.take.file ?? "";
    const oldBytes = readFileSync(join(f.project.dir, oldFile), "utf-8");
    f.engine.forgetCache();
    const again = await f.service.synthesize(f.project, { requestId: "request-0002", force: true });
    const newTake = again.lines[0]?.take;
    expect(newTake?.file).not.toBe(oldFile);
    expect(readFileSync(join(f.project.dir, oldFile), "utf-8")).toBe(oldBytes);
    expect(voiceFiles(f)).toHaveLength(2);
    const line = readScript(f.project.dir).lines[0];
    expect(line?.takes.map((take) => take.file)).toContain(oldFile);
    expect(line?.selectedTakeId).toBe(newTake?.id);
  });

  it("refuses a foreign tag syntax with dialect_violation before any request", async () => {
    const f = await setUp({}, ["Welcome back [laugh] friends."]);
    const failure = await failureOf(f.service.synthesize(f.project, { requestId: "request-0001" }));
    expect(failure.code).toBe("dialect_violation");
    expect(failure.status).toBe(422);
    expect(failure.issues?.some((issue) => issue.code === "foreign_tag_syntax")).toBe(true);
    expect(f.engine.calls).toHaveLength(0);
    expect(voiceFiles(f)).toEqual([]);
    expect(f.service.progress(f.project, "request-0001").state).toBe("failed");

    const check = await f.service.check(f.project, {});
    expect(check.ok).toBe(false);
    expect(f.engine.calls).toHaveLength(0);
  });

  it("answers not_configured without a voice and without a key", async () => {
    fixture = createVoiceFixture({ preset: OPENAI });
    const f = fixture;
    await f.service.saveScript(f.project, { lines: [{ id: "l1", text: "Hello there." }] });
    expect(
      (await failureOf(f.service.synthesize(f.project, { requestId: "request-0001" }))).code,
    ).toBe("not_configured");
    await f.service.setVoice(f.project, { presetId: f.preset.id });
    f.engine.configured.delete("openai");
    expect(
      (await failureOf(f.service.synthesize(f.project, { requestId: "request-0002" }))).code,
    ).toBe("not_configured");
    expect(f.engine.calls).toHaveLength(0);
  });

  it("leaves no file and no take when it is cancelled before the commit", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there.", "Second line."]);
    let release: () => void = () => undefined;
    f.engine.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.service.synthesize(f.project, { requestId: "request-cancel" });
    const outcome = failureOf(pending);
    expect(f.service.cancel(f.project, "request-cancel")).toBe("cancelled");
    release();
    const failure = await outcome;
    expect(failure.code).toBe("cancelled");
    expect(voiceFiles(f)).toEqual([]);
    expect(readScript(f.project.dir).lines.every((line) => line.takes.length === 0)).toBe(true);
    expect(existsSync(join(f.project.dir, ".hyperframes/research/provenance.json"))).toBe(false);
    expect(f.service.progress(f.project, "request-cancel").state).toBe("cancelled");
  });

  it("a client that went away cancels like the cancel route", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there."]);
    let release: () => void = () => undefined;
    f.engine.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new AbortController();
    const outcome = failureOf(
      f.service.synthesize(f.project, { requestId: "request-gone" }, client.signal),
    );
    client.abort();
    release();
    expect((await outcome).code).toBe("cancelled");
    expect(voiceFiles(f)).toEqual([]);
  });

  it("keeps what was generated when a later line fails, and reports the failure", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there.", "Second line."]);
    f.engine.failAfter = 1;
    f.engine.failure = new VoiceFailure("rate_limited", "Slow down");
    const failure = await failureOf(f.service.synthesize(f.project, { requestId: "request-0001" }));
    expect(failure.code).toBe("rate_limited");
    const lines = readScript(f.project.dir).lines;
    expect(lines[0]?.takes).toHaveLength(1);
    expect(lines[1]?.takes).toHaveLength(0);
    // A retry only generates the missing line.
    f.engine.failAfter = null;
    const retry = await f.service.synthesize(f.project, { requestId: "request-0002" });
    expect(retry.requests).toBe(1);
    expect(f.engine.calls).toHaveLength(2);
  });

  it("refuses a request id that is already in use and reports unknown ones", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there."]);
    await f.service.synthesize(f.project, { requestId: "request-0001" });
    expect(
      (await failureOf(f.service.synthesize(f.project, { requestId: "request-0001" }))).code,
    ).toBe("invalid_request");
    expect(() => f.service.progress(f.project, "request-unknown")).toThrow(/No voice request/);
  });

  it("sweeps the scratch directory when the service first touches a project", async () => {
    fixture = createVoiceFixture({ preset: OPENAI });
    const scratch = join(fixture.project.dir, ".hyperframes/voice/tmp/old-run");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "1-abcd.wav"), "partial");
    fixture.service.script(fixture.project);
    expect(existsSync(join(fixture.project.dir, ".hyperframes/voice/tmp"))).toBe(false);
  });
});

describe("estimate", () => {
  it("counts requests, pace and cost, and calls a generated line free", async () => {
    const f = await setUp({ preset: OPENAI }, ["Hello there.", "Second line here."]);
    const before = await f.service.check(f.project, {});
    expect(before.ok).toBe(true);
    expect(before.estimate).toMatchObject({
      lines: 2,
      cachedLines: 0,
      requests: 2,
      scene: false,
      charsPerSecond: 14,
    });
    expect(before.estimate.usdCost).toBeGreaterThan(0);
    expect(before.estimate.seconds).toBeGreaterThan(0);
    expect(before.dialect.id).toBe("openai-gpt-4o-mini-tts");
    await f.service.synthesize(f.project, { requestId: "request-0001" });
    const after = await f.service.check(f.project, {});
    expect(after.estimate).toMatchObject({ cachedLines: 2, requests: 0, usdCost: 0 });
  });

  it("measures the pace on the preset's sample", async () => {
    const f = await setUp(
      {
        preset: {
          ...OPENAI,
          sample: {
            text: "x".repeat(40),
            audio: {
              url: "/api/voice/audio/x",
              hash: "x".repeat(64),
              durationSeconds: 4,
              mimeType: "audio/wav",
            },
            createdAt: 1,
          },
        },
      },
      ["Hello there."],
    );
    expect((await f.service.check(f.project, {})).estimate.charsPerSecond).toBe(10);
  });
});

describe("scenes", () => {
  const LINES = [
    "Hello there my friend.",
    "This is the second line of the scene.",
    "And this one closes it.",
  ];

  it("makes one request per scene and splits it by the recognised words of each line", async () => {
    const f = await setUp({}, LINES);
    const check = await f.service.check(f.project, {});
    expect(check.estimate).toMatchObject({ requests: 1, scene: true });

    const result = await f.service.synthesize(f.project, { requestId: "request-scene" });
    expect(f.engine.calls).toHaveLength(1);
    expect(f.engine.calls[0]?.text).toBe(LINES.join("\n"));
    expect(result.notes).toEqual([]);
    expect(result.requests).toBe(1);

    const files = voiceFiles(f);
    expect(files).toHaveLength(1);
    const takes = result.lines.map((entry) => entry.take);
    expect(new Set(takes.map((take) => take.file)).size).toBe(1);
    expect(new Set(takes.map((take) => take.scene)).size).toBe(1);
    expect(takes[0]?.scene).toMatch(/^scene-/);

    const expected = wordsOf(LINES.join("\n"));
    // Lines read at 0.4 s per word with a 0.6 s pause between lines: the ranges follow the line's own words.
    const firstWords = [0, 4, 12];
    const lengths = LINES.map((line) => line.split(" ").length);
    for (const [index, take] of takes.entries()) {
      const first = expected[firstWords[index] ?? 0];
      const last = expected[(firstWords[index] ?? 0) + (lengths[index] ?? 1) - 1];
      expect(take.start).toBeLessThanOrEqual(first?.start ?? 0);
      expect(take.start).toBeGreaterThan((first?.start ?? 0) - 0.31);
      expect(take.end).toBeGreaterThanOrEqual(last?.end ?? 0);
      expect(take.end).toBeLessThan((last?.end ?? 0) + 0.31);
      expect(take.words).toHaveLength(lengths[index] ?? 0);
      expect(take.words?.[0]?.start).toBeCloseTo((first?.start ?? 0) - take.start, 2);
    }
    for (let index = 1; index < takes.length; index += 1) {
      expect(takes[index]?.start).toBeGreaterThanOrEqual(takes[index - 1]?.end ?? 0);
    }
    // One file, so one provenance record.
    expect(readLedger(f.project.dir).records).toHaveLength(1);
  });

  it("falls back to one request per line when recognition is unavailable", async () => {
    const f = await setUp({ transcribe: async () => ({ unavailable: "no recognizer" }) }, LINES);
    const result = await f.service.synthesize(f.project, { requestId: "request-scene" });
    // The scene request was made (and paid), then each line was asked for on its own.
    expect(f.engine.calls).toHaveLength(1 + LINES.length);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatch(/one request per line/);
    expect(result.notes[0]).toMatch(/no recognizer/);
    expect(voiceFiles(f)).toHaveLength(LINES.length);
    expect(result.lines.every((entry) => entry.take.scene === null && entry.take.start === 0)).toBe(
      true,
    );
  });

  it("falls back when the recognised words do not match the script", async () => {
    const f = await setUp(
      {
        transcribe: async () => ({
          words: wordsOf("completely unrelated words that were somehow heard instead"),
          language: "en",
          producer: "fake",
        }),
      },
      LINES,
    );
    const result = await f.service.synthesize(f.project, { requestId: "request-scene" });
    expect(result.notes[0]).toMatch(/only \d+ of \d+ words/);
    expect(result.lines).toHaveLength(LINES.length);
    expect(f.engine.calls).toHaveLength(1 + LINES.length);
  });

  it("falls back when recognition throws", async () => {
    const f = await setUp(
      {
        transcribe: async () => {
          throw new Error("whisper crashed");
        },
      },
      LINES,
    );
    const result = await f.service.synthesize(f.project, { requestId: "request-scene" });
    expect(result.notes[0]).toMatch(/whisper crashed/);
  });

  it("never joins scenes of different delivery", async () => {
    fixture = createVoiceFixture({});
    const f = fixture;
    await f.service.setVoice(f.project, { presetId: f.preset.id });
    await f.service.saveScript(f.project, {
      lines: [
        { id: "l1", text: "Calm first line here." },
        { id: "l2", text: "Excited second line here.", style: "excited" },
      ],
    });
    const check = await f.service.check(f.project, {});
    expect(check.estimate.requests).toBe(2);
    const result: VoiceSynthesisResult = await f.service.synthesize(f.project, {
      requestId: "request-style",
    });
    expect(result.requests).toBe(2);
    expect(readFileSync(join(f.project.dir, ".hyperframes/voice/takes.json"), "utf-8")).toContain(
      "excited",
    );
  });
});
