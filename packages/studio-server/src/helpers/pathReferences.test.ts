import { describe, expect, it } from "vitest";
import { rewriteJsonPathStrings, rewritePathReferences } from "./pathReferences";

describe("rewritePathReferences", () => {
  it.each([
    ["a plain attribute", 'src="hero.png"', 'src="cover.png"'],
    ["a css url", "background: url(hero.png);", "background: url(cover.png);"],
    ["a quote written as &quot;", "url(&quot;hero.png&quot;)", "url(&quot;cover.png&quot;)"],
    ["a quote written as &#39;", "url(&#39;hero.png&#39;)", "url(&#39;cover.png&#39;)"],
    ["a quote written as &apos;", "url(&apos;hero.png&apos;)", "url(&apos;cover.png&apos;)"],
    ["a quote written as &#x27;", "url(&#x27;hero.png&#x27;)", "url(&#x27;cover.png&#x27;)"],
    [
      "an inline style value",
      'style="background:url(&quot;../hero.png&quot;)"',
      'style="background:url(&quot;../cover.png&quot;)"',
    ],
    [
      "a backslash-escaped quote",
      String.raw`"url(\"hero.png\")"`,
      String.raw`"url(\"cover.png\")"`,
    ],
    [
      "a backslash-escaped quote in embedded markup",
      String.raw`{"html":"<img src=\"hero.png\">"}`,
      String.raw`{"html":"<img src=\"cover.png\">"}`,
    ],
    [
      "a twice-escaped quote",
      String.raw`"<img src=\\"hero.png\\">"`,
      String.raw`"<img src=\\"cover.png\\">"`,
    ],
  ])("renames %s", (_, before, after) => {
    expect(rewritePathReferences(before, "hero.png", "cover.png", false)).toBe(after);
  });

  it.each([
    ["a longer name", 'src="my-hero.png"'],
    ["a longer extension", 'src="hero.png.bak"'],
    ["a bare ampersand", "src=hero.png&x=1"],
    ["an entity that is not a quote", "hero.png&amp;more"],
    ["a bare backslash", String.raw`C:\hero.png\more`],
  ])("leaves %s alone", (_, content) => {
    expect(rewritePathReferences(content, "hero.png", "cover.png", false)).toBe(content);
  });

  it("renames a folder's references in every quoting, but not tags or prose that share its name", () => {
    const content = [
      "<img>",
      '<img src="img/a.png">',
      "url(&quot;img/a.png&quot;)",
      String.raw`"<img src=\"img/a.png\">"`,
      "<p>the img folder</p>",
      'class="img"',
    ].join("\n");
    expect(rewritePathReferences(content, "img", "images", true)).toBe(
      [
        "<img>",
        '<img src="images/a.png">',
        "url(&quot;images/a.png&quot;)",
        String.raw`"<img src=\"images/a.png\">"`,
        "<p>the img folder</p>",
        'class="img"',
      ].join("\n"),
    );
  });

  it("renames the URL-encoded spelling in an entity-quoted value", () => {
    expect(
      rewritePathReferences("url(&quot;my%20clip.mp4&quot;)", "my clip.mp4", "b roll.mp4", false),
    ).toBe("url(&quot;b%20roll.mp4&quot;)");
  });
});

describe("rewriteJsonPathStrings", () => {
  it("renames only a whole string", () => {
    expect(
      rewriteJsonPathStrings('{"a":"hero.png","b":"see hero.png"}', "hero.png", "cover.png", false),
    ).toBe('{"a":"cover.png","b":"see hero.png"}');
  });
});
