// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STORY_GRAPH_PATH,
  isChapter,
  type StoryGraph,
  type StoryNode,
  type StoryOperation,
  type StorySourceRangeInput,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createStoryFixture, created, TALK, type StoryFixture } from "./testSupport.js";

let fixture: StoryFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function story(options: Parameters<typeof createStoryFixture>[0] = {}): StoryFixture {
  fixture = createStoryFixture(options);
  return fixture;
}

/** Studio saves the graph after `change` edited it by hand. */
async function userEdit(f: StoryFixture, change: (graph: StoryGraph) => void): Promise<StoryGraph> {
  const before = await f.view();
  if (!before.graph) throw new Error("no story");
  const graph = structuredClone(before.graph);
  change(graph);
  const saved = await f.service.save(f.project, { baseVersion: before.version, graph });
  if (!saved.graph) throw new Error("no story");
  return saved.graph;
}

const node = (graph: StoryGraph, id: string): StoryNode => {
  const found = graph.nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
};

/** Two chapters A → B, a video attached to A. */
async function threeNodes(f: StoryFixture) {
  const made = await f.edit([
    {
      op: "add_node",
      ref: "a",
      node: { kind: "chapter", title: "Intro", sourceRanges: [{ source: TALK, segments: ["g1"] }] },
    },
    {
      op: "add_node",
      ref: "b",
      node: { kind: "chapter", title: "Main", sourceRanges: [{ source: TALK, segments: ["g2"] }] },
    },
    { op: "add_node", ref: "v", node: { kind: "video", title: "Cutaway", asset: "assets/b.mp4" } },
    { op: "connect", from: "@a", to: "@b", transition: "cut" },
    { op: "attach", node: "@v", chapter: "@a", placement: "end" },
  ]);
  return { a: created(made, 0), b: created(made, 1), v: created(made, 2) };
}

describe("resolving what an agent names", () => {
  it("turns segments into their analysis ranges, sentences into transcript times and raw times into themselves", async () => {
    const f = story();
    const made = await f.edit([
      {
        op: "add_node",
        node: {
          kind: "chapter",
          title: "All three kinds",
          sourceRanges: [
            { source: TALK, segments: ["g2", "g1"] },
            { source: TALK, firstSentence: "s2", lastSentence: "s3" },
            { source: "./assets/a.mp4", from: 1, to: 2 },
          ],
        },
      },
    ]);
    const chapter = node(await f.graph(), created(made, 0));
    if (!isChapter(chapter)) throw new Error("not a chapter");
    expect(chapter.sourceRanges).toEqual([
      { source: TALK, from: 2.6, to: 4.3, segment: "g2" },
      { source: TALK, from: 0.5, to: 2.4, segment: "g1" },
      { source: TALK, from: 2.6, to: 7.4, segment: null },
      { source: TALK, from: 1, to: 2, segment: null },
    ]);
    expect(chapter.previewFrame).toEqual({ source: TALK, time: 3.45 });
  });

  it("refuses unknown segments and sentences with the operation's index, and files that are not there", async () => {
    const f = story();
    const chapter = (sourceRanges: StorySourceRangeInput[]): StoryOperation => ({
      op: "add_node",
      node: { kind: "chapter", title: "C", sourceRanges },
    });
    expect(await f.refusal([chapter([{ source: TALK, segments: ["g9"] }])])).toMatchObject({
      code: "invalid_request",
      opIndex: 0,
    });
    expect(
      await f.refusal([chapter([{ source: TALK, firstSentence: "s3", lastSentence: "s1" }])]),
    ).toMatchObject({ code: "invalid_request" });
    expect(
      await f.refusal([chapter([{ source: "assets/nope.mp4", from: 0, to: 1 }])]),
    ).toMatchObject({
      code: "unknown_asset",
    });
    expect(await f.refusal([chapter([{ source: TALK, from: 9, to: 12 }])])).toMatchObject({
      code: "invalid_request",
    });
  });

  it("says a source is not analysed when segments or sentences are named for one that was never analysed", async () => {
    const f = story({ analysed: false });
    const refusal = await f.refusal([
      {
        op: "add_node",
        node: { kind: "chapter", title: "C", sourceRanges: [{ source: TALK, segments: ["g1"] }] },
      },
    ]);
    expect(refusal.code).toBe("not_analyzed");
    // Raw times need no analysis.
    const made = await f.edit([
      {
        op: "add_node",
        node: { kind: "chapter", title: "C", sourceRanges: [{ source: TALK, from: 0, to: 3 }] },
      },
    ]);
    expect(created(made, 0)).toMatch(/^chapter-/);
  });

  it("defaults a new chapter's length to the cleaned material and its status to proposed", async () => {
    const f = story();
    const made = await f.edit([
      {
        op: "add_node",
        node: { kind: "chapter", title: "C", sourceRanges: [{ source: TALK, segments: ["g3"] }] },
      },
      { op: "add_node", node: { kind: "chapter", title: "Empty" } },
    ]);
    const view = await f.view();
    const graph = await f.graph();
    const withRanges = node(graph, created(made, 0));
    const empty = node(graph, created(made, 1));
    if (!isChapter(withRanges) || !isChapter(empty)) throw new Error("not chapters");
    expect(withRanges.status).toBe("proposed");
    expect(withRanges.estimatedDuration).toBe(view.facts[withRanges.id]?.materialDuration);
    expect(withRanges.estimatedDuration).toBeGreaterThan(0);
    expect(empty.estimatedDuration).toBe(30);
    expect(view.facts[empty.id]?.materialDuration).toBeUndefined();
  });

  it("checks assets and presets exist and are of the right kind", async () => {
    const f = story();
    const add = (node: Extract<StoryOperation, { op: "add_node" }>["node"]) =>
      f.refusal([{ op: "add_node", node }]);
    expect(await add({ kind: "video", title: "V", asset: "assets/nope.mp4" })).toMatchObject({
      code: "unknown_asset",
    });
    expect(await add({ kind: "video", title: "V", asset: "assets/photo.png" })).toMatchObject({
      code: "invalid_request",
    });
    expect(await add({ kind: "picture", title: "P", asset: "assets/music.mp3" })).toMatchObject({
      code: "invalid_request",
    });
    expect(await add({ kind: "motion", title: "M", preset: "nope" })).toMatchObject({
      code: "unknown_preset",
    });
    expect(existsSync(join(f.project.dir, STORY_GRAPH_PATH))).toBe(false);
  });
});

