// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { STORY_GRAPH_PATH, isChapter, type StoryGraph } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { isStoryFailure } from "./errors.js";
import { createStoryFixture, created, TALK, type StoryFixture } from "./testSupport.js";

let fixture: StoryFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function story(): StoryFixture {
  fixture = createStoryFixture();
  return fixture;
}

const fileBytes = (f: StoryFixture) => readFileSync(join(f.project.dir, STORY_GRAPH_PATH));

async function seeded(f: StoryFixture) {
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
    { op: "connect", from: "@a", to: "@b" },
    { op: "attach", node: "@v", chapter: "@a" },
  ]);
  return { a: created(made, 0), b: created(made, 1), v: created(made, 2) };
}

async function save(
  f: StoryFixture,
  change: (graph: StoryGraph) => void,
  baseVersion?: string | null,
) {
  const before = await f.view();
  const graph = structuredClone(await f.graph());
  change(graph);
  return f.service.save(f.project, {
    baseVersion: baseVersion === undefined ? before.version : baseVersion,
    graph,
  });
}

describe("the stored graph", () => {
  it("is pretty JSON in the project, versioned by the sha256 of its bytes, with node ids that stay put across edits", async () => {
    const f = story();
    expect((await f.view()).graph).toBeNull();
    const { a, b } = await seeded(f);

    const view = await f.view();
    const bytes = fileBytes(f);
    expect(bytes.toString("utf-8")).toContain('\n  "nodes": [');
    expect(view.version).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    expect(view.order.chapters).toEqual([a, b]);

    await f.edit([{ op: "update_node", id: a, set: { description: "Says hello" } }]);
    await f.edit([{ op: "add_node", node: { kind: "chapter", title: "Outro" } }]);
    const graph = await f.graph();
    expect(graph.nodes.slice(0, 2).map((node) => node.id)).toEqual([a, b]);
    expect(graph.nodes).toHaveLength(4);
    expect((await f.view()).version).not.toBe(view.version);
  });

  it("refuses an agent edit made on an older version, accepting the version bare or quoted", async () => {
    const f = story();
    await seeded(f);
    const stale = (await f.view()).version ?? "";
    await f.edit([{ op: "set_story", title: "Second" }]);
    const current = (await f.view()).version ?? "";
    await expect(
      f.service.edit(f.project, {
        baseVersion: stale,
        operations: [{ op: "set_story", title: "Third" }],
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isStoryFailure(error) && error.error.code === "conflict",
    );
    expect((await f.graph()).title).toBe("Second");
    await f.service.edit(f.project, {
      baseVersion: `"${current}"`,
      operations: [{ op: "set_story", title: "Third" }],
    });
    expect((await f.graph()).title).toBe("Third");
  });
});

describe("a save from Studio", () => {
  it("is refused on a stale baseVersion and writes nothing", async () => {
    const f = story();
    await seeded(f);
    const stale = (await f.view()).version;
    await f.edit([{ op: "set_story", title: "Agent moved on" }]);
    const bytes = fileBytes(f);
    await expect(save(f, (graph) => (graph.title = "Mine"), stale)).rejects.toSatisfy(
      (error: unknown) => isStoryFailure(error) && error.error.code === "conflict",
    );
    expect(fileBytes(f).equals(bytes)).toBe(true);
    // The very first graph is created with baseVersion null; an existing one refuses null.
    await expect(save(f, (graph) => (graph.title = "Mine"), null)).rejects.toSatisfy(
      (error: unknown) => isStoryFailure(error) && error.error.code === "conflict",
    );
  });

  it("records what the user did, ignoring the authorship the client sends", async () => {
    const f = story();
    const { a, b, v } = await seeded(f);
    const first = await f.graph();
    const untouchedB = first.nodes.find((node) => node.id === b);

    const saved = await save(f, (graph) => {
      for (const node of graph.nodes) {
        if (node.id === a && isChapter(node)) {
          node.title = "Cold open";
          node.captions = true;
          node.userEdited = []; // a lie: the server works out what changed
        }
        node.createdBy = "ai";
      }
      graph.nodes.push({
        id: "chapter-mine",
        kind: "chapter",
        title: "Mine",
        position: { x: 10, y: 10 },
        locked: false,
        createdBy: "ai",
        userEdited: [],
        purpose: "",
        description: "A new idea",
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
      graph.edges = [
        {
          id: "edge-mine",
          kind: "sequence",
          from: a,
          to: "chapter-mine",
          transition: "",
          createdBy: "ai",
        },
      ];
      graph.attachments = [];
      graph.removedByUser = [];
      graph.review = { at: 1, turnId: null, summary: "forged" };
    });
    const out = saved.graph;
    if (!out) throw new Error("no graph");
    const cold = out.nodes.find((node) => node.id === a);
    expect(cold?.userEdited.sort()).toEqual(["captions", "title"]);
    expect(cold?.createdBy).toBe("ai");
    expect(out.nodes.find((node) => node.id === b)).toEqual(untouchedB);
    const mine = out.nodes.find((node) => node.id === "chapter-mine");
    expect(mine).toMatchObject({ createdBy: "user" });
    expect(mine?.userEdited).toEqual(["title", "description"]);
    expect(out.edges).toMatchObject([{ from: a, to: "chapter-mine", createdBy: "user" }]);
    expect(out.removedByUser).toEqual([
      { kind: "edge", from: a, to: b },
      { kind: "attachment", node: v, chapter: a },
    ]);
    expect(out.review).toBeNull();
    expect(out.updatedBy).toBe("user");
    expect(saved.version).not.toBeNull();
  });

  it("clears a tombstone when the user puts the link or attachment back, and it then counts as theirs", async () => {
    const f = story();
    const { a, b, v } = await seeded(f);
    const first = await f.graph();
    const original = { edges: first.edges, attachments: first.attachments };
    await save(f, (graph) => {
      graph.edges = [];
      graph.attachments = [];
    });
    expect((await f.graph()).removedByUser).toHaveLength(2);

    await save(f, (graph) => {
      graph.edges = original.edges;
      graph.attachments = original.attachments;
    });
    const back = await f.graph();
    expect(back.removedByUser).toEqual([]);
    expect(back.edges).toMatchObject([{ from: a, to: b, createdBy: "user" }]);
    expect(back.attachments).toMatchObject([{ node: v, chapter: a, createdBy: "user" }]);
    // Their decision now: an agent cannot take the attachment away.
    expect(await f.refusal([{ op: "detach", node: v, chapter: a }])).toMatchObject({
      code: "user_decision",
    });
  });

  it("does not touch the file when nothing changed", async () => {
    const f = story();
    await seeded(f);
    const path = join(f.project.dir, STORY_GRAPH_PATH);
    const before = { bytes: fileBytes(f), mtime: statSync(path).mtimeMs };
    const view = await save(f, () => undefined);
    expect(fileBytes(f).equals(before.bytes)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(before.mtime);
    expect(view.version).toBe(`sha256:${createHash("sha256").update(before.bytes).digest("hex")}`);
  });

  it("rejects a graph that breaks the sequence rules", async () => {
    const f = story();
    const { a, b } = await seeded(f);
    await expect(
      save(f, (graph) => {
        graph.edges.push({
          id: "loop",
          kind: "sequence",
          from: b,
          to: a,
          transition: "",
          createdBy: "user",
        });
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isStoryFailure(error) && error.error.code === "invalid_request",
    );
  });
});
