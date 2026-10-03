import { describe, expect, it } from "vitest";
import { activeMention, applyMention, matchMentionAssets } from "./composerMentions";

describe("activeMention", () => {
  it("finds a token at the start of the text, with and without a query", () => {
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMention("@intro", 6)).toEqual({ start: 0, query: "intro" });
  });

  it("finds a token after whitespace or an opening parenthesis", () => {
    expect(activeMention("look at @int", 12)).toEqual({ start: 8, query: "int" });
    expect(activeMention("one\n@x", 6)).toEqual({ start: 4, query: "x" });
    expect(activeMention("see (@lo", 8)).toEqual({ start: 5, query: "lo" });
  });

  it("is not fooled by an email address", () => {
    expect(activeMention("mail@example", 12)).toBeNull();
    expect(activeMention("write to me@example.com", 23)).toBeNull();
  });

  it("ends at a space between the @ and the caret", () => {
    expect(activeMention("@intro ", 7)).toBeNull();
    expect(activeMention("@ intro", 7)).toBeNull();
  });

  it("uses only the text up to the caret", () => {
    expect(activeMention("@intro.mp4 more", 4)).toEqual({ start: 0, query: "int" });
    expect(activeMention("see @a and @b", 6)).toEqual({ start: 4, query: "a" });
  });

  it("is null without an @ in the word and for a caret outside the text", () => {
    expect(activeMention("hello", 5)).toBeNull();
    expect(activeMention("@a", 5)).toBeNull();
    expect(activeMention("", 0)).toBeNull();
  });
});

describe("matchMentionAssets", () => {
  const assets = [
    "assets/zeta.mp4",
    "assets/Intro.mp4",
    "music/intro-theme.mp3",
    "assets/my-intro.png",
    "intro/cover.jpg",
    "assets/alpha.wav",
  ];

  it("lists the first assets by basename for an empty query", () => {
    expect(matchMentionAssets(assets, "")).toEqual([
      "assets/alpha.wav",
      "intro/cover.jpg",
      "music/intro-theme.mp3",
      "assets/Intro.mp4",
      "assets/my-intro.png",
      "assets/zeta.mp4",
    ]);
    expect(matchMentionAssets(assets, "", 2)).toEqual(["assets/alpha.wav", "intro/cover.jpg"]);
  });

  it("ranks basename prefix, then basename contains, then path contains, ignoring case", () => {
    expect(matchMentionAssets(assets, "INTRO")).toEqual([
      "music/intro-theme.mp3",
      "assets/Intro.mp4",
      "assets/my-intro.png",
      "intro/cover.jpg",
    ]);
  });

  it("drops what does not match and honours the limit", () => {
    expect(matchMentionAssets(assets, "nothing")).toEqual([]);
    expect(matchMentionAssets(assets, "intro", 2)).toEqual([
      "music/intro-theme.mp3",
      "assets/Intro.mp4",
    ]);
  });
});

describe("applyMention", () => {
  it("replaces the token with the basename and a space, caret after it", () => {
    const text = "look at @int";
    expect(applyMention(text, { start: 8, query: "int" }, 12, "assets/intro.mp4")).toEqual({
      text: "look at @intro.mp4 ",
      caret: 19,
    });
  });

  it("keeps the text after the caret and basenames with spaces", () => {
    const text = "see @in and cut";
    expect(applyMention(text, { start: 4, query: "in" }, 7, "assets/my intro.mp4")).toEqual({
      text: "see @my intro.mp4  and cut",
      caret: 18,
    });
  });
});
