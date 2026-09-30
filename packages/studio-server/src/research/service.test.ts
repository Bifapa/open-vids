// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROVENANCE_PATH,
  type AssetProvenance,
  type StoryGraph,
} from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryWho } from "../history/historyLog.js";
import { openProjectHistory, type ProjectHistory } from "../history/projectHistory.js";
import { BLANK_HTML, created } from "../story/testSupport.js";
import { isResearchFailure } from "./errors.js";
import { readLedger } from "./provenance.js";
import {
  createResearchFixture,
  fixtureText,
  html,
  json,
  media,
  redirect,
  type ResearchFixture,
} from "./testSupport.js";

let fixture: ResearchFixture | undefined;
let history: ProjectHistory | undefined;
afterEach(async () => {
  await history?.close();
  fixture?.cleanup();
  fixture = undefined;
  history = undefined;
});

function setup(options: Parameters<typeof createResearchFixture>[0] = {}): ResearchFixture {
  fixture = createResearchFixture(options);
  return fixture;
}

const OCEAN = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Ocean_waves.mp4";
const serve = (f: ResearchFixture, url: string, body: string, type = "video/mp4") =>
  f.net.when(url, media(body, type));
const importUrl = (f: ResearchFixture, url: string, extra: object = {}) =>
  f.service.import(f.project, { url, ...extra });

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (isResearchFailure(error)) return error.error;
    throw error;
  }
  throw new Error("expected a research failure");
}

const agent: HistoryWho = { kind: "agent", name: "Research" };

/** A composition whose timeline plays `asset`. */
function compose(f: ResearchFixture, asset: string): void {
  f.story.made.write(
    "index.html",
    BLANK_HTML.replace(
      `data-duration="0"></div>`,
      `data-duration="3"><video id="v" data-hf-id="hf-v" class="clip" src="${asset}" data-start="0" data-duration="3" data-track-index="0" muted playsinline></video></div>`,
    ),
  );
}

describe("search", () => {
  it("in trusted mode searches the enabled sources only, reports a failing source instead of failing, and never leaves the trusted hosts", async () => {
    const f = setup();
    f.net.when(
      (url) => url.hostname === "commons.wikimedia.org",
      json(JSON.parse(fixtureText("commons-picture.json"))),
    );
    f.net.when(
      (url) => url.hostname === "api.openverse.org",
      json(JSON.parse(fixtureText("openverse-images.json"))),
    );
    f.store.updateSource("internet-archive", { enabled: false });

    const result = await f.service.search(f.project, {
      query: "volcano",
      mediaKind: "picture",
      limit: 3,
    });
    expect(result.mode).toBe("trusted");
    expect(result.searched.map((entry) => [entry.source.id, entry.error === null])).toEqual([
      ["wikimedia-commons", true],
      ["openverse", true],
      ["nasa-images", false],
    ]);
    expect(result.searched[2]?.error).toContain("images-api.nasa.gov");
    expect(result.candidates.length).toBeGreaterThan(2);
    expect(
      result.candidates.every(
        (candidate) => candidate.id.startsWith("cand-") && candidate.source.trusted,
      ),
    ).toBe(true);
    // Every request went to a trusted host; the disabled source and the web were never touched.
    const trusted = ["commons.wikimedia.org", "api.openverse.org", "images-api.nasa.gov"];
    expect(f.net.hosts().every((host) => trusted.includes(host))).toBe(true);
    expect(f.web.queries).toEqual([]);
    // Licenses come from the source's API.
    const flickr = result.candidates.find((candidate) =>
      candidate.mediaUrl.includes("staticflickr"),
    );
    expect(flickr?.license).toMatchObject({
      id: "cc_by",
      confidence: "high",
      status: "attribution",
    });
  });

  it("lists requested sources the policy forbids under `blocked` and never runs the web in trusted mode", async () => {
    const f = setup();
    f.store.updateSource("openverse", { enabled: false });
    const result = await f.service.search(f.project, {
      query: "volcano",
      mediaKind: "picture",
      sources: ["web", "openverse", "src-unknown"],
    });
    expect(result.candidates).toEqual([]);
    expect(result.blocked.map((entry) => entry.source)).toEqual([
      "web",
      "openverse",
      "src-unknown",
    ]);
    expect(result.blocked[0]?.reason).toContain("trusted mode");
    expect(f.web.queries).toEqual([]);
    expect(f.net.calls).toEqual([]);
  });

  it("in any mode also searches the web: trusted sources first, web results marked untrusted", async () => {
    const f = setup({
      mode: "any",
      hits: [{ url: "https://photos.example.org/cats", title: "Cats", snippet: "" }],
    });
    f.net.when(
      (url) => url.hostname === "commons.wikimedia.org",
      json(JSON.parse(fixtureText("commons-picture.json"))),
    );
    f.net.when("https://photos.example.org/cats", html(fixtureText("page-photos.html")));
    f.net.when(
      (url) => url.hostname !== "photos.example.org" && url.hostname !== "commons.wikimedia.org",
      json({}, 503),
    );
    const result = await f.service.search(f.project, {
      query: "cats",
      mediaKind: "picture",
      sources: ["wikimedia-commons", "web"],
    });
    const sources = result.candidates.map((candidate) => candidate.source.id);
    expect(sources[0]).toBe("wikimedia-commons");
    expect(sources.at(-1)).toBe("web");
    const web = result.candidates.filter((candidate) => candidate.source.id === "web");
    expect(web.length).toBeGreaterThan(0);
    expect(
      web.every((candidate) => !candidate.source.trusted && candidate.license.status === "unknown"),
    ).toBe(true);
    expect(f.web.queries).toEqual(["cats photo"]);
  });

  it("marks a candidate already in the project", async () => {
    const f = setup();
    f.net.when(
      (url) => url.hostname === "commons.wikimedia.org",
      json(JSON.parse(fixtureText("commons-picture.json"))),
    );
    const first = await f.service.search(f.project, {
      query: "volcano",
      mediaKind: "picture",
      sources: ["wikimedia-commons"],
    });
    const candidate = first.candidates[0];
    if (!candidate) throw new Error("no candidate");
    serve(f, candidate.mediaUrl, "JPEG picture bytes", "image/jpeg");
    const imported = await f.service.import(f.project, { candidate: candidate.id });
    const again = await f.service.search(f.project, {
      query: "volcano",
      mediaKind: "picture",
      sources: ["wikimedia-commons"],
    });
    expect(again.candidates[0]?.inProject).toBe(imported.asset);
    expect(again.candidates[1]?.inProject).toBeNull();
  });
});

