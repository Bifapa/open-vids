// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_MANIFEST_LIMITS } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { isResearchFailure } from "../research/errors.js";
import { readLedger } from "../research/provenance.js";
import {
  chapter,
  createCrossProjectFixture,
  musicNode,
  provenanceRecord,
  writeLedgerFile,
  writeStory,
  type CrossProjectFixture,
  type TestProject,
} from "./testSupport.js";
import { projectSlug } from "./importFiles.js";
import { CrossProjectService } from "./service.js";

let fixture: CrossProjectFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

/** A link needs a privilege on Windows; there the paths the tests name simply do not exist, which is refused as well. */
function link(target: string, path: string): void {
  if (process.platform !== "win32") symlinkSync(target, path);
}

function setup(options: { capability?: boolean } = {}) {
  const f = createCrossProjectFixture(options);
  fixture = f;
  const service = new CrossProjectService({ adapter: f.adapter, now: () => 1_800_000_000_000 });
  return { f, service };
}

/** An "other" project with one file of every sort, and the traps of each part. */
function richProject(f: CrossProjectFixture): TestProject {
  const other = f.add("abcd1234abcd1234", "Launch Film");
  other.write("renders/final.mp4");
  other.write("renders/music-bed.mp3");
  other.write("assets/music/bed.mp3");
  other.write("assets/sfx/whoosh.mp3");
  other.write("assets/voice.mp3");
  other.write("assets/theme.mp3");
  other.write("assets/hit.mp3");
  other.write("assets/found.mp3");
  other.write("assets/photo.jpg");
  other.write("assets/clip.mp4");
  other.write("notes.txt");
  other.write(".hyperframes/cache/hidden.mp3");
  other.write("node_modules/pkg/vendor.mp4");
  // Windows forbids control characters in file names.
  if (process.platform !== "win32") other.write("assets/music/\u0007bell.mp3");
  writeStory(
    other,
    [
      chapter("c1", "Intro", 0, "Open on the product"),
      chapter("c2", "Demo", 400, "Show the flow"),
      musicNode("m1", "assets/theme.mp3"),
      musicNode("m2", "assets/hit.mp3", true),
    ],
    [
      {
        id: "e1",
        kind: "sequence",
        from: "c1",
        to: "c2",
        transition: "cut",
        createdBy: "user",
      },
    ],
  );
  writeLedgerFile(other, [
    provenanceRecord("assets/found.mp3", { need: "Calm background music for the demo" }),
  ]);
  return other;
}