describe("an agent batch", () => {
  it("is atomic: a refused operation leaves the stored graph exactly as it was", async () => {
    const f = story();
    await threeNodes(f);
    const before = readFileSync(join(f.project.dir, STORY_GRAPH_PATH), "utf-8");
    const refusal = await f.refusal([
      { op: "add_node", node: { kind: "chapter", title: "Never stored" } },
      { op: "update_node", id: "chapter-missing", set: { title: "x" } },
    ]);
    expect(refusal).toMatchObject({ code: "unknown_node", opIndex: 1 });
    expect(readFileSync(join(f.project.dir, STORY_GRAPH_PATH), "utf-8")).toBe(before);
  });

  it("answers no_story for edits that need an existing node and creates the graph for adds", async () => {
    const f = story();
    expect(
      await f.refusal([{ op: "update_node", id: "chapter-1", set: { title: "x" } }]),
    ).toMatchObject({
      code: "no_story",
    });
    expect(existsSync(join(f.project.dir, STORY_GRAPH_PATH))).toBe(false);
    await f.edit([{ op: "set_story", title: "My video", brief: "Show the product" }]);
    const graph = f.graphFile();
    expect(graph).toMatchObject({ title: "My video", brief: "Show the product", updatedBy: "ai" });
  });

  it("refers to nodes added earlier in the batch with @ref and refuses references it does not know", async () => {
    const f = story();
    const made = await f.edit([
      { op: "add_node", ref: "one", node: { kind: "chapter", title: "One" } },
      { op: "add_node", ref: "two", node: { kind: "chapter", title: "Two" } },
      { op: "connect", from: "@one", to: "@two" },
    ]);
    const graph = f.graphFile();
    expect(graph.edges).toMatchObject([
      { from: created(made, 0), to: created(made, 1), createdBy: "ai" },
    ]);
    expect(
      await f.refusal([{ op: "update_node", id: "@ghost", set: { title: "x" } }]),
    ).toMatchObject({ code: "invalid_request" });
  });

  it("lays out new nodes without moving existing ones or overlapping anything", async () => {
    const f = story();
    const { a } = await threeNodes(f);
    await userEdit(f, (graph) => {
      const chapter = node(graph, a);
      chapter.position = { x: 500, y: 300 };
    });
    const before = await f.graph();
    await f.edit([
      { op: "add_node", ref: "c", node: { kind: "chapter", title: "Outro" } },
      {
        op: "add_node",
        ref: "p",
        node: { kind: "picture", title: "Logo", asset: "assets/photo.png" },
      },
      {
        op: "add_node",
        ref: "q",
        node: { kind: "picture", title: "Logo 2", asset: "assets/photo.png" },
      },
      { op: "attach", node: "@p", chapter: "@c" },
      { op: "attach", node: "@q", chapter: "@c" },
    ]);
    const after = await f.graph();
    for (const old of before.nodes) expect(node(after, old.id).position).toEqual(old.position);
    const fresh = after.nodes.filter((entry) => !before.nodes.some((old) => old.id === entry.id));
    const outro = fresh.find(isChapter);
    const pictures = fresh.filter((entry) => entry.kind === "picture");
    expect(outro && outro.position.x).toBeGreaterThan(
      Math.max(...before.nodes.filter(isChapter).map((chapter) => chapter.position.x)),
    );
    expect(pictures).toHaveLength(2);
    for (const picture of pictures)
      expect(picture.position.y).toBeGreaterThan(outro?.position.y ?? Infinity);
    expect(new Set(fresh.map((entry) => `${entry.position.x},${entry.position.y}`)).size).toBe(
      fresh.length,
    );
  });

  it("records the review on the graph with the turn that made it", async () => {
    const f = story();
    await threeNodes(f);
    await f.edit([{ op: "set_story", reviewSummary: "Moved the intro" }], { turnId: "turn-7" });
    expect(f.graphFile().review).toMatchObject({ summary: "Moved the intro", turnId: "turn-7" });
  });

  it("closes the gap when a chapter leaves the middle of the sequence", async () => {
    const f = story();
    const made = await f.edit([
      { op: "add_node", ref: "a", node: { kind: "chapter", title: "A" } },
      { op: "add_node", ref: "b", node: { kind: "chapter", title: "B" } },
      { op: "add_node", ref: "c", node: { kind: "chapter", title: "C" } },
      { op: "set_order", chapters: ["@a", "@b", "@c"] },
    ]);
    await f.edit([{ op: "remove_node", id: created(made, 1) }]);
    const view = await f.view();
    expect(view.order.chapters).toEqual([created(made, 0), created(made, 2)]);
    expect(view.graph?.edges).toHaveLength(1);
  });
});

