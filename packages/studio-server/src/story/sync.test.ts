// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STORY_GRAPH_PATH,
  STORY_SYNC_PATH,
  isChapter,
  type StoryGraph,
  type StorySyncSection,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { cleanRanges } from "../analysis/cutPlan.js";
import { writeAssetRanges } from "../editing/assetRanges.js";
import { captionsFileFor } from "../editing/captions.js";
import { clipState, type ClipState } from "../editing/clipState.js";
import { applyEdits } from "../editing/operations.js";
import { readComposition } from "../editing/service.js";
import { parseComposition, serializeModel } from "../editing/timeline.js";
import { parseSourceDocument, removeElementsFromHtml } from "../helpers/sourceMutation.js";
import type { HistoryWho } from "../history/historyLog.js";
import { openProjectHistory, type ProjectHistory } from "../history/projectHistory.js";
import { isStoryFailure } from "./errors.js";
import { readLedger, type SyncLedger } from "./ledger.js";
import {
  BLANK_HTML,
  createStoryFixture,
  created,
  TALK,
  talkAnalysis,
  type StoryFixture,
} from "./testSupport.js";

let fixture: StoryFixture | undefined;
let history: ProjectHistory | undefined;
afterEach(async () => {
  await history?.close();
  fixture?.cleanup();
  fixture = undefined;
  history = undefined;
});

/** A composition with the user's own title card on track 7 before any build. */
const WITH_TITLE = BLANK_HTML.replace(
  `data-duration="0"></div>`,
  `data-duration="0">
      <div id="manual" data-hf-id="hf-manual" class="clip" data-start="4" data-duration="1" data-track-index="7" style="position: absolute; z-index: 9">My title</div>
    </div>`,
);

interface Ids {
  intro: string;
  main: string;
  outro: string;
  card: string;
  cut: string;
  pic: string;
  fx: string;
  bed: string;
}

/**
 * Intro (g1, captions, motion at its start) → Main (g2, captions, B-roll at its end) → Outro (g3, a picture in the
 * middle) → Card (no speech, 3 s). A music bed scores Intro through Outro.
 */
async function referenceStory(f: StoryFixture): Promise<Ids> {
  const made = await f.edit([
    {
      op: "add_node",
      ref: "intro",
      node: {
        kind: "chapter",
        title: "Intro",
        captions: true,
        sourceRanges: [{ source: TALK, segments: ["g1"] }],
      },
    },
    {
      op: "add_node",
      ref: "main",
      node: {
        kind: "chapter",
        title: "Main",
        captions: true,
        sourceRanges: [{ source: TALK, segments: ["g2"] }],
      },
    },
    {
      op: "add_node",
      ref: "outro",
      node: { kind: "chapter", title: "Outro", sourceRanges: [{ source: TALK, segments: ["g3"] }] },
    },
    { op: "add_node", ref: "card", node: { kind: "chapter", title: "Card", estimatedDuration: 3 } },
    { op: "set_order", chapters: ["@intro", "@main", "@outro", "@card"] },
    {
      op: "add_node",
      ref: "cut",
      node: { kind: "video", title: "Cutaway", asset: "assets/b.mp4" },
    },
    {
      op: "add_node",
      ref: "pic",
      node: { kind: "picture", title: "Photo", asset: "assets/photo.png" },
    },
    {
      op: "add_node",
      ref: "fx",
      node: { kind: "motion", title: "Sparkle", preset: "sparkle", duration: 1 },
    },
    {
      op: "add_node",
      ref: "bed",
      node: { kind: "music", title: "Bed", asset: "assets/music.mp3", volume: 0.3 },
    },
    { op: "attach", node: "@fx", chapter: "@intro", placement: "start" },
    { op: "attach", node: "@cut", chapter: "@main", placement: "end", duration: 0.6 },
    { op: "attach", node: "@pic", chapter: "@outro", placement: "middle", duration: 0.5 },
    { op: "attach", node: "@bed", chapter: "@intro" },
    { op: "attach", node: "@bed", chapter: "@main" },
    { op: "attach", node: "@bed", chapter: "@outro" },
  ]);
  return {
    intro: created(made, 0),
    main: created(made, 1),
    outro: created(made, 2),
    card: created(made, 3),
    cut: created(made, 5),
    pic: created(made, 6),
    fx: created(made, 7),
    bed: created(made, 8),
  };
}

async function built(html = WITH_TITLE): Promise<{ f: StoryFixture; ids: Ids }> {
  const f = createStoryFixture({ html });
  fixture = f;
  const ids = await referenceStory(f);
  await f.service.build(f.project, { turnId: "turn-build" });
  return { f, ids };
}

function ledgerOf(f: StoryFixture): SyncLedger {
  const read = readLedger(f.project.dir);
  if (read.state !== "ok") throw new Error(`no ledger: ${read.state}`);
  return read.ledger;
}

/** Clip ids a chapter's section owns (per the ledger), optionally of one role. */
function sectionClips(f: StoryFixture, chapter: string, role?: string): string[] {
  const section = ledgerOf(f).sections.find((entry) => entry.chapter === chapter);
  return (section?.units ?? [])
    .filter((unit) => role === undefined || unit.role === role)
    .flatMap((unit) => unit.entities.map((entity) => entity.clip));
}

async function states(f: StoryFixture): Promise<Map<string, ClipState>> {
  const { model } = await readComposition(f.project, "index.html", f.made.facts);
  return new Map(model.clips.map((clip) => [clip.id, clipState(clip)]));
}

/** Each clip's markup, by hf id (to prove a section was left byte-for-byte alone). */
function markup(f: StoryFixture): Map<string, string> {
  const model = parseComposition(f.made.read("index.html"), "index.html");
  if (!model) throw new Error("no composition");
  return new Map(model.clips.map((clip) => [clip.id, clip.element.outerHTML]));
}