describe("the parts of another project", () => {
  it("put every media file in exactly one part: renders are never music, music comes from the story, the ledger or the path", async () => {
    const { f, service } = setup();
    richProject(f);
    const manifest = await service.manifest(f.project, "abcd1234abcd1234", ["all"]);
    const partOf = (path: string) => manifest.files.find((file) => file.path === path)?.part;
    expect(partOf("renders/final.mp4")).toBe("renders");
    expect(partOf("renders/music-bed.mp3")).toBe("renders");
    expect(partOf("assets/music/bed.mp3")).toBe("music");
    expect(partOf("assets/theme.mp3")).toBe("music");
    expect(partOf("assets/found.mp3")).toBe("music");
    expect(partOf("assets/sfx/whoosh.mp3")).toBe("audio");
    expect(partOf("assets/voice.mp3")).toBe("audio");
    // A music node that resolved a sound-effect need is an effect.
    expect(partOf("assets/hit.mp3")).toBe("audio");
    expect(partOf("assets/photo.jpg")).toBe("images");
    expect(partOf("assets/clip.mp4")).toBe("video");
    // Not media, hidden or vendored folders, control characters in the name: not offered at all.
    expect(manifest.files.map((file) => file.path)).not.toEqual(
      expect.arrayContaining(["notes.txt"]),
    );
    expect(manifest.files.some((file) => /hidden|vendor|bell|notes/.test(file.path))).toBe(false);
    expect(manifest.files).toHaveLength(10);
  });

  it("classify what an earlier import brought by the file's own name, not by the folder named after its project", async () => {
    const { f, service } = setup();
    const other = f.add("abcd1234abcd1234", "Third");
    other.write("assets/from/music-video/voice.mp3");
    other.write("assets/from/music-video/bgm-loop.mp3");
    other.write("assets/from/sounds-of-rome/bgm-loop.mp3");
    const manifest = await service.manifest(f.project, "abcd1234abcd1234", ["music", "audio"]);
    const partOf = (path: string) => manifest.files.find((file) => file.path === path)?.part;
    expect(partOf("assets/from/music-video/voice.mp3")).toBe("audio");
    expect(partOf("assets/from/music-video/bgm-loop.mp3")).toBe("music");
    expect(partOf("assets/from/sounds-of-rome/bgm-loop.mp3")).toBe("music");
  });

  it("do not offer a link, which could lead anywhere", async () => {
    const { f, service } = setup();
    const other = richProject(f);
    f.outside.write("secret.mp3");
    link(join(f.outside.dir, "secret.mp3"), join(other.dir, "assets/linked.mp3"));
    const manifest = await service.manifest(f.project, "abcd1234abcd1234", ["music", "audio"]);
    expect(manifest.files.some((file) => file.path.includes("linked"))).toBe(false);
  });

  it("are counted by summary without reading the media, with the story's chapters", async () => {
    const { f, service } = setup();
    richProject(f);
    const summary = await service.summary(f.project, "abcd1234abcd1234");
    expect(summary).toEqual({
      key: "abcd1234abcd1234",
      name: "Launch Film",
      counts: { renders: 2, music: 3, audio: 3, images: 1, video: 1, story: 2 },
    });
  });

  it("read a damaged story as no story", async () => {
    const { f, service } = setup();
    const other = richProject(f);
    other.write(".hyperframes/story/graph.json", "{ not json");
    const summary = await service.summary(f.project, "abcd1234abcd1234");
    expect(summary.counts.story).toBe(0);
    expect((await service.manifest(f.project, "abcd1234abcd1234", ["story"])).story).toBeNull();
  });
});

describe("the manifest", () => {
  it("lists the named parts only, with licenses, and the story synopsis when asked", async () => {
    const { f, service } = setup();
    richProject(f);
    const music = await service.manifest(f.project, "abcd1234abcd1234", ["music"]);
    expect(music.parts).toEqual(["music"]);
    expect(music.files.map((file) => file.path)).toEqual([
      "assets/found.mp3",
      "assets/music/bed.mp3",
      "assets/theme.mp3",
    ]);
    expect(music.files[0]?.license).toBe("CC BY 4.0");
    expect(music.story).toBeNull();
    expect(music.truncated).toBe(false);

    const story = await service.manifest(f.project, "abcd1234abcd1234", ["story"]);
    expect(story.files).toEqual([]);
    expect(story.story).toContain("Launch film");
    expect(story.story?.indexOf("1. Intro")).toBeLessThan(story.story?.indexOf("2. Demo") ?? 0);
    expect(story.story).toContain("Show the flow");
  });

  it("is bounded: files are cut at the limit and say so, the story at its characters", async () => {
    const { f, service } = setup();
    const other = f.add("bigbigbigbigbig1", "Big");
    for (let index = 0; index < PROJECT_MANIFEST_LIMITS.files + 5; index += 1) {
      other.write(`assets/p${String(index).padStart(3, "0")}.jpg`);
    }
    writeStory(
      other,
      Array.from({ length: 120 }, (_, index) =>
        chapter(`c${index}`, `Chapter ${index}`, index * 10, "x".repeat(200)),
      ),
    );
    const manifest = await service.manifest(f.project, "bigbigbigbigbig1", ["images", "story"]);
    expect(manifest.files).toHaveLength(PROJECT_MANIFEST_LIMITS.files);
    expect(manifest.truncated).toBe(true);
    expect(manifest.story?.length).toBeLessThanOrEqual(PROJECT_MANIFEST_LIMITS.storyChars);
    expect(manifest.story?.endsWith("…")).toBe(true);
  });
});