describe("inspect and import: the policy", () => {
  it("refuses, before any request, a page and a media URL outside the trusted sources in trusted mode", async () => {
    const f = setup();
    f.net.when(() => true, html("<title>x</title>"));
    const inspect = await failure(
      f.service.inspect(f.project, { url: "https://example.com/video" }),
    );
    expect(inspect.code).toBe("blocked_by_policy");
    expect(inspect.message).toContain("example.com");
    expect((await failure(importUrl(f, "https://example.com/clip.mp4"))).code).toBe(
      "blocked_by_policy",
    );
    expect(f.net.calls).toEqual([]);
    expect(f.researchFiles()).toEqual([]);
  });

  it("stops an import whose trusted URL redirects to a host that is not trusted", async () => {
    const f = setup();
    f.net.when(OCEAN, redirect("https://cdn.stock.example/ocean.mp4"));
    f.net.when("https://cdn.stock.example/ocean.mp4", media("H264 x", "video/mp4"));
    const refusal = await failure(importUrl(f, OCEAN));
    expect(refusal.code).toBe("blocked_by_policy");
    expect(refusal.message).toContain("cdn.stock.example");
    expect(f.net.calls).toEqual([OCEAN]);
    expect(f.researchFiles()).toEqual([]);
  });

  it("downloads a candidate from the exact host its source granted (Openverse → Flickr) and nowhere else", async () => {
    const f = setup();
    f.net.when(
      (url) => url.hostname === "api.openverse.org",
      json(JSON.parse(fixtureText("openverse-images.json"))),
    );
    const found = await f.service.search(f.project, {
      query: "volcano",
      mediaKind: "picture",
      sources: ["openverse"],
    });
    const flickr = found.candidates.find((candidate) =>
      candidate.mediaUrl.startsWith("https://live.staticflickr.com/"),
    );
    if (!flickr) throw new Error("no flickr candidate");
    serve(f, flickr.mediaUrl, "JPEG flickr", "image/jpeg");
    const done = await f.service.import(f.project, { candidate: flickr.id });
    expect(done.provenance).toMatchObject({
      source: { id: "openverse", trusted: true },
      licenseId: "cc_by",
      licenseConfidence: "high",
    });
    // The grant does not open the host to a URL import in trusted mode.
    const direct = await failure(importUrl(f, "https://live.staticflickr.com/9/other.jpg"));
    expect(direct.code).toBe("blocked_by_policy");
    // …nor once the issuing source is disabled.
    f.store.updateSource("openverse", { enabled: false });
    const other = found.candidates.find((candidate) => candidate.mediaUrl.includes("6785906060"));
    if (!other) throw new Error("no second flickr candidate");
    serve(f, other.mediaUrl, "JPEG second", "image/jpeg");
    expect((await failure(f.service.import(f.project, { candidate: other.id }))).code).toBe(
      "blocked_by_policy",
    );
  });

  it("lets any mode import from any public host, recording the web as an untrusted source", async () => {
    const f = setup({ mode: "any" });
    serve(f, "https://stock.example.com/clips/harbor.mp4", "H264 harbor");
    const done = await importUrl(f, "https://stock.example.com/clips/harbor.mp4");
    expect(done.provenance).toMatchObject({
      source: { id: "web", trusted: false },
      policyMode: "any",
      licenseStatus: "unknown",
      licenseConfidence: "none",
    });
  });

  it("never reaches the private network, in either mode, even through a public-looking URL", async () => {
    for (const mode of ["trusted", "any"] as const) {
      const f = setup({ mode, dns: { "stock.example.com": "10.0.0.7" } });
      f.net.when(() => true, media("H264", "video/mp4"));
      for (const url of [
        "http://127.0.0.1/a.mp4",
        "http://169.254.169.254/latest",
        "https://stock.example.com/a.mp4",
      ]) {
        expect((await failure(importUrl(f, url))).code, `${mode} ${url}`).toBe("blocked_by_policy");
      }
      expect(f.net.calls).toEqual([]);
      f.cleanup();
    }
  });

  it("reports a broken URL as unavailable and writes nothing", async () => {
    const f = setup({ mode: "any" });
    f.net.when("https://stock.example.com/old.mp4", () => new Response("", { status: 410 }));
    f.net.when("https://stock.example.com/old.mp4", () => new Response("", { status: 404 }));
    expect((await failure(importUrl(f, "https://stock.example.com/old.mp4"))).code).toBe(
      "unavailable",
    );
    expect(f.researchFiles()).toEqual([]);
    expect(readLedger(f.project.dir).records).toEqual([]);
  });

  it("refuses unknown candidates, pages without media, streams and non-media answers", async () => {
    const f = setup({ mode: "any" });
    expect((await failure(f.service.import(f.project, { candidate: "cand-nope" }))).code).toBe(
      "unknown_candidate",
    );
    f.net.when("https://stock.example.com/empty", html("<title>No media</title><p>text</p>"));
    expect((await failure(importUrl(f, "https://stock.example.com/empty"))).code).toBe("not_media");
    f.net.when(
      "https://stock.example.com/live.m3u8",
      media("#EXTM3U", "application/vnd.apple.mpegurl"),
    );
    expect((await failure(importUrl(f, "https://stock.example.com/live.m3u8"))).code).toBe(
      "unsupported",
    );
    // A video URL that really is a picture.
    serve(f, "https://stock.example.com/fake.mp4", "JPEG not a video", "video/mp4");
    expect((await failure(importUrl(f, "https://stock.example.com/fake.mp4"))).code).toBe(
      "not_media",
    );
    expect(f.researchFiles()).toEqual([]);
    expect(readLedger(f.project.dir).records).toEqual([]);
  });
});