/** What Studio does when the user edits a clip on the timeline: change its attributes, keep everything else. */
function userEditsClip(f: StoryFixture, id: string, change: (element: Element) => void): void {
  const model = parseComposition(f.made.read("index.html"), "index.html");
  const clip = model?.clips.find((candidate) => candidate.id === id);
  if (!model || !clip) throw new Error(`no clip ${id}`);
  change(clip.element);
  f.made.write("index.html", serializeModel(model));
}

function userDeletesClip(f: StoryFixture, id: string): void {
  f.made.write("index.html", removeElementsFromHtml(f.made.read("index.html"), [{ hfId: id }]));
}

/** A Studio canvas save of the graph after `change` (authorship worked out by the service). */
async function userSaves(f: StoryFixture, change: (graph: StoryGraph) => void): Promise<void> {
  const view = await f.view();
  if (!view.graph) throw new Error("no graph");
  const graph = structuredClone(view.graph);
  change(graph);
  await f.service.save(f.project, { baseVersion: view.version, graph });
}

function chapterOf(graph: StoryGraph, id: string) {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node || !isChapter(node)) throw new Error(`no chapter ${id}`);
  return node;
}

const rebuild = (f: StoryFixture, extra: Parameters<StoryFixture["service"]["rebuild"]>[1] = {}) =>
  f.service.rebuild(f.project, { turnId: "turn-rebuild", ...extra });

async function reportOf(f: StoryFixture) {
  const sync = (await f.view()).sync;
  if (!sync) throw new Error("no sync report");
  return sync;
}

const section = (sections: StorySyncSection[], chapter: string) => {
  const found = sections.find((entry) => entry.chapter === chapter);
  if (!found) throw new Error(`no section ${chapter}`);
  return found;
};

/** Every clip of `ids` kept its id and content, and moved by exactly `delta`. */
function expectShifted(
  before: Map<string, ClipState>,
  after: Map<string, ClipState>,
  ids: string[],
  delta: number,
) {
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) {
    const was = before.get(id);
    const now = after.get(id);
    expect(now, id).toBeDefined();
    if (!was || !now) continue;
    expect(now.start).toBeCloseTo(was.start + delta, 3);
    expect({ ...now, start: 0 }).toEqual({ ...was, start: 0 });
  }
}