describe("which projects can be reached", () => {
  it("lists the other projects, never the open one, and nothing without a host list", async () => {
    const { f, service } = setup();
    f.add("aaaa1111aaaa1111", "Alpha");
    const list = await service.list(f.project);
    expect(list.projects.map((entry) => entry.name)).toEqual(["Alpha"]);

    const bare = setup({ capability: false });
    expect(await bare.service.list(bare.f.project)).toEqual({ projects: [] });
    await expect(bare.service.summary(bare.f.project, "aaaa1111aaaa1111")).rejects.toMatchObject({
      error: { code: "unknown_project" },
    });
  });

  it("lists from the folders the host sends with the list, without a resolve per project", async () => {
    const { f } = setup();
    const alpha = f.add("aaaa1111aaaa1111", "Alpha");
    let resolves = 0;
    const service = new CrossProjectService({
      adapter: {
        externalProjects: {
          list: async () => [
            { key: "aaaa1111aaaa1111", name: "Alpha", openedAt: 7, dir: alpha.dir },
            { key: "ownkey0000000000", name: "Open project", dir: f.own.dir },
            { key: "gone1111gone1111", name: "Gone", dir: join(f.outside.dir, "missing") },
          ],
          resolve: async () => {
            resolves += 1;
            return null;
          },
        },
      },
    });
    expect((await service.list(f.project)).projects).toEqual([
      { key: "aaaa1111aaaa1111", name: "Alpha", openedAt: 7 },
    ]);
    expect(resolves).toBe(0);
  });

  it("refuse a key the host does not know and the open project itself", async () => {
    const { f, service } = setup();
    for (const key of ["nosuchkey", "ownkey0000000000", "", "x".repeat(65)]) {
      const refused = await service
        .manifest(f.project, key, ["all"])
        .catch((error: unknown) => error);
      expect(isResearchFailure(refused) && refused.error.code).toBe("unknown_project");
    }
  });
});