describe("import: the file and its provenance", () => {
  it("writes a normalized asset under assets/research with a provenance record that came from the source, not the caller", async () => {
    const f = setup();
    serve(f, OCEAN, "H264 ocean waves");
    const done = await importUrl(f, OCEAN, {
      agent: "research",
      turnId: "turn-9",
      model: "anthropic/haiku",
    });
    expect(done.fetch).toBe("network");
    expect(done.asset).toMatch(/^assets\/research\/ocean-waves-[0-9a-f]{8}\.mp4$/);
    expect(f.read(done.asset)).toBe("H264 ocean waves");
    expect(done.provenance).toMatchObject({
      asset: done.asset,
      mediaKind: "video",
      originalUrl: OCEAN,
      source: { id: "wikimedia-commons", name: "Wikimedia Commons", trusted: true },
      licenseId: "unknown",
      licenseStatus: "unknown",
      licenseConfidence: "none",
      policyMode: "trusted",
      converted: null,
      contentType: "video/mp4",
      retrievedBy: { agent: "research", turnId: "turn-9", model: "anthropic/haiku" },
    });
    expect(done.provenance.attribution).toBe(
      "“Ocean waves”, license unknown, via Wikimedia Commons",
    );
    expect(done.provenance.sha256).toBe(done.provenance.originalSha256);
    // The ledger on disk holds the same record, and reading it back round-trips.
    const ledger = JSON.parse(readFileSync(join(f.project.dir, PROVENANCE_PATH), "utf-8"));
    expect(ledger.records).toEqual([done.provenance]);
    expect(readLedger(f.project.dir).records).toEqual([done.provenance]);
  });

  it("converts what the editor cannot use and says how", async () => {
    const f = setup();
    serve(f, "https://upload.wikimedia.org/a/clip.webm", "VP9 webm clip", "video/webm");
    const video = await importUrl(f, "https://upload.wikimedia.org/a/clip.webm");
    expect(video.asset).toMatch(/\.mp4$/);
    expect(f.read(video.asset)).toBe("CONVERTED-video:VP9 webm clip");
    expect(video.provenance.converted).toBe("VP9/MATROSKA → H.264/AAC MP4");
    expect(video.provenance.sha256).not.toBe(video.provenance.originalSha256);

    serve(f, "https://upload.wikimedia.org/a/scan.tif", "TIFF scan", "image/tiff");
    const picture = await importUrl(f, "https://upload.wikimedia.org/a/scan.tif");
    expect(picture.asset).toMatch(/\.png$/);
    expect(picture.provenance.converted).toBe("tiff → PNG");

    serve(f, "https://upload.wikimedia.org/a/song.ogg", "OGG song", "audio/ogg");
    const audio = await importUrl(f, "https://upload.wikimedia.org/a/song.ogg");
    expect(audio.asset).toMatch(/\.m4a$/);

    // Already editor-ready files are kept byte for byte.
    serve(f, "https://upload.wikimedia.org/a/song.mp3", "MP3 song", "audio/mpeg");
    const kept = await importUrl(f, "https://upload.wikimedia.org/a/song.mp3");
    expect(kept.provenance.converted).toBeNull();
    expect(f.read(kept.asset)).toBe("MP3 song");
    expect(f.toolkit.converted).toEqual(["video", "picture", "audio"]);
  });

  it("refuses a video longer than twenty minutes and leaves no trace", async () => {
    const f = setup();
    serve(f, "https://upload.wikimedia.org/a/film.mp4", "LONGH264 a whole film");
    expect((await failure(importUrl(f, "https://upload.wikimedia.org/a/film.mp4"))).code).toBe(
      "too_large",
    );
    expect(f.researchFiles()).toEqual([]);
    expect(existsSync(join(f.project.dir, PROVENANCE_PATH))).toBe(false);
  });

  it("does not commit anything for a request whose client is gone", async () => {
    const f = setup();
    serve(f, OCEAN, "H264 ocean waves");
    const stop = new AbortController();
    f.net.when(OCEAN, () => {
      stop.abort();
      return new Response("H264 ocean waves", {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    });
    await failure(f.service.import(f.project, { url: OCEAN }, stop.signal));
    expect(f.researchFiles()).toEqual([]);
    expect(existsSync(join(f.project.dir, PROVENANCE_PATH))).toBe(false);
  });
});

describe("import: duplicates", () => {
  it("recognizes the same URL before any request, and the same bytes under another URL without a second file", async () => {
    const f = setup();
    serve(f, OCEAN, "H264 ocean waves");
    const first = await importUrl(f, OCEAN);
    const requests = f.net.calls.length;

    const sameUrl = await importUrl(f, OCEAN);
    expect(sameUrl).toMatchObject({
      asset: first.asset,
      fetch: "none",
      duplicate: { asset: first.asset, reason: "same_url" },
    });
    expect(f.net.calls.length).toBe(requests);

    serve(f, "https://upload.wikimedia.org/mirror/waves.mp4", "H264 ocean waves");
    const sameContent = await importUrl(f, "https://upload.wikimedia.org/mirror/waves.mp4");
    expect(sameContent.duplicate).toEqual({ asset: first.asset, reason: "same_content" });
    expect(sameContent.provenance.id).toBe(first.provenance.id);
    expect(f.researchFiles()).toHaveLength(1);
    expect(readLedger(f.project.dir).records).toHaveLength(1);
  });

  it("does not add a file the user already has: no new file, no record, a warning", async () => {
    const f = setup();
    f.story.made.write("assets/mine.mp4", "H264 my own footage");
    serve(f, OCEAN, "H264 my own footage");
    const done = await importUrl(f, OCEAN);
    expect(done.asset).toBe("assets/mine.mp4");
    expect(done.duplicate).toEqual({ asset: "assets/mine.mp4", reason: "same_content" });
    expect(done.warnings.join(" ")).toContain("assets/mine.mp4");
    expect(f.researchFiles()).toEqual([]);
    expect(readLedger(f.project.dir).records).toEqual([]);
  });

  it("uses the download cache instead of the network when an import is repeated after the file is gone", async () => {
    const f = setup();
    serve(f, OCEAN, "H264 ocean waves");
    const first = await importUrl(f, OCEAN);
    expect(f.net.calls.filter((url) => url === OCEAN)).toHaveLength(2); // the probe and the download
    rmSync(join(f.project.dir, first.asset));
    const before = f.net.calls.length;

    const again = await importUrl(f, OCEAN);
    expect(again.fetch).toBe("cache");
    expect(again.duplicate).toBeNull();
    expect(again.asset).toBe(first.asset);
    expect(f.read(again.asset)).toBe("H264 ocean waves");
    expect(f.net.calls.length).toBe(before);
    // One consistent record, not two.
    expect(readLedger(f.project.dir).records).toHaveLength(1);
  });
});

describe("sources view and export check", () => {
  it("shows unknown and restricted licenses, what uses them and their credits, and warns on export without blocking", async () => {
    const f = setup();
    f.net.when(
      (url) => url.hostname === "commons.wikimedia.org",
      json(JSON.parse(fixtureText("commons-picture.json"))),
    );
    const found = await f.service.search(f.project, {
      query: "volcano",
      mediaKind: "picture",
      sources: ["wikimedia-commons"],
    });
    const candidate = found.candidates[0];
    if (!candidate) throw new Error("no candidate");
    serve(f, candidate.mediaUrl, "JPEG volcano", "image/jpeg");
    const licensed = await f.service.import(f.project, { candidate: candidate.id });
    serve(f, OCEAN, "H264 ocean waves");
    const unknown = await importUrl(f, OCEAN);

    compose(f, unknown.asset);
    const view = await f.service.sources(f.project);
    expect(view.mode).toBe("trusted");
    expect(view.summary).toMatchObject({ total: 2, missingFiles: 0, unknown: 1 });
    const entry = view.records.find((record) => record.asset === unknown.asset);
    expect(entry).toMatchObject({
      present: true,
      usedIn: ["index.html"],
      licenseStatus: "unknown",
    });
    expect(entry?.issues[0]).toContain("License unknown");
    expect(view.records.find((record) => record.asset === licensed.asset)?.usedIn).toEqual([]);
    expect(view.credits).toContain(unknown.provenance.attribution);

    const check = await f.service.exportCheck(f.project, "index.html");
    expect(check.assets.map((asset) => asset.asset)).toEqual([unknown.asset]);
    expect(check.warnings).toEqual([
      expect.objectContaining({ asset: unknown.asset, status: "unknown", license: "Unknown" }),
    ]);
    expect((await failure(f.service.exportCheck(f.project, "nope.html"))).code).toBe(
      "unknown_asset",
    );

    // A file deleted from the project stays in the view as a missing file.
    rmSync(join(f.project.dir, licensed.asset));
    expect((await f.service.sources(f.project)).summary).toMatchObject({
      total: 2,
      missingFiles: 1,
    });
  });

  it("follows hosted sub-compositions when it finds where an asset is used", async () => {
    const f = setup();
    serve(f, OCEAN, "H264 ocean waves");
    const done = await importUrl(f, OCEAN);
    f.story.made.write(
      "compositions/lower.html",
      `<div data-composition-id="lower" data-width="1920" data-height="1080" data-duration="3"><video data-hf-id="hf-l" class="clip" src="../${done.asset}" data-start="0" data-duration="3" data-track-index="0"></video></div>`,
    );
    f.story.made.write(
      "index.html",
      BLANK_HTML.replace(
        `data-duration="0"></div>`,
        `data-duration="3"><div data-hf-id="hf-host" class="clip" data-composition-id="lower" data-composition-src="compositions/lower.html" data-start="0" data-duration="3" data-track-index="0"></div></div>`,
      ),
    );
    const view = await f.service.sources(f.project);
    expect(view.records[0]?.usedIn).toEqual(["index.html", "compositions/lower.html"]);
  });

  it("reads a damaged ledger as empty, keeping a backup, and recovers on the next import", async () => {
    const f = setup();
    const file = join(f.project.dir, PROVENANCE_PATH);
    mkdirSync(join(f.project.dir, ".hyperframes/research"), { recursive: true });
    writeFileSync(file, '{"schema": "openvids.provenance/1", "records": [');
    expect((await f.service.sources(f.project)).records).toEqual([]);
    expect(readFileSync(`${file}.bak`, "utf-8")).toContain("records");
    serve(f, OCEAN, "H264 ocean waves");
    await importUrl(f, OCEAN);
    expect((await f.service.sources(f.project)).records).toHaveLength(1);
  });
});

describe("resolving Missing Asset nodes", () => {
  async function withMissing(f: ResearchFixture) {
    const made = await f.story.edit([
      {
        op: "add_node",
        ref: "a",
        node: { kind: "chapter", title: "Opening", status: "needs_material" },
      },
      {
        op: "add_node",
        ref: "m",
        node: {
          kind: "missing",
          title: "Sea",
          mediaKind: "video",
          need: "Waves rolling onto a beach",
        },
      },
      { op: "attach", node: "@m", chapter: "@a", placement: "end", duration: 2 },
    ]);
    return { chapter: created(made, 0), missing: created(made, 1), attachment: created(made, 2) };
  }
  const node = (graph: StoryGraph, id: string) => graph.nodes.find((entry) => entry.id === id);

  it("replaces the node through the import, keeps its attachment, and records the node and need on the provenance", async () => {
    const f = setup();
    const ids = await withMissing(f);
    serve(f, OCEAN, "H264 ocean waves");
    const done = await importUrl(f, OCEAN, { resolveMissing: ids.missing, turnId: "turn-3" });
    expect(done.resolveError).toBeNull();
    expect(done.resolved?.missing).toBe(ids.missing);
    const graph = await f.story.graph();
    const replacement = node(graph, done.resolved?.node ?? "");
    expect(replacement).toMatchObject({
      kind: "video",
      title: "Sea",
      asset: done.asset,
      resolvedFrom: { missing: ids.missing, need: "Waves rolling onto a beach", turnId: "turn-3" },
    });
    expect(node(graph, ids.missing)).toBeUndefined();
    expect(graph.attachments).toMatchObject([
      {
        id: ids.attachment,
        node: replacement?.id,
        chapter: ids.chapter,
        placement: "end",
        duration: 2,
      },
    ]);
    expect(node(graph, ids.chapter)).toMatchObject({ status: "proposed" });
    const record = readLedger(f.project.dir).records[0];
    expect(record).toMatchObject({
      storyNode: replacement?.id,
      need: "Waves rolling onto a beach",
    });
    expect(done.provenance).toEqual(record);
  });

  it("refuses, before downloading anything, an import for a node the story would not let it resolve", async () => {
    const f = setup();
    const ids = await withMissing(f);
    const lock = async (id: string) => {
      const view = await f.story.view();
      if (!view.graph) throw new Error("no graph");
      const graph = structuredClone(view.graph);
      const target = node(graph, id);
      if (target) target.locked = true;
      await f.story.service.save(f.project, { baseVersion: view.version, graph });
    };
    serve(f, OCEAN, "H264 ocean waves");

    // A chapter the node is attached to is locked: its material may not change.
    await lock(ids.chapter);
    const chapterLocked = await failure(importUrl(f, OCEAN, { resolveMissing: ids.missing }));
    expect(chapterLocked).toMatchObject({ code: "locked" });
    expect(chapterLocked.message).toContain("Opening");
    // The Missing Asset node itself is locked.
    await lock(ids.missing);
    expect((await failure(importUrl(f, OCEAN, { resolveMissing: ids.missing }))).code).toBe(
      "locked",
    );
    // Not a Missing Asset node (the chapter), or no such node.
    for (const id of [ids.chapter, "missing-gone"]) {
      expect((await failure(importUrl(f, OCEAN, { resolveMissing: id }))).code).toBe(
        "unknown_node",
      );
    }

    expect(f.net.calls).toEqual([]);
    expect(f.researchFiles()).toEqual([]);
    expect(readLedger(f.project.dir).records).toEqual([]);
    expect(node(await f.story.graph(), ids.missing)?.kind).toBe("missing");
  });

  it("resolves a node with a file the project already has, and maps the story's refusals to research errors", async () => {
    const f = setup();
    const ids = await withMissing(f);
    expect(
      (
        await failure(
          f.service.resolve(f.project, { missing: ids.missing, asset: "assets/nope.mp4" }),
        )
      ).code,
    ).toBe("unknown_asset");
    expect(
      (await failure(f.service.resolve(f.project, { missing: ids.chapter, asset: "assets/b.mp4" })))
        .code,
    ).toBe("invalid_request");
    expect(
      (
        await failure(
          f.service.resolve(f.project, { missing: "missing-zzz", asset: "assets/b.mp4" }),
        )
      ).code,
    ).toBe("unknown_node");
    const done = await f.service.resolve(f.project, {
      missing: ids.missing,
      asset: "./assets/b.mp4",
    });
    expect(done).toMatchObject({ missing: ids.missing, asset: "assets/b.mp4" });
    expect(done.view.graph?.nodes.find((entry) => entry.id === done.node)).toMatchObject({
      kind: "video",
      asset: "assets/b.mp4",
    });
  });

  it("refuses without a story", async () => {
    const f = setup();
    expect(
      (await failure(f.service.resolve(f.project, { missing: "missing-1", asset: "assets/b.mp4" })))
        .code,
    ).toBe("no_story");
  });
});

describe("revert", () => {
  it("removes the asset file, its provenance record and the story resolution together, keeps the download cache, and re-imports from it", async () => {
    const f = setup();
    const engine = await openProjectHistory({
      projectDir: f.project.dir,
      historyRoot: join(f.story.made.root, "history"),
    });
    history = engine;
    const made = await f.story.edit([
      { op: "add_node", ref: "a", node: { kind: "chapter", title: "Opening" } },
      {
        op: "add_node",
        ref: "m",
        node: { kind: "missing", title: "Sea", mediaKind: "video", need: "Waves" },
      },
      { op: "attach", node: "@m", chapter: "@a" },
    ]);
    const missing = created(made, 1);
    await engine.flush();
    const graphBefore = readFileSync(join(f.project.dir, ".hyperframes/story/graph.json"), "utf-8");
    serve(f, OCEAN, "H264 ocean waves");
    const [candidate] = (await f.service.inspect(f.project, { url: OCEAN })).candidates;
    if (!candidate) throw new Error("no candidate");

    const window = await engine.beginWindow(agent, "Research turn");
    const done = await f.service.import(f.project, {
      candidate: candidate.id,
      resolveMissing: missing,
      agent: "research",
      turnId: "turn-1",
    });
    expect(done.resolved).not.toBeNull();
    expect(f.researchFiles()).toHaveLength(1);
    const entry = await window.close();
    expect(entry?.who).toEqual(agent);
    expect(entry?.files.map((file) => file.path).sort()).toEqual([
      ".hyperframes/research/provenance.json",
      ".hyperframes/story/graph.json",
      done.asset,
    ]);

    const result = await engine.undo(entry?.id ?? "", { who: agent, mode: "keep-later-edits" });
    expect(result.ok).toBe(true);
    expect(f.researchFiles()).toEqual([]);
    expect(existsSync(join(f.project.dir, PROVENANCE_PATH))).toBe(false);
    expect(readFileSync(join(f.project.dir, ".hyperframes/story/graph.json"), "utf-8")).toBe(
      graphBefore,
    );
    expect((await f.service.sources(f.project)).records).toEqual([]);
    // The download cache is outside history.
    expect(existsSync(join(f.project.dir, ".hyperframes/research/cache/index.json"))).toBe(true);

    const before = f.net.calls.length;
    const again = await f.service.import(f.project, {
      candidate: candidate.id,
      resolveMissing: missing,
      agent: "research",
      turnId: "turn-2",
    });
    expect(again.fetch).toBe("cache");
    expect(f.net.calls.length).toBe(before);
    expect(again.asset).toBe(done.asset);
    expect(again.resolved).not.toBeNull();
    const records: AssetProvenance[] = readLedger(f.project.dir).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      asset: again.asset,
      retrievedBy: { turnId: "turn-2" },
      storyNode: again.resolved?.node,
    });
  });
});