describe("Story ↔ timeline sync ledger", () => {
  it("records which clips every section, bed and the captions own, and reports the fresh build in sync", async () => {
    const { f, ids } = await built();
    const ledger = ledgerOf(f);
    expect(ledger.sections.map((entry) => entry.chapter)).toEqual([
      ids.intro,
      ids.main,
      ids.outro,
      ids.card,
    ]);
    const clips = await readComposition(f.project, "index.html", f.made.facts);
    const byId = new Map(clips.snapshot.clips.map((clip) => [clip.id, clip]));
    for (const entry of ledger.sections) {
      for (const unit of entry.units) {
        for (const entity of unit.entities) {
          expect(byId.get(entity.clip)?.provenance?.storyNode).toBe(unit.node);
        }
      }
    }
    expect(sectionClips(f, ids.intro, "motion")).toHaveLength(1);
    expect(sectionClips(f, ids.main, "b_roll")).toHaveLength(1);
    expect(ledger.music.map((unit) => [unit.node, unit.covers])).toEqual([
      [ids.bed, [ids.intro, ids.main, ids.outro]],
    ]);
    expect(ledger.captions?.entity).not.toBeNull();
    // The user's own clip belongs to no section.
    const owned = new Set(
      ledger.sections.flatMap((entry) => entry.units.flatMap((u) => u.entities.map((e) => e.clip))),
    );
    expect(owned.has("hf-manual")).toBe(false);

    const report = await reportOf(f);
    expect(report).toMatchObject({
      state: "in_sync",
      affected: [],
      moved: [],
      manualEdits: 0,
      conflicts: 0,
    });
    expect(report.unrelated.map((clip) => clip.clip)).toEqual(["hf-manual"]);
  });

  it("finds nothing to rebuild after graph changes that do not change the edit", async () => {
    const { f, ids } = await built();
    await userSaves(f, (graph) => {
      const intro = chapterOf(graph, ids.intro);
      intro.title = "Opening";
      intro.description = "Say hello";
      intro.purpose = "Greet";
      intro.status = "approved";
      intro.position = { x: intro.position.x + 300, y: intro.position.y + 40 };
      chapterOf(graph, ids.main).estimatedDuration = 42; // it has speech: its A-roll decides its length
      const edge = graph.edges.find((candidate) => candidate.from === ids.intro);
      if (edge) edge.transition = "Hard cut";
    });
    const report = await reportOf(f);
    expect(report.state).toBe("in_sync");
    expect(report.affected).toEqual([]);
    const html = f.made.read("index.html");
    const ledgerBytes = readFileSync(join(f.project.dir, STORY_SYNC_PATH), "utf-8");
    const result = await rebuild(f);
    expect(result.changed).toBe(false);
    expect(f.made.read("index.html")).toBe(html);
    expect(readFileSync(join(f.project.dir, STORY_SYNC_PATH), "utf-8")).toBe(ledgerBytes);
  });

  it("removes an untouched template placeholder on rebuild, reports it and keeps everything else", async () => {
    const { f } = await built();
    const html = f.made.read("index.html");
    f.made.write(
      "index.html",
      html.replace(
        /<div id="manual"/,
        `<h1 id="title" data-hf-id="hf-ph" class="clip" data-start="0" data-duration="10" data-track-index="0" data-ov-placeholder="template">Title</h1><div id="manual"`,
      ),
    );
    const result = await rebuild(f);
    expect(result.changed).toBe(true);
    expect(result.warnings).toContain(
      'Removed the untouched template placeholder "Title" (0–10 s); it was not user content.',
    );
    const after = markup(f);
    expect(after.has("hf-ph")).toBe(false);
    expect(after.has("hf-manual")).toBe(true);

    // Nothing left to do: the next rebuild writes nothing.
    expect((await rebuild(f)).changed).toBe(false);
  });

  it("keeps a template placeholder the user has edited on rebuild", async () => {
    const { f } = await built();
    const html = f.made.read("index.html");
    f.made.write(
      "index.html",
      html.replace(
        /<div id="manual"/,
        `<h1 id="title" data-hf-id="hf-ph" class="clip" data-start="0" data-duration="10" data-track-index="0" data-ov-placeholder="template">My own title</h1><div id="manual"`,
      ),
    );
    const result = await rebuild(f);
    expect(result.warnings.some((warning) => warning.includes("template placeholder"))).toBe(false);
    expect(markup(f).has("hf-ph")).toBe(true);
  });

  it("does not mistake Studio's id stamping of the captions file for an edit, but sees a real one", async () => {
    const { f } = await built();
    const file = "compositions/captions.html";
    // Studio stamps data-hf-id into composition files it opens and re-serializes them.
    const stamped = parseSourceDocument(f.made.read(file));
    let n = 0;
    for (const element of stamped.document.querySelectorAll("div")) {
      element.setAttribute("data-hf-id", `hf-stamp-${n++}`);
    }
    f.made.write(file, serializeModel(stamped));
    let report = await reportOf(f);
    expect(report.state).toBe("in_sync");
    expect(report.captions?.edits).toEqual([]);

    f.made.write(file, f.made.read(file).replace("welcome.", "welcome, friends."));
    report = await reportOf(f);
    expect(report.captions?.edits).toMatchObject([
      { kind: "modified", by: "user", fields: ["text"] },
    ]);
  });

  it("tracks the captions of a story built into another composition, and rebuilds them in place", async () => {
    const scene = "compositions/scene.html";
    const f = createStoryFixture({ html: WITH_TITLE });
    fixture = f;
    f.made.write(scene, WITH_TITLE);
    await referenceStory(f);
    await f.edit([{ op: "set_story", composition: scene }]);
    await f.service.build(f.project, { turnId: "turn-build" });

    const file = captionsFileFor(scene);
    expect(f.made.read(file)).toContain("welcome.");
    let report = await reportOf(f);
    expect(report.state).toBe("in_sync");
    expect(report.captions?.edits).toEqual([]);

    f.made.write(file, f.made.read(file).replace("welcome.", "welcome, friends."));
    report = await reportOf(f);
    expect(report.captions?.edits).toMatchObject([
      { kind: "modified", by: "user", fields: ["text"] },
    ]);

    // A host the user locked is theirs: a full build keeps it and its file instead of replacing them.
    f.made.write(
      scene,
      f.made
        .read(scene)
        .replace('data-track-kind="captions"', 'data-track-kind="captions" data-timeline-locked'),
    );
    await f.service.build(f.project, { turnId: "turn-rebuild" });
    expect(f.made.read(file)).toContain("welcome, friends.");
    const read = await readComposition(f.project, scene, f.made.facts);
    const hosts = read.model.clips.filter((clip) => clip.compositionSrc === file);
    expect(hosts).toHaveLength(1);
  });

  it("tells the user's edits of generated clips from a later AI turn's and a removed clip, and keeps them all", async () => {
    const { f, ids } = await built();
    const [introClip] = sectionClips(f, ids.intro, "a_roll");
    const [cutaway] = sectionClips(f, ids.main, "b_roll");
    const [picture] = sectionClips(f, ids.outro, "picture");
    const [motion] = sectionClips(f, ids.intro, "motion");
    if (!introClip || !cutaway || !picture || !motion) throw new Error("fixture");
    userEditsClip(f, introClip, (element) => element.setAttribute("data-duration", "1.2"));
    userEditsClip(f, cutaway, (element) => element.removeAttribute("muted"));
    userDeletesClip(f, picture);
    await applyEdits(
      {
        project: f.project,
        compositionPath: "index.html",
        adapter: f.made.adapter,
        facts: f.made.facts,
        turnId: "turn-later",
      },
      { operations: [{ op: "move_clip", clip: motion, start: 0.3 }] },
    );

    const report = await reportOf(f);
    const edits = [
      ...report.sections.flatMap((entry) => entry.units.flatMap((unit) => unit.edits)),
    ];
    const byClip = new Map(edits.map((edit) => [edit.clip, edit]));
    expect(byClip.get(introClip)).toMatchObject({
      kind: "modified",
      by: "user",
      fields: ["duration"],
    });
    expect(byClip.get(cutaway)).toMatchObject({ kind: "modified", by: "user", fields: ["muted"] });
    expect(byClip.get(picture)).toMatchObject({ kind: "removed", by: "unknown" });
    expect(byClip.get(motion)).toMatchObject({
      kind: "modified",
      by: "ai",
      turn: "turn-later",
      fields: ["start"],
    });
    expect(report.manualEdits).toBe(4);
    // The graph did not change: no section is out of date. Only the captions follow the trimmed speech, and a
    // rebuild rewrites them without touching any edited clip.
    expect(report.affected).toEqual([]);
    expect(report.captions).toMatchObject({ change: "changed", action: "rebuild" });
    const before = await states(f);
    await rebuild(f);
    const after = await states(f);
    for (const id of [introClip, cutaway, motion]) expect(after.get(id)).toEqual(before.get(id));
    expect(after.has(picture)).toBe(false);
    expect((await reportOf(f)).manualEdits).toBe(4);
  });
});

