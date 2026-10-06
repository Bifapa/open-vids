import { describe, expect, it } from "vitest";
import {
  activeMention,
  applyMention,
  applyMentionToken,
  containsMention,
  matchMentionAssets,
  withoutMention,
} from "./composerMentions";

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

describe("containsMention", () => {
  const token = "@clip.mp4";

  it("finds a mention that stands alone, closed by space, punctuation or the end", () => {
    for (const text of [
      "@clip.mp4",
      "Use @clip.mp4 now",
      "(@clip.mp4)",
      "Use @clip.mp4, then cut",
      "Is it @clip.mp4?",
    ])
      expect(containsMention(text, token), text).toBe(true);
  });

  it("keeps a mention that ends a sentence or sits in quotes", () => {
    for (const text of [
      "Use @clip.mp4.",
      "Use @clip.mp4. Then cut.",
      "Use @clip.mp4...",
      "«@clip.mp4»",
      '"@clip.mp4"',
      "'@clip.mp4'",
      "“@clip.mp4”",
      "[@clip.mp4]",
    ])
      expect(containsMention(text, token), text).toBe(true);
  });

  it("does not take other words for the mention", () => {
    for (const text of ["@clip.mp4x", "@clip.mp4.bak", "mail@clip.mp4", "Use @clip.mp4.x cut"])
      expect(containsMention(text, token), text).toBe(false);
  });
});

describe("withoutMention", () => {
  it("removes a mention that ends a sentence and keeps the full stop", () => {
    expect(withoutMention("Use @clip.mp4.", "@clip.mp4")).toBe("Use .");
    expect(withoutMention('Use "@clip.mp4" now', "@clip.mp4")).toBe('Use "" now');
  });
});

describe("activeMention with the # trigger", () => {
  it("follows the same boundary rules as @", () => {
    expect(activeMention("#", 1, "#")).toEqual({ start: 0, query: "" });
    expect(activeMention("use #promo", 10, "#")).toEqual({ start: 4, query: "promo" });
    expect(activeMention("one\n#x", 6, "#")).toEqual({ start: 4, query: "x" });
    expect(activeMention("see (#my-pro", 12, "#")).toEqual({ start: 5, query: "my-pro" });
    expect(activeMention("use #pro and #other", 8, "#")).toEqual({ start: 4, query: "pro" });
  });

  it("is not a token in the middle of a word, a link or a second #", () => {
    for (const text of ["issue#12", "https://example.com/#top", "a#b", "##tag", "c#"]) {
      expect(activeMention(text, text.length, "#"), text).toBeNull();
    }
  });

  it("ends at a space, so a markdown heading is not a token once the title starts", () => {
    expect(activeMention("# Title", 7, "#")).toBeNull();
    expect(activeMention("# ", 2, "#")).toBeNull();
    expect(activeMention("#promo ", 7, "#")).toBeNull();
  });

  it("leaves colours and numbers to the caller: they are tokens, the popup decides", () => {
    for (const text of ["#ff0000", "#fff", "#1", "#12"]) {
      expect(activeMention(text, text.length, "#")).toEqual({ start: 0, query: text.slice(1) });
    }
  });

  it("keeps the two triggers apart", () => {
    expect(activeMention("#promo", 6)).toBeNull();
    expect(activeMention("@clip", 5, "#")).toBeNull();
    expect(activeMention("look at @clip and #promo", 24, "#")).toEqual({
      start: 18,
      query: "promo",
    });
  });
});

describe("applyMentionToken", () => {
  it("replaces the typed token with the project token and a space, caret after it", () => {
    expect(applyMentionToken("see #pro", { start: 4, query: "pro" }, 8, "#my-promo")).toEqual({
      text: "see #my-promo ",
      caret: 14,
    });
    expect(applyMentionToken("a #p and b", { start: 2, query: "p" }, 4, "#promo")).toEqual({
      text: "a #promo  and b",
      caret: 9,
    });
  });
});

describe("project tokens in the prompt", () => {
  it("finds a #token that stands alone and not a longer slug that starts like it", () => {
    expect(containsMention("Use #my-promo now", "#my-promo")).toBe(true);
    expect(containsMention("(#my-promo), then", "#my-promo")).toBe(true);
    expect(containsMention("#мой-проект!", "#мой-проект")).toBe(true);
    expect(containsMention("Use #my-promo-2", "#my-promo")).toBe(false);
    expect(containsMention("Use #my-promos", "#my-promo")).toBe(false);
    expect(containsMention("issue#my-promo", "#my-promo")).toBe(false);
  });

  it("takes the token and the space after it out when the chip is removed", () => {
    expect(withoutMention("Use #my-promo music", "#my-promo")).toBe("Use music");
    expect(withoutMention("#a #a-2 #a", "#a")).toBe("#a-2 ");
  });
});
