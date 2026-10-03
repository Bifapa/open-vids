import { describe, expect, it } from "vitest";
import type { HyperframePickerElementInfo } from "@hyperframes/core";
import { buildPickerAgentContextPreview, buildPickerAgentPrompt } from "./domEditingAgentPrompt";

const PICKER_SELECTION: HyperframePickerElementInfo = {
  id: "headline-1",
  tagName: "div",
  selector: "#headline-1",
  label: "Headline",
  boundingBox: { x: 10, y: 20, width: 300, height: 40 },
  textContent: "Hello world",
  src: null,
  dataAttributes: {},
};

describe("buildPickerAgentPrompt", () => {
  it("produces the documented v1 schema", () => {
    const prompt = buildPickerAgentPrompt({
      selection: PICKER_SELECTION,
      userInstruction: "Make this bigger",
    });
    expect(prompt).toBe(
      [
        "## HyperFrames element edit request v1",
        "Schema version: 1",
        "",
        "Make this bigger",
        "",
        "DOM id: headline-1",
        "Selector: #headline-1",
        "Selector index: 0",
        "Tag: <div>",
        "Label: Headline",
        "Bounds: x=10, y=20, width=300, height=40",
        "Text: Hello world",
        "",
        "Guardrails:",
        "- Make a targeted change to this element only, unless the request is a timeline edit.",
        "- Preserve the rest of the composition and its timing, except what a timeline edit changes.",
        "- Do not modify other elements' data-* attributes or positioning, except where the requested timeline edit requires it (split, retime, reorder, copy a group, swap media).",
        "- For timeline edits (trim, split, speed, volume, copy, swap), follow the creator-editing-recipes reference of the hyperframes-core skill and use its exact attribute forms.",
        "- Prefer existing inline styles or existing CSS rules for this element over adding unrelated selectors.",
      ].join("\n"),
    );
  });

  it("produces a plain comment prompt when nothing is selected", () => {
    const prompt = buildPickerAgentPrompt({ selection: null, userInstruction: "Add a border" });
    expect(prompt).toBe(
      ["## HyperFrames element edit request v1", "Schema version: 1", "", "Add a border"].join(
        "\n",
      ),
    );
  });

  it("surfaces the picker's label and media src — a host app has no DOM to read them from otherwise", () => {
    const prompt = buildPickerAgentPrompt({
      selection: { ...PICKER_SELECTION, tagName: "img", src: "assets/hero.png" },
    });
    expect(prompt).toContain("Label: Headline");
    expect(prompt).toContain("Source (media): assets/hero.png");
  });

  it("omits the label and source lines when the picker didn't report them", () => {
    const prompt = buildPickerAgentPrompt({
      selection: { ...PICKER_SELECTION, label: "", src: null },
    });
    expect(prompt).not.toContain("Label:");
    expect(prompt).not.toContain("Source (media):");
  });
});

describe("buildPickerAgentContextPreview", () => {
  it("returns an empty string when nothing is selected", () => {
    expect(buildPickerAgentContextPreview(null)).toBe("");
  });

  it("prints the selector/tag line and the text line", () => {
    expect(buildPickerAgentContextPreview(PICKER_SELECTION)).toBe(
      ["Selector: #headline-1  Tag: <div>", "Text: Hello world"].join("\n"),
    );
  });
});
