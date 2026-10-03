import type { EditorContext } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { renderPromptContext, renderUserLanguageBlock } from "./promptContext.js";

function context(selection: Partial<EditorContext["selection"]> = {}): EditorContext {
  return {
    schemaVersion: 1,
    capturedAt: 1,
    project: { id: "p" },
    activeComposition: { path: "index.html" },
    timeline: { duration: 10, elementCount: 0, elements: [] },
    playhead: { time: 0, playing: false },
    selection: { clips: [], assetPath: null, previewElement: null, range: null, ...selection },
    renderSettings: null,
    storyGraph: null,
  };
}

describe("user selection block", () => {
  it("names a picked canvas element in words before the editor JSON", () => {
    const rendered = renderPromptContext(
      "Make this red",
      context({
        previewElement: {
          hfId: "hf-12",
          domId: "title",
          selector: "#title",
          label: "Title",
          tagName: "h1",
          sourceFile: "compositions/intro.html",
        },
      }),
    );
    const selection = rendered.indexOf("<user-selection>");
    expect(selection).toBeGreaterThan(0);
    expect(selection).toBeLessThan(rendered.indexOf("<editor-context>"));
    expect(rendered).toContain(
      '- canvas element "Title" (h1, hfId hf-12, id title, selector #title) in compositions/intro.html',
    );
  });

  it("lists clips, range and asset, and adds no block when nothing is selected", () => {
    const rendered = renderPromptContext(
      "Cut here",
      context({
        clips: [
          { id: "c1", hfId: "hf-1", label: "Intro", tag: "video", start: 1, duration: 3, track: 0 },
        ],
        range: { start: 1, end: 2.5 },
        assetPath: "assets/logo.svg",
      }),
    );
    expect(rendered).toContain('- timeline clips: hf-1 "Intro" (video, 1–4 s, track 0)');
    expect(rendered).toContain("- time range 1–2.5 s");
    expect(rendered).toContain("- media asset assets/logo.svg");
    expect(renderPromptContext("Hi", context())).not.toContain("<user-selection>");
  });
});

describe("user language block", () => {
  it("names the language in English and asks for replies in it", () => {
    const block = renderUserLanguageBlock("ru");
    expect(block).toContain("<user-language>ru</user-language>");
    expect(block).toContain("Reply to the user in Russian");
    expect(renderUserLanguageBlock("pt-BR")).toContain("Brazilian Portuguese");
  });

  it("adds nothing for English, an absent tag or an unknown one", () => {
    expect(renderUserLanguageBlock("en")).toBeNull();
    expect(renderUserLanguageBlock("en-GB")).toBeNull();
    expect(renderUserLanguageBlock(undefined)).toBeNull();
    expect(renderUserLanguageBlock("zz-ZZZZ")).toBeNull();
  });

  it("keeps the English prompt byte-identical and appends the block last otherwise", () => {
    const plain = renderPromptContext("Trim the intro", undefined, [], "en");
    expect(plain).toBe("Trim the intro");
    const russian = renderPromptContext("Trim the intro", undefined, [], "ru");
    expect(russian.startsWith("Trim the intro\n\n<user-language>ru</user-language>")).toBe(true);
  });
});