describe("Rebuild affected section", () => {
  it("rebuilds only the chapter whose source range changed, keeps the other sections and the user's edits in them", async () => {
    const { f, ids } = await built();
    // Manual edits in Intro (a trim) and Outro (the picture deleted) after the build.
    const introClips = sectionClips(f, ids.intro);
    const [introClip] = sectionClips(f, ids.intro, "a_roll");
    const [picture] = sectionClips(f, ids.outro, "picture");
    if (!introClip || !picture) throw new Error("fixture");
    userEditsClip(f, introClip, (element) => element.setAttribute("data-duration", "1.5"));
    userDeletesClip(f, picture);
    const outroClips = sectionClips(f, ids.outro).filter((id) => id !== picture);
    const oldMain = sectionClips(f, ids.main, "a_roll");
    const beforeMarkup = markup(f);
    const before = await states(f);
    const oldMainLength =
      ledgerOf(f).sections.find((entry) => entry.chapter === ids.main)?.length ?? 0;

    // The user shortens Main to its first two words.
    await userSaves(f, (graph) => {
      chapterOf(graph, ids.main).sourceRanges = [
        { source: TALK, from: 2.6, to: 3.35, segment: null },
      ];
    });
    const impact = await reportOf(f);
    expect(impact.state).toBe("out_of_sync");
    expect(impact.affected).toEqual([ids.main]);
    expect(
      section(impact.sections, ids.main).units.find((unit) => unit.role === "a_roll")?.action,
    ).toBe("rebuild");
    expect(section(impact.sections, ids.intro)).toMatchObject({
      change: "unchanged",
      moved: false,
    });
    expect(section(impact.sections, ids.outro)).toMatchObject({ change: "unchanged", moved: true });
    expect(impact.manualEdits).toBe(2);
    expect(impact.conflicts).toBe(0);

    const result = await rebuild(f);
    expect(result).toMatchObject({
      changed: true,
      rebuilt: [ids.main],
      removed: [],
      replacedEdits: [],
    });

    // Intro, before the change, is byte-for-byte what it was — the user's trim included.
    const afterMarkup = markup(f);
    for (const id of introClips) expect(afterMarkup.get(id)).toBe(beforeMarkup.get(id));
    const after = await states(f);
    expect(after.get(introClip)?.duration).toBe(1.5);

    // Main was regenerated from the new range.
    for (const id of oldMain) expect(after.has(id)).toBe(false);
    const newMain = sectionClips(f, ids.main, "a_roll").map((id) => after.get(id));
    const talk = talkAnalysis();
    if (!talk.transcript) throw new Error("fixture");
    const expected = cleanRanges({
      ranges: [{ from: 2.6, to: 3.35, segment: null }],
      transcript: talk.transcript,
      takes: talk.takes,
      silence: talk.silence,
      sourceDuration: 8,
    });
    expect(newMain.map((state) => [state?.mediaStart, state?.duration])).toEqual(
      expected.map((range) => [range.from, Number((range.to - range.from).toFixed(3))]),
    );

    // Outro moved up by exactly what Main lost, clip for clip; its deleted picture stays deleted.
    const newMainLength =
      ledgerOf(f).sections.find((entry) => entry.chapter === ids.main)?.length ?? 0;
    expectShifted(before, after, outroClips, newMainLength - oldMainLength);
    expect(after.has(picture)).toBe(false);
    expect(sectionClips(f, ids.outro, "picture")).toEqual([picture]);

    // The user's own title sits in a later section: it is kept and moves with that section, nothing else changes.
    const title = impact.unrelated.find((clip) => clip.clip === "hf-manual");
    const home = title?.anchor ? section(impact.sections, title.anchor) : null;
    expect(home?.chapter).not.toBe(ids.intro);
    expect(title?.shift).toBeCloseTo((home?.next?.start ?? 0) - (home?.current?.start ?? 0), 3);
    expect(after.get("hf-manual")?.start).toBeCloseTo(4 + (title?.shift ?? 0), 3);
    expect({ ...after.get("hf-manual"), start: 0 }).toEqual({
      ...before.get("hf-manual"),
      start: 0,
    });
    const captions = f.made.read("compositions/captions.html");
    expect(captions).toContain("Today");
    expect(captions).not.toContain("things.");

    // The edits are still known afterwards, and the timeline matches the graph again.
    const later = await reportOf(f);
    expect(later).toMatchObject({ state: "in_sync", manualEdits: 2 });
  });

  it("marks a chapter for rebuild when the picked fragment of its source changes, and rebuilds inside it", async () => {
    const { f, ids } = await built();
    const keptMain = sectionClips(f, ids.main, "a_roll");
    expect(keptMain.length).toBeGreaterThan(0);
    expect((await f.view()).facts[ids.outro]?.materialDuration ?? 0).toBeGreaterThan(0);
    writeAssetRanges(f.project.dir, new Map([[TALK, { start: 0, end: 5 }]]));

    // The impact and the chapter facts are computed from the new pick: the cached in-sync report is not served.
    const impact = await reportOf(f);
    expect(impact.state).toBe("out_of_sync");
    expect(impact.affected).toEqual([ids.outro]); // Outro's g3 (6–7.4 s) is outside 0–5 s; Intro and Main are inside
    expect(impact.warnings.join(" ")).toContain("The user picked 0–5s of assets/a.mp4 for use");
    expect((await f.view()).facts[ids.outro]?.materialDuration).toBe(0);

    const result = await rebuild(f);
    expect(result.changed).toBe(true);
    expect(result.report.affected).toContain(ids.outro);
    expect(sectionClips(f, ids.outro, "a_roll")).toEqual([]);
    for (const id of keptMain) expect(sectionClips(f, ids.main, "a_roll")).toContain(id);
    const { snapshot } = await readComposition(f.project, "index.html", f.made.facts);
    const talkClips = snapshot.clips.filter((clip) => clip.src === TALK);
    expect(talkClips.length).toBeGreaterThan(0);
    for (const clip of talkClips) {
      expect((clip.mediaStart ?? 0) + clip.duration).toBeLessThanOrEqual(5.001);
    }
  });

  it("moves reordered chapters as whole sections without regenerating them", async () => {
    const { f, ids } = await built();
    const ownedBefore = ledgerOf(f).sections.flatMap((entry) =>
      entry.units
        .filter((unit) => unit.role !== "music")
        .flatMap((unit) => unit.entities.map((e) => e.clip)),
    );
    const before = await states(f);
    await userSaves(f, (graph) => {
      graph.edges = graph.edges.filter((edge) => edge.kind !== "sequence");
      const link = (from: string, to: string, id: string) =>
        graph.edges.push({ id, kind: "sequence", from, to, transition: "", createdBy: "user" });
      link(ids.outro, ids.intro, "e-user-1");
      link(ids.intro, ids.main, "e-user-2");
      link(ids.main, ids.card, "e-user-3");
      chapterOf(graph, ids.outro).position = { x: -500, y: 0 };
    });
    const impact = await reportOf(f);
    expect(impact.affected).toEqual([]);
    expect(impact.moved.sort()).toEqual([ids.intro, ids.main, ids.outro].sort());

    const result = await rebuild(f);
    expect(result.rebuilt).toEqual([]);
    const after = await states(f);
    const ledger = ledgerOf(f);
    expect(ledger.sections.map((entry) => entry.chapter)).toEqual([
      ids.outro,
      ids.intro,
      ids.main,
      ids.card,
    ]);
    // Same clips, same media, each section moved as one block.
    for (const entry of ledger.sections) {
      const clips = entry.units.flatMap((unit) => unit.entities.map((e) => e.clip));
      if (clips.length === 0) continue;
      const first = clips[0] ?? "";
      const delta = (after.get(first)?.start ?? 0) - (before.get(first)?.start ?? 0);
      expectShifted(before, after, clips, delta);
    }
    expect(
      new Set(
        ledger.sections.flatMap((entry) =>
          entry.units.flatMap((u) => u.entities.map((e) => e.clip)),
        ),
      ),
    ).toEqual(new Set(ownedBefore));
    const aRoll = [...after.entries()]
      .filter(([, state]) => state.track === 0)
      .sort((a, b) => a[1].start - b[1].start)
      .map(([id]) => id);
    expect(aRoll[0]).toBe(sectionClips(f, ids.outro, "a_roll")[0]);
    expect((await reportOf(f)).state).toBe("in_sync");
  });

  it("resizes a chapter without speech when its length changes and moves what follows", async () => {
    const { f, ids } = await built();
    await userSaves(f, (graph) => {
      // Card goes between Main and Outro, and gets longer.
      graph.edges = graph.edges.filter((edge) => edge.kind !== "sequence");
      graph.edges.push(
        {
          id: "e-u1",
          kind: "sequence",
          from: ids.intro,
          to: ids.main,
          transition: "",
          createdBy: "user",
        },
        {
          id: "e-u2",
          kind: "sequence",
          from: ids.main,
          to: ids.card,
          transition: "",
          createdBy: "user",
        },
        {
          id: "e-u3",
          kind: "sequence",
          from: ids.card,
          to: ids.outro,
          transition: "",
          createdBy: "user",
        },
      );
      chapterOf(graph, ids.card).estimatedDuration = 5;
    });
    const before = await states(f);
    const beforeMarkup = markup(f);
    const outroClips = sectionClips(f, ids.outro).filter((id) => before.has(id));
    const outroStart =
      ledgerOf(f).sections.find((entry) => entry.chapter === ids.outro)?.start ?? 0;
    const cardEnd = ledgerOf(f).sections.find((entry) => entry.chapter === ids.main);
    await rebuild(f);
    const after = await states(f);
    const card = ledgerOf(f).sections.find((entry) => entry.chapter === ids.card);
    expect(card?.length).toBe(5);
    expect(card?.start).toBeCloseTo((cardEnd?.start ?? 0) + (cardEnd?.length ?? 0), 3);
    const outro = ledgerOf(f).sections.find((entry) => entry.chapter === ids.outro);
    expectShifted(before, after, outroClips, (outro?.start ?? 0) - outroStart);
    for (const id of sectionClips(f, ids.intro))
      expect(markup(f).get(id)).toBe(beforeMarkup.get(id));
  });

  it("removes a deleted chapter's section, closes the gap, and keeps the user's edit in it unless told to replace", async () => {
    const { f, ids } = await built();
    const [mainClip] = sectionClips(f, ids.main, "a_roll");
    const [cutaway] = sectionClips(f, ids.main, "b_roll");
    if (!mainClip || !cutaway) throw new Error("fixture");
    userEditsClip(f, cutaway, (element) => element.setAttribute("data-volume", "0.5"));
    const before = await states(f);
    const outroClips = sectionClips(f, ids.outro);
    const mainLength =
      ledgerOf(f).sections.find((entry) => entry.chapter === ids.main)?.length ?? 0;
    await userSaves(f, (graph) => {
      graph.nodes = graph.nodes.filter((node) => node.id !== ids.main);
      graph.edges = graph.edges.filter((edge) => edge.from !== ids.main && edge.to !== ids.main);
      graph.attachments = graph.attachments.filter((item) => item.chapter !== ids.main);
      graph.edges.push({
        id: "e-u1",
        kind: "sequence",
        from: ids.intro,
        to: ids.outro,
        transition: "",
        createdBy: "user",
      });
    });
    const impact = await reportOf(f);
    expect(section(impact.sections, ids.main)).toMatchObject({ change: "removed", next: null });
    expect(impact.conflicts).toBe(1);

    const kept = await rebuild(f);
    expect(kept.removed).toEqual([ids.main]);
    expect(kept.keptEdits.map((edit) => edit.clip)).toEqual([cutaway]);
    const after = await states(f);
    expect(after.has(mainClip)).toBe(false);
    expect(after.has(cutaway)).toBe(true); // edited by the user: kept, detached from the story
    expectShifted(before, after, outroClips, -mainLength);
    expect(ledgerOf(f).sections.map((entry) => entry.chapter)).toEqual([
      ids.intro,
      ids.outro,
      ids.card,
    ]);

    // The kept clip is now the user's own content; a later rebuild leaves it.
    const report = await reportOf(f);
    expect(report.unrelated.some((clip) => clip.clip === cutaway)).toBe(true);
  });

  it("replaces a deleted chapter's edited clip when the user chooses replace", async () => {
    const { f, ids } = await built();
    const [cutaway] = sectionClips(f, ids.main, "b_roll");
    if (!cutaway) throw new Error("fixture");
    userEditsClip(f, cutaway, (element) => element.setAttribute("data-volume", "0.5"));
    await userSaves(f, (graph) => {
      graph.nodes = graph.nodes.filter((node) => node.id !== ids.main);
      graph.edges = graph.edges.filter((edge) => edge.from !== ids.main && edge.to !== ids.main);
      graph.attachments = graph.attachments.filter((item) => item.chapter !== ids.main);
    });
    const result = await rebuild(f, { manualEdits: "replace" });
    expect(result.replacedEdits.map((edit) => edit.clip)).toEqual([cutaway]);
    expect((await states(f)).has(cutaway)).toBe(false);
  });

  it("rebuilds only the attachment, bed or graphic that changed", async () => {
    const { f, ids } = await built();
    const beforeMarkup = markup(f);
    const [cutaway] = sectionClips(f, ids.main, "b_roll");
    const mainAroll = sectionClips(f, ids.main, "a_roll");
    const bed = ledgerOf(f).music[0]?.entities[0]?.clip;
    const [motion] = sectionClips(f, ids.intro, "motion");

    await userSaves(f, (graph) => {
      const attachment = graph.attachments.find((item) => item.node === ids.cut);
      if (attachment) attachment.placement = "start";
    });
    const impact = await reportOf(f);
    const units = section(impact.sections, ids.main).units;
    expect(units.find((unit) => unit.role === "b_roll")).toMatchObject({
      change: "changed",
      action: "rebuild",
    });
    expect(units.find((unit) => unit.role === "a_roll")).toMatchObject({
      change: "unchanged",
      action: "keep",
    });
    await rebuild(f);
    let after = markup(f);
    expect(after.has(cutaway ?? "")).toBe(false);
    for (const id of [...mainAroll, bed ?? "", motion ?? ""])
      expect(after.get(id)).toBe(beforeMarkup.get(id));
    const newCut = sectionClips(f, ids.main, "b_roll")[0] ?? "";
    expect((await states(f)).get(newCut)?.start).toBeCloseTo(
      ledgerOf(f).sections.find((entry) => entry.chapter === ids.main)?.start ?? -1,
      3,
    );

    // Music: only the bed changes.
    const snapshot = markup(f);
    await userSaves(f, (graph) => {
      const node = graph.nodes.find((candidate) => candidate.id === ids.bed);
      if (node?.kind === "music") node.volume = 0.2;
    });
    await rebuild(f);
    after = markup(f);
    expect(after.has(bed ?? "")).toBe(false);
    const changed = [...snapshot.keys()].filter((id) => after.get(id) !== snapshot.get(id));
    expect(changed).toEqual([bed]);

    // Motion: detached graphic is removed, everything else stays.
    const beforeDetach = markup(f);
    await userSaves(f, (graph) => {
      graph.attachments = graph.attachments.filter((item) => item.node !== ids.fx);
    });
    await rebuild(f);
    after = markup(f);
    expect(after.has(motion ?? "")).toBe(false);
    for (const [id, html] of beforeDetach) if (id !== motion) expect(after.get(id)).toBe(html);
  });

  it("never rebuilds a locked chapter without permission", async () => {
    const { f, ids } = await built();
    await userSaves(f, (graph) => {
      const main = chapterOf(graph, ids.main);
      main.locked = true;
      main.sourceRanges = [{ source: TALK, from: 2.6, to: 3.35, segment: null }];
    });
    const impact = await reportOf(f);
    expect(impact.lockedPending).toEqual([ids.main]);
    expect(
      section(impact.sections, ids.main).units.find((unit) => unit.role === "a_roll")?.action,
    ).toBe("keep_locked");
    const html = f.made.read("index.html");
    const refused = await rebuild(f);
    expect(refused).toMatchObject({ changed: false, keptLocked: [ids.main], rebuilt: [] });
    expect(f.made.read("index.html")).toBe(html);

    const allowed = await rebuild(f, { allowLocked: [ids.main] });
    expect(allowed.rebuilt).toEqual([ids.main]);
    expect((await reportOf(f)).state).toBe("in_sync");
  });

  it("keeps edited material the story changed (keep) or replaces it and says so (replace)", async () => {
    const { f, ids } = await built();
    const [mainClip] = sectionClips(f, ids.main, "a_roll");
    if (!mainClip) throw new Error("fixture");
    userEditsClip(f, mainClip, (element) => element.setAttribute("data-duration", "1"));
    await userSaves(f, (graph) => {
      chapterOf(graph, ids.main).sourceRanges = [
        { source: TALK, from: 2.6, to: 3.35, segment: null },
      ];
    });
    const impact = await reportOf(f);
    expect(impact.conflicts).toBe(1);
    expect(
      section(impact.sections, ids.main).units.find((unit) => unit.role === "a_roll"),
    ).toMatchObject({
      action: "keep_edited",
      edits: [{ clip: mainClip, kind: "modified", by: "user", fields: ["duration"] }],
    });

    const kept = await rebuild(f);
    expect(kept.keptEdits.map((edit) => edit.clip)).toEqual([mainClip]);
    expect((await states(f)).get(mainClip)?.duration).toBe(1);
    expect((await reportOf(f)).state).toBe("out_of_sync");

    const replaced = await rebuild(f, { manualEdits: "replace" });
    expect(replaced.replacedEdits.map((edit) => edit.clip)).toEqual([mainClip]);
    expect((await states(f)).has(mainClip)).toBe(false);
    expect((await reportOf(f)).state).toBe("in_sync");
  });

  it("counts a Studio canvas drag, resize and rotation as a manual edit, so Rebuild keeps it", async () => {
    const { f, ids } = await built();
    const [mainClip] = sectionClips(f, ids.main, "a_roll");
    if (!mainClip) throw new Error("fixture");
    expect((await reportOf(f)).state).toBe("in_sync");
    userEditsClip(f, mainClip, (element) => {
      element.setAttribute("data-hf-studio-path-offset", "true");
      element.setAttribute("data-hf-studio-rotation", "true");
      element.setAttribute(
        "style",
        `${element.getAttribute("style") ?? ""}; --hf-studio-offset-x: 40px; --hf-studio-offset-y: -12px; --hf-studio-rotation: 8deg; translate: var(--hf-studio-offset-x) var(--hf-studio-offset-y)`,
      );
    });
    await userSaves(f, (graph) => {
      chapterOf(graph, ids.main).sourceRanges = [
        { source: TALK, from: 2.6, to: 3.35, segment: null },
      ];
    });
    const impact = await reportOf(f);
    expect(impact.conflicts).toBe(1);
    expect(
      section(impact.sections, ids.main).units.find((unit) => unit.role === "a_roll"),
    ).toMatchObject({
      action: "keep_edited",
      edits: [{ clip: mainClip, kind: "modified", by: "user", fields: ["canvas"] }],
    });

    const kept = await rebuild(f);
    expect(kept.keptEdits.map((edit) => edit.clip)).toEqual([mainClip]);
    expect((await states(f)).get(mainClip)?.studio).toMatchObject({
      "--hf-studio-offset-x": "40px",
      "--hf-studio-rotation": "8deg",
    });
  });

  it("refuses to rebuild a story that was never built, and one built before sync tracking", async () => {
    const f = createStoryFixture({ html: WITH_TITLE });
    fixture = f;
    await referenceStory(f);
    const never = await rebuild(f).catch((error: unknown) => error);
    expect(isStoryFailure(never) && never.error.code === "unsupported").toBe(true);
    expect(isStoryFailure(never) && never.error.message).toContain(
      "A full Build Story creates the whole timeline from the graph",
    );
    await f.service.build(f.project, { turnId: "turn-1" });
    // A timeline built before synchronization: story clips, no ledger.
    const ledgerPath = join(f.project.dir, STORY_SYNC_PATH);
    const { rmSync } = await import("node:fs");
    rmSync(ledgerPath);
    expect((await reportOf(f)).state).toBe("untracked");
    const untracked = await rebuild(f).catch((error: unknown) => error);
    expect(isStoryFailure(untracked) && untracked.error.code === "unsupported").toBe(true);
    expect(isStoryFailure(untracked) && untracked.error.message).toContain(
      "Propose it to the user",
    );
    expect(isStoryFailure(untracked) && untracked.error.message).toContain(
      "replaces the manual edits to clips the story generated",
    );
    // A full build takes the timeline over.
    await f.service.build(f.project, { turnId: "turn-2" });
    expect(existsSync(ledgerPath)).toBe(true);
    expect((await reportOf(f)).state).toBe("in_sync");
  });
});

