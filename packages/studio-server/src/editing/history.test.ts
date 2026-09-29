// @vitest-environment node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EditOperation } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openProjectHistory, type ProjectHistory } from "../history/projectHistory.js";
import type { HistoryWho } from "../history/historyLog.js";
import { applyEdits } from "./operations.js";
import { createTestProject, type TestProject } from "./testProject.js";

const SKINS = join(import.meta.dirname, "../../../../skills/hyperframes-creative/frame-presets");
const director: HistoryWho = { kind: "agent", name: "Director" };

let project: TestProject | undefined;
let history: ProjectHistory | undefined;
afterEach(async () => {
  await history?.close();
  project?.cleanup();
  history = undefined;
  project = undefined;
});

async function open() {
  const made = createTestProject({ adapter: { captionSkinsDir: () => SKINS } });
  project = made;
  history = await openProjectHistory({
    projectDir: made.project.dir,
    historyRoot: join(made.root, "history"),
  });
  return { made, history };
}

const edit = (made: TestProject, operations: EditOperation[]) =>
  applyEdits(
    {
      project: made.project,
      compositionPath: "index.html",
      adapter: made.adapter,
      facts: made.facts,
    },
    { operations },
  );

describe("history attribution of editing writes", () => {
  it("attributes a batch to the open agent window, and undoing the window restores every file", async () => {
    const { made, history: engine } = await open();
    const indexBefore = made.read("index.html");
    const window = await engine.beginWindow(director, "Director turn");

    const outcome = await edit(made, [
      { op: "add_clip", asset: "assets/b.mp4", start: 10, track: 1 },
      { op: "add_text", text: "Hello", start: 10, duration: 2, track: 2 },
      { op: "apply_captions", preset: "coral", cues: [{ text: "Hi there", start: 0, end: 2 }] },
    ]);
    expect(outcome.changedFiles).toEqual(["index.html", "compositions/captions.html"]);
    expect(made.read("index.html")).not.toBe(indexBefore);

    const entry = await window.close();
    expect(entry?.who).toEqual(director);
    expect(entry?.files.map((file) => file.path).sort()).toEqual([
      "compositions/captions.html",
      "index.html",
    ]);

    const result = await engine.undo(entry?.id ?? "", { who: director, mode: "keep-later-edits" });
    expect(result.ok).toBe(true);
    expect(made.read("index.html")).toBe(indexBefore);
    expect(existsSync(join(made.project.dir, "compositions/captions.html"))).toBe(false);
  });

  it("keeps a person's later edit to another file while undoing the batch", async () => {
    const { made, history: engine } = await open();
    const indexBefore = made.read("index.html");
    const window = await engine.beginWindow(director, "Director turn");
    await edit(made, [{ op: "add_text", text: "Hello", start: 0, duration: 1, track: 5 }]);
    const entry = await window.close();

    writeFileSync(join(made.project.dir, "notes.txt"), "later, by hand");
    const result = await engine.undo(entry?.id ?? "", { who: director, mode: "keep-later-edits" });
    expect(result.ok).toBe(true);
    expect(made.read("index.html")).toBe(indexBefore);
    expect(readFileSync(join(made.project.dir, "notes.txt"), "utf-8")).toBe("later, by hand");
  });
});