describe("importing files of another project", () => {
  const KEY = "abcd1234abcd1234";

  it("copies into assets/from/<project>/ and carries the provenance with importedFrom", async () => {
    const { f, service } = setup();
    const other = richProject(f);
    other.write("assets/music/bed.mp3", "bed-bytes");
    const result = await service.import(f.project, {
      projectKey: KEY,
      files: ["assets/found.mp3", "assets/music/bed.mp3"],
      turnId: "turn-9",
      agent: "editor",
    });
    expect(result.skipped).toEqual([]);
    const [found, bed] = result.imported;
    expect(found).toMatchObject({
      source: "assets/found.mp3",
      asset: "assets/from/launch-film/found.mp3",
      status: "copied",
    });
    expect(bed).toMatchObject({
      asset: "assets/from/launch-film/bed.mp3",
      status: "copied",
      provenance: null,
    });
    expect(readFileSync(join(f.own.dir, bed?.asset ?? ""), "utf-8")).toBe("bed-bytes");

    const ledger = readLedger(f.own.dir);
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({
      asset: "assets/from/launch-film/found.mp3",
      license: "CC BY 4.0",
      attribution: "“A track” by Jane Doe, CC BY 4.0, via Openverse",
      importedFrom: { project: "Launch Film", asset: "assets/found.mp3" },
      retrievedBy: { agent: "editor", turnId: "turn-9" },
    });
    expect(found?.provenance).toEqual(ledger.records[0]);
    // Copying leaves the source alone and no scratch behind.
    expect(existsSync(join(other.dir, "assets/found.mp3"))).toBe(true);
    expect(readdirSync(join(f.own.dir, ".hyperframes/research/cache/tmp"))).toEqual([]);
  });

  it("adds nothing for bytes the project already has, wherever it keeps them", async () => {
    const { f, service } = setup();
    const other = f.add(KEY, "Launch Film");
    other.write("assets/a.mp3", "same");
    other.write("assets/b.mp3", "same");
    other.write("assets/c.mp3", "other");
    f.own.write("sounds/mine.mp3", "other");
    const first = await service.import(f.project, {
      projectKey: KEY,
      files: ["assets/a.mp3", "assets/b.mp3", "assets/c.mp3"],
    });
    expect(first.imported.map((file) => [file.status, file.asset])).toEqual([
      ["copied", "assets/from/launch-film/a.mp3"],
      ["existing", "assets/from/launch-film/a.mp3"],
      ["existing", "sounds/mine.mp3"],
    ]);
    const again = await service.import(f.project, { projectKey: KEY, files: ["assets/a.mp3"] });
    expect(again.imported[0]).toMatchObject({
      status: "existing",
      asset: "assets/from/launch-film/a.mp3",
    });
    expect(readdirSync(join(f.own.dir, "assets/from/launch-film"))).toEqual(["a.mp3"]);
  });

  it("gives the source's license record to bytes the project holds without one", async () => {
    const { f, service } = setup();
    const other = f.add(KEY, "Launch Film");
    other.write("assets/clip.mp3", "same-bytes");
    writeLedgerFile(other, [provenanceRecord("assets/clip.mp3")]);
    f.own.write("sounds/dragged-in.mp3", "same-bytes");

    const first = await service.import(f.project, { projectKey: KEY, files: ["assets/clip.mp3"] });
    expect(first.imported[0]).toMatchObject({
      status: "existing",
      asset: "sounds/dragged-in.mp3",
      provenance: {
        asset: "sounds/dragged-in.mp3",
        license: "CC BY 4.0",
        importedFrom: { project: "Launch Film", asset: "assets/clip.mp3" },
      },
    });
    const ledger = readLedger(f.own.dir);
    expect(ledger.records.map((record) => record.asset)).toEqual(["sounds/dragged-in.mp3"]);
    expect(existsSync(join(f.own.dir, "assets/from"))).toBe(false);

    // A second import finds the record already there and adds nothing.
    const again = await service.import(f.project, { projectKey: KEY, files: ["assets/clip.mp3"] });
    expect(again.imported[0]?.provenance).toEqual(ledger.records[0]);
    expect(readLedger(f.own.dir).records).toHaveLength(1);
  });

  it("keeps the record when two files of one call hold the same bytes, whichever has it", async () => {
    const { f, service } = setup();
    const other = f.add(KEY, "Launch Film");
    other.write("assets/a.mp3", "same");
    other.write("assets/b.mp3", "same");
    other.write("assets/c.mp3", "other");
    other.write("assets/d.mp3", "other");
    writeLedgerFile(other, [provenanceRecord("assets/b.mp3"), provenanceRecord("assets/c.mp3")]);
    const result = await service.import(f.project, {
      projectKey: KEY,
      files: ["assets/a.mp3", "assets/b.mp3", "assets/c.mp3", "assets/d.mp3"],
    });
    const [a, b, c, d] = result.imported;
    // a has no record, its duplicate b has one: the file gets b's. c has one, its duplicate d none: c's stays.
    expect(a?.provenance).toMatchObject({
      asset: "assets/from/launch-film/a.mp3",
      importedFrom: { asset: "assets/b.mp3" },
    });
    expect(b?.provenance).toEqual(a?.provenance);
    expect(c?.provenance).toMatchObject({ importedFrom: { asset: "assets/c.mp3" } });
    expect(d?.provenance).toEqual(c?.provenance);
    expect(readLedger(f.own.dir).records).toHaveLength(2);
  });

  it("puts a name without Latin letters in a folder of its own, spelled like the # token", async () => {
    expect(projectSlug("My Video #2")).toBe("my-video-2");
    expect(projectSlug("Мой проект")).toBe("мой-проект");
    expect(projectSlug("Отпуск")).not.toBe(projectSlug("Свадьба"));
    expect(projectSlug("🎬")).toBe("project");
    expect(projectSlug("a".repeat(80))).toHaveLength(48);

    const { f, service } = setup();
    const holiday = f.add(KEY, "Отпуск 2024");
    holiday.write("assets/song.mp3", "song");
    const wedding = f.add("beef1234beef1234", "Свадьба");
    wedding.write("assets/song.mp3", "other-song");
    const one = await service.import(f.project, { projectKey: KEY, files: ["assets/song.mp3"] });
    const two = await service.import(f.project, {
      projectKey: "beef1234beef1234",
      files: ["assets/song.mp3"],
    });
    expect(one.imported[0]?.asset).toBe("assets/from/отпуск-2024/song.mp3");
    expect(two.imported[0]?.asset).toBe("assets/from/свадьба/song.mp3");
  });

  it("never overwrites: a different file under the same name gets a hash suffix", async () => {
    const { f, service } = setup();
    const other = f.add(KEY, "Launch Film");
    other.write("a/take.mp3", "one");
    other.write("b/take.mp3", "two");
    f.own.write("assets/from/launch-film/take.mp3", "mine");
    const result = await service.import(f.project, {
      projectKey: KEY,
      files: ["a/take.mp3", "b/take.mp3"],
    });
    const assets = result.imported.map((file) => file.asset);
    expect(new Set(assets).size).toBe(2);
    expect(assets.every((asset) => asset !== "assets/from/launch-film/take.mp3")).toBe(true);
    expect(readFileSync(join(f.own.dir, "assets/from/launch-film/take.mp3"), "utf-8")).toBe("mine");
    expect(readdirSync(join(f.own.dir, "assets/from/launch-film"))).toHaveLength(3);
  });

  it("refuses what the project does not offer: traversal, absolute paths, hidden folders, links, non-media", async () => {
    const { f, service } = setup();
    const other = richProject(f);
    f.outside.write("secret.mp3", "secret");
    link(join(f.outside.dir, "secret.mp3"), join(other.dir, "assets/linked.mp3"));
    const files = [
      "../outside/secret.mp3",
      join(f.outside.dir, "secret.mp3"),
      ".hyperframes/cache/hidden.mp3",
      "assets/linked.mp3",
      "notes.txt",
      "assets/missing.mp3",
    ];
    const result = await service.import(f.project, { projectKey: KEY, files });
    expect(result.imported).toEqual([]);
    expect(result.skipped.map((entry) => entry.source)).toEqual(files);
    expect(existsSync(join(f.own.dir, "assets/from"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a destination that leads out of the project through a link",
    async () => {
      const { f, service } = setup();
      const other = f.add(KEY, "Launch Film");
      other.write("a.mp3", "bytes");
      mkdirSync(join(f.own.dir, "assets"), { recursive: true });
      symlinkSync(f.outside.dir, join(f.own.dir, "assets/from"));
      const result = await service.import(f.project, { projectKey: KEY, files: ["a.mp3"] });
      expect(result.imported).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(readdirSync(f.outside.dir)).toEqual([]);
    },
  );

  it("is cancelled before the commit with nothing written, and answers finished after", async () => {
    const { f, service } = setup();
    const other = f.add(KEY, "Launch Film");
    other.write("a.mp3", "bytes");

    expect(service.cancel(f.project, "r-early")).toBe("cancelled");
    await expect(
      service.import(f.project, { projectKey: KEY, files: ["a.mp3"], requestId: "r-early" }),
    ).rejects.toMatchObject({ error: { code: "cancelled" } });

    const gone = new AbortController();
    gone.abort();
    await expect(
      service.import(f.project, { projectKey: KEY, files: ["a.mp3"] }, gone.signal),
    ).rejects.toMatchObject({ error: { code: "cancelled" } });
    expect(existsSync(join(f.own.dir, "assets/from"))).toBe(false);
    expect(existsSync(join(f.own.dir, ".hyperframes/research/provenance.json"))).toBe(false);

    const done = await service.import(f.project, {
      projectKey: KEY,
      files: ["a.mp3"],
      requestId: "r-1",
    });
    expect(done.imported).toHaveLength(1);
    expect(service.cancel(f.project, "r-1")).toBe("finished");
    expect(existsSync(join(f.own.dir, "assets/from/launch-film/a.mp3"))).toBe(true);
  });

  it("refuses an unknown project and keeps the ledger of a damaged one readable", async () => {
    const { f, service } = setup();
    await expect(
      service.import(f.project, { projectKey: "nosuchkey", files: ["a.mp3"] }),
    ).rejects.toMatchObject({ error: { code: "unknown_project" } });

    const other = f.add(KEY, "Launch Film");
    other.write("a.mp3", "bytes");
    other.write(".hyperframes/research/provenance.json", "{ damaged");
    const result = await service.import(f.project, { projectKey: KEY, files: ["a.mp3"] });
    expect(result.imported[0]?.provenance).toBeNull();
    // Another project's damaged ledger is read, never "repaired" with a backup file.
    expect(existsSync(join(other.dir, ".hyperframes/research/provenance.json.bak"))).toBe(false);
  });
});