describe("full Build Story after manual edits", () => {
  it("replaces edited generated clips and reports them, but leaves a locked chapter's section as built", async () => {
    const { f, ids } = await built();
    const [introClip] = sectionClips(f, ids.intro, "a_roll");
    if (!introClip) throw new Error("fixture");
    userEditsClip(f, introClip, (element) => element.setAttribute("data-duration", "1.2"));
    await userSaves(f, (graph) => {
      chapterOf(graph, ids.outro).locked = true;
    });
    const outroMarkup = new Map(
      [...markup(f)].filter(([id]) => sectionClips(f, ids.outro).includes(id)),
    );
    const result = await f.service.build(f.project, { turnId: "turn-full" });
    expect(result.replacedEdits.map((edit) => edit.clip)).toEqual([introClip]);
    expect(result.keptLocked).toEqual([ids.outro]);
    const after = markup(f);
    expect(after.has(introClip)).toBe(false);
    for (const [id, html] of outroMarkup) expect(after.get(id)).toBe(html);
    expect(after.get("hf-manual")).toBeDefined();
  });
});

describe("revert", () => {
  it("restores the timeline, the graph's build record and the sync ledger when the rebuild turn is undone", async () => {
    const { f, ids } = await built();
    const engine = await openProjectHistory({
      projectDir: f.project.dir,
      historyRoot: join(f.made.root, "history"),
    });
    history = engine;
    f.made.adapter.history = () => engine;
    await userSaves(f, (graph) => {
      chapterOf(graph, ids.main).sourceRanges = [
        { source: TALK, from: 2.6, to: 3.35, segment: null },
      ];
    });
    await engine.flush();
    const files = [STORY_GRAPH_PATH, STORY_SYNC_PATH, "index.html", "compositions/captions.html"];
    const before = new Map(files.map((path) => [path, f.made.read(path)]));

    const agent: HistoryWho = { kind: "agent", name: "Director" };
    const window = await engine.beginWindow(agent, "Rebuild the affected story sections");
    await rebuild(f);
    const entry = await window.close();
    for (const path of [STORY_GRAPH_PATH, STORY_SYNC_PATH, "index.html"]) {
      expect(f.made.read(path)).not.toBe(before.get(path));
      expect(entry?.files.map((file) => file.path)).toContain(path);
    }
    expect((await engine.undo(entry?.id ?? "", { who: agent, mode: "keep-later-edits" })).ok).toBe(
      true,
    );
    for (const path of files) expect(f.made.read(path)).toBe(before.get(path));
    const report = await reportOf(f);
    expect(report.affected).toEqual([ids.main]);
  });
});

