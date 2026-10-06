import { describe, expect, it } from "vitest";
import {
  VOICE_DIALECTS,
  checkVoiceScript,
  dialectForModel,
  spokenText,
  voiceTextSegments,
  type VoiceScriptIssue,
} from "./voiceDialects.js";

const gemini = VOICE_DIALECTS["gemini-tts"];
const eleven = VOICE_DIALECTS["elevenlabs-v3"];
const openai = VOICE_DIALECTS["openai-gpt-4o-mini-tts"];

const codes = (issues: VoiceScriptIssue[]) => issues.map((i) => `${i.severity}:${i.code}`);

describe("dialectForModel", () => {
  it("maps one family to one dialect whatever service sells it", () => {
    expect(dialectForModel("gemini-3.8-flash-tts", "gemini")).toEqual({
      dialect: "gemini-tts",
      approximate: false,
    });
    expect(dialectForModel("google/gemini-3.8-flash-lite-tts", null)).toEqual({
      dialect: "gemini-tts",
      approximate: false,
    });
    expect(dialectForModel("eleven_v4", "elevenlabs").dialect).toBe("elevenlabs-v3");
    expect(dialectForModel("eleven_multilingual_v2", "elevenlabs").dialect).toBe("elevenlabs-v2");
    expect(dialectForModel("tts-1-hd", "openai").dialect).toBe("openai-tts-1");
  });

  it("falls back to the nearest family of a known vendor, flagged approximate", () => {
    expect(dialectForModel("gemini-3.1-flash-tts-preview", "gemini")).toEqual({
      dialect: "gemini-tts",
      approximate: true,
    });
    expect(dialectForModel("some-new-voice-model", "elevenlabs")).toEqual({
      dialect: "elevenlabs-v3",
      approximate: true,
    });
    expect(dialectForModel("kokoro", null)).toEqual({ dialect: "plain", approximate: false });
  });
});

describe("checkVoiceScript", () => {
  it("accepts documented tags in the dialect's own syntax", () => {
    expect(
      checkVoiceScript(gemini, [
        { id: "a", speakerText: "Well <sigh> here we go. <short pause> Ready?" },
      ]),
    ).toEqual([]);
  });

  it("refuses another model's tag syntax and unknown tags of a closed list", () => {
    const issues = checkVoiceScript(gemini, [
      { id: "a", speakerText: "[laughs] Hi <applause> there" },
    ]);
    expect(codes(issues)).toEqual(["error:foreign_tag_syntax", "error:unknown_tag"]);
    expect(issues[0]?.lineId).toBe("a");
  });

  it("only warns about unlisted tags when the vendor documents tags as open", () => {
    expect(
      codes(checkVoiceScript(eleven, [{ id: "a", speakerText: "[quietly amused] Fine." }])),
    ).toEqual(["warning:unknown_tag"]);
  });

  it("refuses inline tags and SSML for models that read them aloud", () => {
    expect(
      codes(checkVoiceScript(openai, [{ id: "a", speakerText: "Hello <sigh> there" }])),
    ).toEqual(["error:tags_unsupported"]);
    expect(
      codes(checkVoiceScript(eleven, [{ id: "a", speakerText: 'Wait <break time="1s"/> now' }])),
    ).toEqual(["error:ssml_unsupported"]);
  });

  it("refuses a style for a model without one, and over-long text", () => {
    expect(
      codes(checkVoiceScript(eleven, [{ id: "a", speakerText: "Hi.", style: "calm" }])),
    ).toEqual(["error:style_unsupported"]);
    const long = "word ".repeat(1_200);
    const issues = checkVoiceScript(gemini, [{ id: "a", speakerText: long }]);
    expect(codes(issues)).toEqual(["error:too_long"]);
    expect(issues[0]?.params).toEqual({ length: long.length, max: gemini.maxChars });
  });

  it("flags a line that is only tags as empty", () => {
    expect(
      codes(checkVoiceScript(gemini, [{ id: "a", speakerText: "<sigh> <long pause>" }])),
    ).toEqual(["error:empty_text"]);
  });
});

describe("captions and chips", () => {
  it("strips exactly the dialect's tags for captions", () => {
    expect(spokenText(gemini, "Well <sigh> here we go, <short pause> friends.")).toBe(
      "Well here we go, friends.",
    );
    expect(spokenText(eleven, "[whispers] It WORKED… [laughs]")).toBe("It WORKED…");
    // A model without tags keeps every character: brackets are spoken there.
    expect(spokenText(openai, "Item [1] costs <5")).toBe("Item [1] costs <5");
  });

  it("splits speaker text into text and known/unknown tag chips", () => {
    expect(voiceTextSegments(gemini, "Hi <sigh> you <boom>")).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "tag", tag: "sigh", known: true },
      { kind: "text", text: " you " },
      { kind: "tag", tag: "boom", known: false },
    ]);
  });
});
