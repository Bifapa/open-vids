// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STORY_GRAPH_PATH, STORY_SYNC_PATH } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryWho } from "../history/historyLog.js";
import { openProjectHistory, type ProjectHistory } from "../history/projectHistory.js";
import { createStoryFixture, TALK, type StoryFixture } from "./testSupport.js";

const agent: HistoryWho = { kind: "agent", name: "Director" };

let fixture: StoryFixture | undefined;
let history: ProjectHistory | undefined;
afterEach(async () => {
  await history?.close();
  fixture?.cleanup();
  history = undefined;
  fixture = undefined;
});

/** A story fixture whose adapter hands out one real history for the project. */
async function open(): Promise<{ f: StoryFixture; engine: ProjectHistory }> {
  const f = createStoryFixture();
  fixture = f;
  const engine = await openProjectHistory({
    projectDir: f.project.dir,
    historyRoot: join(f.made.root, "history"),
  });
  history = engine;
  f.made.adapter.history = () => engine;
  return { f, engine };
}

const graphPath = (f: StoryFixture) => join(f.project.dir, STORY_GRAPH_PATH);

describe("the story graph in project history", () => {
  it("is restored, together with the timeline, when an agent turn is undone", async () => {
    const { f, engine } = await open();
    // A story that exists before the turn.
    await f.edit([{ op: "add_node", node: { kind: "chapter", title: "Before" } }]);
    await engine.flush();
    const graphBefore = readFileSync(graphPath(f), "utf-8");
    const indexBefore = f.made.read("index.html");

    const window = await engine.beginWindow(agent, "Director turn");
    await f.edit(
      [
        {
          op: "add_node",
          node: {
            kind: "chapter",
            title: "After",
            sourceRanges: [{ source: TALK, segments: ["g1"] }],
          },
        },
        { op: "set_story", reviewSummary: "Added a chapter" },
      ],
      { turnId: "turn-1" },
    );
    await f.service.build(f.project, { turnId: "turn-1" });
    expect(f.made.read("index.html")).not.toBe(indexBefore);
    const entry = await window.close();

    expect(entry?.who).toEqual(agent);
    expect(entry?.files.map((file) => file.path).sort()).toEqual([
      STORY_GRAPH_PATH,
      STORY_SYNC_PATH,
      "index.html",
    ]);
    const result = await engine.undo(entry?.id ?? "", { who: agent, mode: "keep-later-edits" });
    expect(result.ok).toBe(true);
    expect(readFileSync(graphPath(f), "utf-8")).toBe(graphBefore);
    expect(f.made.read("index.html")).toBe(indexBefore);
    expect(existsSync(join(f.project.dir, STORY_SYNC_PATH))).toBe(false);
    // After the revert nothing is shown as built.
    const view = await f.view();
    expect(view.graph?.nodes).toHaveLength(1);
    expect(Object.values(view.facts).every((facts) => facts.timeline === null)).toBe(true);
  });

  it("goes away with the turn that created it", async () => {
    const { f, engine } = await open();
    const window = await engine.beginWindow(agent, "Director turn");
    await f.edit([{ op: "add_node", node: { kind: "chapter", title: "New" } }]);
    const entry = await window.close();
    expect(existsSync(graphPath(f))).toBe(true);
    const result = await engine.undo(entry?.id ?? "", { who: agent, mode: "keep-later-edits" });
    expect(result.ok).toBe(true);
    expect(existsSync(graphPath(f))).toBe(false);
    expect((await f.view()).graph).toBeNull();
  });

  it("files a save from Studio as 'Edited story' by You, one entry for a burst of saves", async () => {
    const { f, engine } = await open();
    await f.edit([{ op: "add_node", node: { kind: "chapter", title: "Ai chapter" } }]);
    await engine.flush();

    const save = async (title: string) => {
      const view = await f.view();
      const graph = structuredClone(await f.graph());
      graph.title = title;
      await f.service.save(f.project, { baseVersion: view.version, graph });
    };
    await save("One");
    await save("Two");
    await save("Three");
    await engine.flush();
    const saved = engine.list().filter((entry) => entry.label === "Edited story");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.who).toEqual({ kind: "person", name: "You" });
    expect(saved[0]?.files.map((file) => file.path)).toEqual([STORY_GRAPH_PATH]);
    // The agent's own edit before it is a separate entry, not the person's.
    expect(engine.list().length).toBeGreaterThan(1);
  });
});