describe("locked nodes", () => {
  it("are never updated, removed or attached to, while the edges around them may change", async () => {
    const f = story();
    const { a, b, v } = await threeNodes(f);
    await userEdit(f, (graph) => {
      node(graph, b).locked = true;
    });
    const locked = { code: "locked" };
    expect(
      await f.refusal([{ op: "update_node", id: b, set: { title: "Renamed" } }]),
    ).toMatchObject(locked);
    expect(await f.refusal([{ op: "remove_node", id: b }])).toMatchObject(locked);
    expect(await f.refusal([{ op: "attach", node: v, chapter: b }])).toMatchObject(locked);
    expect(await f.refusal([{ op: "detach", node: v, chapter: b }])).toMatchObject(locked);
    // Its links are the story's, not its own: they can be rewired.
    const c = created(
      await f.edit([{ op: "add_node", node: { kind: "chapter", title: "Third" } }]),
      0,
    );
    await f.edit([
      { op: "disconnect", from: a, to: b },
      { op: "connect", from: c, to: b },
    ]);
    expect((await f.view()).graph?.edges.map((edge) => [edge.from, edge.to])).toEqual([[c, b]]);
  });

  it("protect the material attached to them", async () => {
    const f = story();
    const { a, v } = await threeNodes(f);
    await userEdit(f, (graph) => {
      node(graph, v).locked = true;
    });
    expect(await f.refusal([{ op: "detach", node: v, chapter: a }])).toMatchObject({
      code: "locked",
    });
    expect(await f.refusal([{ op: "remove_node", id: a }])).toMatchObject({ code: "locked" });
  });
});

