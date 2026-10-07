// @vitest-environment node
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SpeechTranscription } from "../../types.js";
import { VoiceFailure } from "../errors.js";
import type { TranscribeMedia } from "./synthesize.js";
import { createVoiceFixture, wordsOf, type VoiceFixture } from "./testSupport.js";
import { readScript } from "./takesStore.js";

let fixture: VoiceFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

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
  fixture?.cleanup();
  fixture = createVoiceFixture({
    ...options,
    preset: { providerId: "openai", model: "gpt-4o-mini-tts" },
  });
  await fixture.service.setVoice(fixture.project, { presetId: fixture.preset.id });
  await fixture.service.saveScript(fixture.project, {
    language: "en-US",
    lines: lines.map((text, index) => ({ id: `l${index + 1}`, text })),
  });
  return fixture;
}

const limited = (retryAfterSeconds: number, daily = false) =>
  new VoiceFailure("rate_limited", "Rate limit exceeded", {
    retryAfterSeconds,
    ...(daily && { daily: 1 }),
  });

/** A recognizer that hears the engine's last request, like the fixture's own, and records what it was asked. */
function hearing(holder: { fixture?: VoiceFixture }, languages: Array<string | undefined>) {
  const transcribe: TranscribeMedia = async ({ language }): Promise<SpeechTranscription> => {
    languages.push(language);
    const calls = holder.fixture?.engine.calls ?? [];
    return {
      words: wordsOf(calls[calls.length - 1]?.text ?? ""),
      language: "en",
      producer: "fake",
    };
  };
  return transcribe;
}

describe("words of a one-line take", () => {
  it("transcribes each take after it is generated and stores the words relative to the take", async () => {
    const holder: { fixture?: VoiceFixture } = {};
    const languages: Array<string | undefined> = [];
    const f = await setUp({ transcribe: hearing(holder, languages) }, [
      "Hello there my friend.",
      "A second line.",
    ]);
    holder.fixture = f;
    const result = await f.service.synthesize(f.project, { requestId: "request-0001" });
    expect(languages).toEqual(["en", "en"]);
    expect(result.notes).toEqual([]);
    const lines = readScript(f.project.dir).lines;
    expect(lines[0]?.takes[0]?.words).toEqual(wordsOf("Hello there my friend."));
    expect(lines[1]?.takes[0]?.words).toEqual(wordsOf("A second line."));
    expect(lines[0]?.takes[0]?.start).toBe(0);
  });

  it("adds the words to an identical take that was recorded without them", async () => {
    let available = false;
    const holder: { fixture?: VoiceFixture } = {};
    const listen = hearing(holder, []);
    const f = await setUp(
      {
        transcribe: async (options) =>
          available ? listen(options) : { unavailable: "recognizer not ready" },
      },
      ["Hello there."],
    );
    holder.fixture = f;
    // A provider that reads the same request into the same bytes: the regenerate below is the same sound.
    f.engine.deterministic = true;
    const first = await f.service.synthesize(f.project, { requestId: "request-0001" });
    expect(first.lines[0]?.take.words).toBeUndefined();
    available = true;
    const again = await f.service.synthesize(f.project, { requestId: "request-0002", force: true });
    expect(again.lines[0]).toMatchObject({ duplicate: true });
    const line = readScript(f.project.dir).lines[0];
    expect(line?.takes).toHaveLength(1);
    expect(line?.takes[0]?.id).toBe(first.lines[0]?.take.id);
    expect(line?.takes[0]?.words).toEqual(wordsOf("Hello there."));
  });

  it("a recognizer that is unavailable or throws never fails the generation: one note, no words", async () => {
    const failing: TranscribeMedia[] = [
      async () => ({ unavailable: "no whisper" }),
      async () => {
        throw new Error("whisper crashed");
      },
    ];
    for (const failure of failing) {
      let asked = 0;
      const f = await setUp(
        {
          transcribe: async (options) => {
            asked += 1;
            return failure(options);
          },
        },
        ["Hello there.", "Second line."],
      );
      const result = await f.service.synthesize(f.project, { requestId: "request-0001" });
      expect(result.lines).toHaveLength(2);
      expect(result.notes).toHaveLength(1);
      expect(result.notes[0]).toMatch(/Word timings were not recorded/);
      // The first failure is enough: the second line does not ask again.
      expect(asked).toBe(1);
      const lines = readScript(f.project.dir).lines;
      expect(lines.every((line) => line.takes[0]?.words === undefined)).toBe(true);
      expect(existsSync(join(f.project.dir, lines[0]?.takes[0]?.file ?? "missing"))).toBe(true);
    }
  });
});

