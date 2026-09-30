import { describe, expect, it } from "vitest";
import { parseStoryGraph, storyOrder, type StoryGraph } from "@hyperframes/agent-protocol";
import { addNode, connectNodes, newChapter, newMaterial, removeItems } from "./storyGraphOps";
import { chapter, sampleGraph } from "./storyTestHarness";

function connected(graph: StoryGraph, source: string, target: string): StoryGraph {
  const result = connectNodes(graph, { source, target });
  if (!result.ok) throw new Error(result.reason);
  return result.graph;
}

const pairs = (graph: StoryGraph) => graph.edges.map((edge) => `${edge.from}>${edge.to}`).sort();

/** What the server's parser says about a graph the canvas produced. */
function acceptedByServer(graph: StoryGraph): boolean {
  return parseStoryGraph(graph).ok;
}

describe("connecting chapters", () => {
  it("rewires: the new edge replaces the source's outgoing and the target's incoming edge", () => {
    const next = connected(sampleGraph(), "a", "c");
    expect(pairs(next)).toEqual(["a>c"]);
    expect(storyOrder(next).chapters).toEqual(["a", "c", "b"]);
    expect(next.edges.find((edge) => edge.from === "a")?.createdBy).toBe("user");
    expect(acceptedByServer(next)).toBe(true);
  });

  it("moves a loose chapter into the chain in place of the target's previous predecessor", () => {
    const graph = sampleGraph();
    const withD = { ...graph, nodes: [...graph.nodes, chapter("d", 900)] };
    const next = connected(withD, "d", "b");
    expect(pairs(next)).toEqual(["b>c", "d>b"]);
    expect(storyOrder(next).chapters).toEqual(["a", "d", "b", "c"]);
  });

  it("refuses a connection that would make the story loop, and changes nothing", () => {
    const graph = sampleGraph();
    const result = connectNodes(graph, { source: "c", target: "a" });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("loop") });
    expect(connectNodes(graph, { source: "c", target: "b" }).ok).toBe(false);
  });

  it("refuses an edge that already exists and a chapter following itself", () => {
    const graph = sampleGraph();
    expect(connectNodes(graph, { source: "a", target: "b" }).ok).toBe(false);
    expect(connectNodes(graph, { source: "a", target: "a" }).ok).toBe(false);
  });
});

describe("attaching material", () => {
  it("material → chapter creates a user attachment and leaves the sequence alone", () => {
    const graph = sampleGraph();
    const next = connected(graph, "v", "c");
    const added = next.attachments.find((item) => item.chapter === "c");
    expect(added).toMatchObject({ node: "v", chapter: "c", createdBy: "user", placement: "start" });
    expect(pairs(next)).toEqual(pairs(graph));
    expect(acceptedByServer(next)).toBe(true);
  });

  it("music defaults to playing throughout the chapter", () => {
    const graph = sampleGraph();
    const music = newMaterial("m", { x: 0, y: 400 }, { kind: "music" });
    if (!music) throw new Error("music needs no asset");
    const added = addNode(graph, music);
    if (!added.ok) throw new Error(added.reason);
    const next = connected(added.graph, "m", "a");
    expect(next.attachments.at(-1)?.placement).toBe("throughout");
  });

  it("refuses a second attachment of the same pair, chapter → material and material → material", () => {
    const graph = sampleGraph();
    expect(connectNodes(graph, { source: "v", target: "b" }).ok).toBe(false);
    expect(connectNodes(graph, { source: "b", target: "v" })).toEqual({
      ok: false,
      reason: expect.stringContaining("Drag from the material"),
    });
    const other = newMaterial("w", { x: 0, y: 500 }, { kind: "missing" });
    if (!other) throw new Error("missing needs no asset");
    const added = addNode(graph, other);
    if (!added.ok) throw new Error(added.reason);
    expect(connectNodes(added.graph, { source: "w", target: "v" }).ok).toBe(false);
  });
});

describe("deleting", () => {
  it("a chapter takes its sequence edges and attachments with it", () => {
    const next = removeItems(sampleGraph(), ["b"]);
    expect(next.nodes.map((node) => node.id)).toEqual(["a", "c", "v"]);
    expect(next.edges).toEqual([]);
    expect(next.attachments).toEqual([]);
    expect(acceptedByServer(next)).toBe(true);
  });

  it("a material takes its attachments; an edge id removes only that edge", () => {
    const graph = sampleGraph();
    expect(removeItems(graph, ["v"]).attachments).toEqual([]);
    const withoutEdge = removeItems(graph, ["e1"]);
    expect(pairs(withoutEdge)).toEqual(["b>c"]);
    expect(withoutEdge.attachments).toHaveLength(1);
  });

  it("returns the same graph when nothing matched, so no empty undo step is recorded", () => {
    const graph = sampleGraph();
    expect(removeItems(graph, ["nope"])).toBe(graph);
  });
});

describe("new nodes", () => {
  it("a new chapter and each material kind make a graph the server accepts", () => {
    let graph = sampleGraph();
    const created = [
      newChapter("n1", { x: 10, y: 10 }),
      newMaterial("n2", { x: 20, y: 20 }, { kind: "video", source: "media/a.mp4" }),
      newMaterial("n3", { x: 30, y: 30 }, { kind: "picture", source: "media/a.png" }),
      newMaterial("n4", { x: 40, y: 40 }, { kind: "music" }),
      newMaterial("n5", { x: 50, y: 50 }, { kind: "motion", source: "stat-counter", duration: 4 }),
      newMaterial("n6", { x: 60, y: 60 }, { kind: "missing" }),
    ];
    for (const node of created) {
      if (!node) throw new Error("fixture node missing");
      const result = addNode(graph, node);
      if (!result.ok) throw new Error(result.reason);
      graph = result.graph;
    }
    expect(parseStoryGraph(graph)).toMatchObject({ ok: true });
  });

  it("media and motion nodes need their file or preset", () => {
    expect(newMaterial("x", { x: 0, y: 0 }, { kind: "video" })).toBeNull();
    expect(newMaterial("x", { x: 0, y: 0 }, { kind: "motion" })).toBeNull();
  });
});