describe("a resolved Missing Asset node", () => {
  it("is built like any material, and a Rebuild after an earlier build adds exactly that unit", async () => {
    const f = createStoryFixture({ html: WITH_TITLE });
    fixture = f;
    const ids = await referenceStory(f);
    const made = await f.edit([
      {
        op: "add_node",
        ref: "gap",
        node: { kind: "missing", title: "Waves", mediaKind: "video", need: "Ocean waves" },
      },
      { op: "attach", node: "@gap", chapter: ids.outro, placement: "start", duration: 0.8 },
    ]);
    const missing = created(made, 0);
    const attachment = created(made, 1);

    const first = await f.service.build(f.project, { turnId: "turn-build" });
    expect(first.warnings.some((warning) => warning.includes("missing Ocean waves"))).toBe(true);
    expect(sectionClips(f, ids.outro, "b_roll")).toEqual([]);
    const beforeMarkup = markup(f);

    const resolved = await f.edit([{ op: "resolve_missing", id: missing, asset: "assets/b.mp4" }], {
      turnId: "turn-resolve",
    });
    const node = resolved.results[0]?.id ?? "";
    const impact = await reportOf(f);
    const outro = section(impact.sections, ids.outro);
    expect(outro.units.filter((unit) => unit.change === "added")).toMatchObject([
      { node, role: "b_roll", action: "add" },
    ]);
    expect(
      impact.sections
        .flatMap((entry) => entry.units)
        .filter((unit) => unit.change !== "unchanged")
        .map((unit) => unit.node),
    ).toEqual([node]);

    await rebuild(f);
    const clips = sectionClips(f, ids.outro, "b_roll");
    expect(clips).toHaveLength(1);
    const placed = (await states(f)).get(clips[0] ?? "");
    expect(placed).toMatchObject({ src: "assets/b.mp4" });
    expect(placed?.duration).toBeCloseTo(0.8, 3);
    // Everything else stays byte for byte.
    const after = markup(f);
    for (const [id, html] of beforeMarkup) expect(after.get(id), id).toBe(html);
    expect(ledgerOf(f).sections.find((entry) => entry.chapter === ids.outro)?.units).toContainEqual(
      expect.objectContaining({ node, role: "b_roll" }),
    );
    expect((await reportOf(f)).state).toBe("in_sync");
    // The attachment is the one the Missing Asset node had.
    expect((await f.graph()).attachments.find((item) => item.id === attachment)?.node).toBe(node);
  });

  it("places a resolved sound effect inside its chapter instead of scoring the chapters as a bed", async () => {
    const f = createStoryFixture({ html: WITH_TITLE });
    fixture = f;
    const ids = await referenceStory(f);
    const made = await f.edit([
      {
        op: "add_node",
        ref: "gap",
        node: { kind: "missing", title: "Ding", mediaKind: "sfx", need: "A bell ding" },
      },
      { op: "attach", node: "@gap", chapter: ids.outro, placement: "end", duration: 1 },
    ]);
    const missing = created(made, 0);
    await f.service.build(f.project, { turnId: "turn-build" });
    const bedsBefore = ledgerOf(f).music;

    const resolved = await f.edit([
      { op: "resolve_missing", id: missing, asset: "assets/music.mp3" },
    ]);
    const node = resolved.results[0]?.id ?? "";
    const outro = section((await reportOf(f)).sections, ids.outro);
    expect(outro.units.filter((unit) => unit.change === "added")).toMatchObject([
      { node, role: "sfx", action: "add" },
    ]);

    await rebuild(f);
    const clips = sectionClips(f, ids.outro, "sfx");
    expect(clips).toHaveLength(1);
    const placed = (await states(f)).get(clips[0] ?? "");
    expect(placed).toMatchObject({ src: "assets/music.mp3", track: 5 });
    expect(placed?.duration).toBeCloseTo(1, 3);
    const built = ledgerOf(f);
    const outroEnd = built.sections.find((entry) => entry.chapter === ids.outro);
    expect(outroEnd).toBeDefined();
    expect((placed?.start ?? 0) + (placed?.duration ?? 0)).toBeCloseTo(
      (outroEnd?.start ?? 0) + (outroEnd?.length ?? 0),
      3,
    );
    // Not a bed: the story's music beds are exactly the ones built before.
    expect(built.music).toEqual(bedsBefore);
    expect((await reportOf(f)).state).toBe("in_sync");
  });
});