describe("per-minute rate limits", () => {
  it("waits out a short limit, shows the wait in the progress, and generates", async () => {
    const waits: number[] = [];
    const holder: { fixture?: VoiceFixture } = {};
    let seen: number | undefined;
    const f = await setUp(
      {
        sleep: async (ms) => {
          waits.push(ms);
          const { fixture: current } = holder;
          seen = current?.service.progress(current.project, "request-0001").waitingUntil;
        },
      },
      ["Hello there."],
    );
    holder.fixture = f;
    f.engine.queuedFailures.push(limited(11));
    const before = Date.now();
    const result = await f.service.synthesize(f.project, { requestId: "request-0001" });
    expect(result.lines).toHaveLength(1);
    expect(f.engine.calls).toHaveLength(1);
    expect(waits).toEqual([12_000]);
    expect(seen).toBeGreaterThanOrEqual(before + 12_000);
    // The wait is over: the progress no longer carries it.
    expect(f.service.progress(f.project, "request-0001").waitingUntil).toBeUndefined();
  });

  it("asks at most four more times, then reports the limit; what was generated is kept", async () => {
    const waits: number[] = [];
    const f = await setUp(
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
      ["Hello there.", "Second line."],
    );
    await f.service.synthesize(f.project, { requestId: "request-0001", lineIds: ["l1"] });
    for (let attempt = 0; attempt < 5; attempt += 1) f.engine.queuedFailures.push(limited(3));
    const failure = await failureOf(
      f.service.synthesize(f.project, { requestId: "request-0002", lineIds: ["l2"] }),
    );
    expect(failure.code).toBe("rate_limited");
    expect(waits).toHaveLength(4);
    expect(readScript(f.project.dir).lines[0]?.takes).toHaveLength(1);
  });

  it("does not wait out a daily limit, a long wait or a limit without a time", async () => {
    const waits: number[] = [];
    const f = await setUp(
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
      ["Hello there."],
    );
    f.engine.queuedFailures.push(limited(5, true));
    expect((await failureOf(f.service.synthesize(f.project, { requestId: "r1" }))).code).toBe(
      "rate_limited",
    );
    f.engine.queuedFailures.push(limited(300));
    expect((await failureOf(f.service.synthesize(f.project, { requestId: "r2" }))).code).toBe(
      "rate_limited",
    );
    f.engine.queuedFailures.push(new VoiceFailure("rate_limited", "Slow down"));
    expect((await failureOf(f.service.synthesize(f.project, { requestId: "r3" }))).code).toBe(
      "rate_limited",
    );
    expect(waits).toEqual([]);
  });

  it("a cancel during the wait stops it and leaves nothing behind", async () => {
    let started: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await setUp(
      {
        sleep: (_ms, signal) =>
          new Promise<void>((_resolve, reject) => {
            started();
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
      ["Hello there."],
    );
    f.engine.queuedFailures.push(limited(30));
    const outcome = failureOf(f.service.synthesize(f.project, { requestId: "request-cancel" }));
    await waiting;
    expect(f.service.cancel(f.project, "request-cancel")).toBe("cancelled");
    expect((await outcome).code).toBe("cancelled");
    expect(f.service.progress(f.project, "request-cancel")).toMatchObject({ state: "cancelled" });
    expect(f.service.progress(f.project, "request-cancel").waitingUntil).toBeUndefined();
    const folder = join(f.project.dir, "assets/voice");
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
    expect(f.engine.calls).toHaveLength(0);
  });
});
