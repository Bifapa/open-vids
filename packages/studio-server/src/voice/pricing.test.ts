// @vitest-environment node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VoicePricing } from "./pricing.js";
import { tempDir } from "./testSupport.js";

const at = (day: string): number => Date.parse(`${day}T12:00:00Z`);
const dirs: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of dirs.splice(0)) cleanup();
});

function pricing(now = at("2026-10-07")): { pricing: VoicePricing; dir: string } {
  const temp = tempDir("openvids-voice-pricing-");
  dirs.push(temp.cleanup);
  return { pricing: new VoicePricing(temp.dir, () => now), dir: temp.dir };
}

describe("voice pricing", () => {
  it("doubles the Gemini 3.8 rates on 2027-01-01 (until is exclusive)", () => {
    const { pricing: table } = pricing();
    const before = table.estimateUsd("gemini", "gemini-3.8-flash-tts", 0, 60, at("2026-12-31"));
    const after = table.estimateUsd("gemini", "gemini-3.8-flash-tts", 0, 60, at("2027-01-01"));
    expect(before).toBeCloseTo(0.0135, 8);
    expect(after).toBeCloseTo(0.027, 8);
    const lite = (day: string) =>
      table.estimateUsd("gemini", "gemini-3.8-flash-lite-tts", 0, 60, at(day));
    expect(lite("2026-12-31")).toBeCloseTo(0.009, 8);
    expect(lite("2027-01-01")).toBeCloseTo(0.018, 8);
  });

  it("adds the input-token term (chars/4) to the audio minutes", () => {
    const { pricing: table } = pricing();
    // 400 chars = 100 tokens at $0.50 / 1M, plus 30 s at $0.0135/min.
    expect(table.estimateUsd("gemini", "gemini-3.8-flash-tts", 400, 30)).toBeCloseTo(
      0.00005 + 0.00675,
      8,
    );
    expect(
      table.estimateUsd("gemini", "gemini-3.8-flash-tts", 400, 30, at("2027-02-01")),
    ).toBeCloseTo(0.0001 + 0.0135, 8);
  });

  it("prices per character for OpenAI tts-1 and ElevenLabs", () => {
    const { pricing: table } = pricing();
    expect(table.estimateUsd("openai", "tts-1", 1_000_000, 0)).toBeCloseTo(15, 6);
    expect(table.estimateUsd("openai", "tts-1-hd", 1_000_000, 0)).toBeCloseTo(30, 6);
    expect(table.estimateUsd("elevenlabs", "eleven_v4", 1_000, 0)).toBeCloseTo(0.08, 8);
    expect(table.estimateUsd("elevenlabs", "eleven_flash_v2_5", 1_000, 0)).toBeCloseTo(0.04, 8);
  });

  it("has no estimate where only the input side is published, or the model is unknown", () => {
    const { pricing: table } = pricing();
    expect(table.estimateUsd("openai", "gpt-4o-mini-tts", 1_000, 30)).toBeNull();
    expect(table.estimateUsd("openai", "gpt-4o-mini-tts-2025-12-15", 1_000, 30)).toBeNull();
    expect(table.estimateUsd("elevenlabs", "eleven_unknown", 1_000, 30)).toBeNull();
    expect(table.estimateUsd("custom", "kokoro", 1_000, 30)).toBeNull();
    expect(table.estimateUsd("openrouter", "google/gemini-3.8-flash-tts", 1_000, 30)).toBeNull();
  });

  it("gives a list price per minute for a model listing", () => {
    const { pricing: table } = pricing();
    // 60 s of audio at $0.0135/min plus the ~900 characters (225 tokens at $0.50 / 1M) a minute of speech takes.
    expect(table.usdPerMinute("gemini", "gemini-3.8-flash-tts")).toBeCloseTo(0.0136125, 8);
    expect(table.usdPerMinute("openai", "gpt-4o-mini-tts")).toBeNull();
    expect(table.usdPerMinute("elevenlabs", "eleven_v4")).toBeCloseTo(0.072, 6);
  });

  it("lets the user's pricing.json override the shipped table, exact ids over prefixes", () => {
    const { pricing: table, dir } = pricing();
    writeFileSync(
      join(dir, "pricing.json"),
      JSON.stringify({
        schema: "openvids.voice-pricing/1",
        checkedAt: "2026-10-07",
        rates: [
          {
            providerId: "openai",
            model: "gpt-4o-mini-tts*",
            usdPerMinute: 0.015,
            source: "https://example.test",
          },
          {
            providerId: "openai",
            model: "gpt-4o-mini-tts",
            usdPerMinute: 0.02,
            source: "https://example.test",
          },
          {
            providerId: "elevenlabs",
            model: "eleven_v4",
            usdPer1kChars: 0.01,
            source: "https://example.test",
          },
          {
            providerId: "elevenlabs",
            model: "broken",
            usdPer1kChars: -1,
            source: "https://example.test",
          },
        ],
      }),
    );
    expect(table.estimateUsd("openai", "gpt-4o-mini-tts", 0, 60)).toBeCloseTo(0.02, 8);
    expect(table.estimateUsd("openai", "gpt-4o-mini-tts-2025-12-15", 0, 60)).toBeCloseTo(0.015, 8);
    expect(table.estimateUsd("elevenlabs", "eleven_v4", 1_000, 0)).toBeCloseTo(0.01, 8);
    expect(table.estimateUsd("elevenlabs", "eleven_v3", 1_000, 0)).toBeCloseTo(0.08, 8);
  });

  it("uses a provider's published price list (OpenRouter) and a malformed override is ignored", () => {
    const { pricing: table, dir } = pricing();
    writeFileSync(join(dir, "pricing.json"), "{ nope");
    table.setListed(
      "openrouter",
      "hexgrad/kokoro-82m",
      { usdPer1MChars: 0.62 },
      "https://openrouter.ai",
    );
    expect(table.estimateUsd("openrouter", "hexgrad/kokoro-82m", 1_000_000, 0)).toBeCloseTo(
      0.62,
      8,
    );
    expect(table.estimateUsd("gemini", "gemini-3.8-flash-tts", 0, 60)).toBeCloseTo(0.0135, 8);
  });
});