describe("clips locked on the timeline", () => {
  const lock = (f: StoryFixture, id: string) =>
    userEditsClip(f, id, (element) => element.setAttribute("data-timeline-locked", ""));

  it("survive Rebuild byte-for-byte, even when their chapter is regenerated and the user's own clip is locked too", async () => {
    const { f, ids } = await built();
    const [cutaway] = sectionClips(f, ids.main, "b_roll");
    if (!cutaway) throw new Error("fixture");
    lock(f, cutaway);
    lock(f, "hf-manual");
    const before = markup(f);
    await userSaves(f, (graph) => {
      chapterOf(graph, ids.main).sourceRanges = [
        { source: TALK, from: 2.6, to: 3.35, segment: null },
      ];
    });
    const impact = await reportOf(f);
    expect(
      section(impact.sections, ids.main).units.find((unit) => unit.role === "b_roll"),
    ).toMatchObject({
      action: "keep_edited",
    });

    const result = await rebuild(f);
    expect(result.rebuilt).toEqual([ids.main]);
    const after = markup(f);
    expect(after.get(cutaway)).toBe(before.get(cutaway));
    expect(after.get("hf-manual")).toBe(before.get("hf-manual"));
    expect(result.warnings.some((warning) => warning.includes("is locked on the timeline"))).toBe(
      true,
    );
  });

  it("survive a full Build Story", async () => {
    const { f, ids } = await built();
    const [introClip] = sectionClips(f, ids.intro, "a_roll");
    const [cutaway] = sectionClips(f, ids.main, "b_roll");
    if (!introClip || !cutaway) throw new Error("fixture");
    lock(f, introClip);
    lock(f, cutaway);
    lock(f, "hf-manual");
    const before = markup(f);
    await f.service.build(f.project, { turnId: "turn-full" });
    const after = markup(f);
    for (const id of [introClip, cutaway, "hf-manual"]) {
      expect(after.get(id), id).toBe(before.get(id));
    }
  });
});
