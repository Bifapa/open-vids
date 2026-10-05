import { describe, expect, it } from "vitest";
import { storyModeRules, type StoryResearch } from "./prompt.js";

/** Research is on and a research host exists: the Director delegates the fetching. */
const READY: StoryResearch = { researchReady: true, researchEnabled: true, scope: null };
/** Research is off in the chat but a research host exists: the Director fetches with the tools it inherits. */
const SELF: StoryResearch = { researchReady: true, researchEnabled: false, scope: null };
/** The runtime has no research host: nobody can look outside the project. */
const NOT_READY: StoryResearch = { researchReady: false, researchEnabled: true, scope: null };

const build = (editorEnabled: boolean, research: StoryResearch) =>
  storyModeRules("build", editorEnabled, null, research);

describe("the build turn's rules", () => {
  it("asks for the complete video: prepare material, fetch it with Research, build once, then graphics and the sound mix", () => {
    const rules = build(true, READY);
    expect(rules).toContain('<story-mode action="build">');
    expect(rules).toContain("finished, watchable video with sound");
    // Preparing the graph: music bed, sound effects and footage nodes, attached to the chapters.
    expect(rules).toContain("edit_story");
    expect(rules).toContain("music bed unless the user said no music");
    expect(rules).toContain("sound effects");
    expect(rules).toContain("offset");
    // Research fetches and resolves the nodes; the import call asks the user and waits.
    expect(rules).toContain("Delegate Research");
    expect(rules).toContain("resolveMissing");
    expect(rules).toContain("WAITS");
    expect(rules).toContain("never end the turn to ask");
    // One build, then a frozen graph.
    expect(rules).toContain("exactly once");
    expect(rules).toContain("frozen");
    expect(rules).toContain("edit_timeline");
    // Motion and Audio finish the video.
    expect(rules).toContain("Delegate Motion");
    expect(rules).toContain("Delegate Audio");
    expect(rules).toContain("fade");
    expect(rules).toContain("Never render unless the user asked for a file");
  });

  it("makes the Director fetch the material itself when Research is off", () => {
    const rules = build(true, SELF);
    expect(rules).toContain("Fetch what is missing yourself");
    expect(rules).toContain("Research is off in this chat, so its work is yours");
    expect(rules).toContain("search_assets");
    expect(rules).toContain("import_asset with resolveMissing set to the node id");
    expect(rules).toContain("WAITS");
    expect(rules).not.toContain("Delegate Research");
    expect(rules).not.toContain("Outside material cannot be fetched");
    expect(rules).toContain("Delegate Audio");
  });

  it("says outside material cannot be fetched only when there is no research service, and still builds with what exists", () => {
    const rules = build(true, NOT_READY);
    expect(rules).toContain("Outside material cannot be fetched in this turn");
    expect(rules).toContain("research service is not available");
    expect(rules).toContain("Do not search");
    expect(rules).not.toContain("Delegate Research");
    expect(rules).not.toContain("search_assets");
    expect(rules).not.toContain("WAITS");
    expect(rules).toContain("what the user has to add");
    // The rest of the production still runs.
    expect(rules).toContain("exactly once");
    expect(rules).toContain("Delegate Audio");
  });

  it("makes the Director do the Editor's part when no Editor is enabled, and any other off specialist's too", () => {
    expect(build(true, READY)).toContain("Delegate the Editor: build_story");
    const alone = build(false, READY);
    expect(alone).toContain("Compile the story yourself: build_story");
    expect(alone).not.toContain("Delegate the Editor");
    expect(alone).toContain("you do its part yourself");
  });

  it("tells a rebuild turn that Research cannot search or import, and what to do when the rebuild is unsupported", () => {
    const rules = storyModeRules("rebuild", true, null, READY);
    expect(rules).toContain("Research cannot search or import in a rebuild turn");
    expect(rules).not.toContain("Delegate Research");
    expect(rules).toContain("refused as unsupported");
    expect(rules).toContain("a full Build Story is the way forward");
  });
});

describe("the resolve turn's rules", () => {
  const resolve = (research: StoryResearch) => storyModeRules("resolve", true, null, research);

  it("delegates to Research when it is on", () => {
    const rules = resolve(READY);
    expect(rules).toContain("Delegate Research");
    expect(rules).toContain("You do not search or import yourself");
    expect(rules).toContain("Missing Asset nodes to resolve");
  });

  it("has the Director search, import and resolve itself when Research is off", () => {
    const rules = resolve(SELF);
    expect(rules).toContain("Research is off in this chat, so you do its work yourself");
    expect(rules).toContain("search_assets");
    expect(rules).toContain("import_asset with resolveMissing set to the node id");
    expect(rules).toContain("resolve_missing_asset");
    expect(rules).not.toContain("Delegate Research");
    expect(rules).toContain("Do not edit the graph (no edit_story)");
    expect(rules).toContain("Missing Asset nodes to resolve");
  });

  it("does nothing, and says why, only when there is no research service", () => {
    const rules = resolve(NOT_READY);
    expect(rules).toContain("Studio's research service is not available");
    expect(rules).toContain("Do nothing");
    expect(rules).not.toContain("search_assets");
    expect(rules).not.toContain("Missing Asset nodes to resolve");
  });
});