describe("what the user decided", () => {
  it("keeps a field the user set by hand, but lets the agent set the same value and change other fields", async () => {
    const f = story();
    const { a } = await threeNodes(f);
    await userEdit(f, (graph) => {
      const chapter = node(graph, a);
      if (isChapter(chapter)) {
        chapter.title = "Cold open";
        chapter.estimatedDuration = 12;
      }
    });
    const refusal = await f.refusal([{ op: "update_node", id: a, set: { estimatedDuration: 40 } }]);
    expect(refusal.code).toBe("user_decision");
    expect(refusal.message).toContain("estimatedDuration");
    await f.edit([
      { op: "update_node", id: a, set: { title: "Cold open", description: "Says hello" } },
    ]);
    const chapter = node(await f.graph(), a);
    expect(chapter).toMatchObject({
      title: "Cold open",
      estimatedDuration: 12,
      description: "Says hello",
    });
    if (isChapter(chapter))
      expect(chapter.userEdited.sort()).toEqual(["estimatedDuration", "title"]);
  });

  it("keeps what the user added: nodes, links and attachments", async () => {
    const f = story();
    const { a, b, v } = await threeNodes(f);
    const saved = await userEdit(f, (graph) => {
      graph.nodes.push({
        id: "chapter-user",
        kind: "chapter",
        title: "My chapter",
        position: { x: 0, y: 500 },
        locked: false,
        createdBy: "ai",
        userEdited: [],
        purpose: "",
        description: "",
        narrativeRole: "main",
        estimatedDuration: 30,
        status: "proposed",
        sourceRanges: [],
        aRoll: "",
        bRoll: "",
        captions: false,
        graphics: "",
        audio: "",
        previewFrame: null,
      });
      graph.edges = graph.edges.filter((edge) => !(edge.from === a && edge.to === b));
      graph.edges.push({
        id: "edge-user",
        kind: "sequence",
        from: b,
        to: "chapter-user",
        transition: "",
        createdBy: "ai",
      });
      graph.attachments.push({
        id: "att-user",
        node: v,
        chapter: b,
        placement: "start",
        offset: null,
        duration: null,
        createdBy: "ai",
      });
    });
    expect(saved.nodes.find((entry) => entry.id === "chapter-user")?.createdBy).toBe("user");
    expect(await f.refusal([{ op: "remove_node", id: "chapter-user" }])).toMatchObject({
      code: "user_decision",
    });
    expect(await f.refusal([{ op: "disconnect", from: b, to: "chapter-user" }])).toMatchObject({
      code: "user_decision",
    });
    expect(await f.refusal([{ op: "detach", node: v, chapter: b }])).toMatchObject({
      code: "user_decision",
    });
    expect(
      await f.refusal([{ op: "attach", node: v, chapter: b, placement: "end" }]),
    ).toMatchObject({ code: "user_decision" });
    // Removing an AI chapter must not silently drop the user's link that ends in it.
    expect(await f.refusal([{ op: "remove_node", id: b }])).toMatchObject({
      code: "user_decision",
    });
  });

  it("never puts back a link or attachment the user removed", async () => {
    const f = story();
    const { a, b, v } = await threeNodes(f);
    const saved = await userEdit(f, (graph) => {
      graph.edges = [];
      graph.attachments = [];
    });
    expect(saved.removedByUser).toEqual([
      { kind: "edge", from: a, to: b },
      { kind: "attachment", node: v, chapter: a },
    ]);
    expect(await f.refusal([{ op: "connect", from: a, to: b }])).toMatchObject({
      code: "user_decision",
    });
    expect(await f.refusal([{ op: "attach", node: v, chapter: a }])).toMatchObject({
      code: "user_decision",
    });
    expect(await f.refusal([{ op: "set_order", chapters: [a, b] }])).toMatchObject({
      code: "user_decision",
    });
  });

  it("does not let set_order undo a reorder the user made, but accepts the order the user chose", async () => {
    const f = story();
    const made = await f.edit([
      { op: "add_node", ref: "a", node: { kind: "chapter", title: "A" } },
      { op: "add_node", ref: "b", node: { kind: "chapter", title: "B" } },
      { op: "add_node", ref: "c", node: { kind: "chapter", title: "C" } },
      { op: "set_order", chapters: ["@a", "@b", "@c"] },
    ]);
    const [a, b, c] = [created(made, 0), created(made, 1), created(made, 2)];
    // The user drags C in front of B: A → C → B.
    await userEdit(f, (graph) => {
      graph.edges = [
        { id: "e1", kind: "sequence", from: a, to: c, transition: "", createdBy: "ai" },
        { id: "e2", kind: "sequence", from: c, to: b, transition: "", createdBy: "ai" },
      ];
    });
    expect((await f.view()).order.chapters).toEqual([a, c, b]);
    const refusal = await f.refusal([{ op: "set_order", chapters: [a, b, c] }]);
    expect(refusal.code).toBe("user_decision");
    await f.edit([{ op: "set_order", chapters: [a, c, b] }]);
    expect((await f.view()).order.chapters).toEqual([a, c, b]);
  });

  it("lets the agent write the transition of a link the user drew, but not rewrite one the user wrote", async () => {
    const f = story();
    const { a, b } = await threeNodes(f);
    await userEdit(f, (graph) => {
      graph.edges = [
        { id: "drawn", kind: "sequence", from: b, to: a, transition: "", createdBy: "ai" },
      ];
    });
    await f.edit([{ op: "connect", from: b, to: a, transition: "match cut on the gesture" }]);
    expect((await f.graph()).edges).toMatchObject([
      { from: b, to: a, transition: "match cut on the gesture", createdBy: "user" },
    ]);
    await userEdit(f, (graph) => {
      for (const edge of graph.edges) edge.transition = "hard cut";
    });
    expect(
      await f.refusal([{ op: "connect", from: b, to: a, transition: "slow fade" }]),
    ).toMatchObject({ code: "user_decision" });
  });
});
