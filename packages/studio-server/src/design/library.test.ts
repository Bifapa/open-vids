// @vitest-environment node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processStartKey } from "../history/ownerLock.js";
import { DesignFailure, isDesignFailure } from "./errors.js";
import { DesignLibrary } from "./library.js";
import { designLibraryRoot } from "./paths.js";
import {
  fakeFaces,
  makeTempDir,
  sampleRequest,
  sampleSpec,
  writeProjectFile,
} from "./testSupport.js";
import { validateDesignSystemHtml } from "./validate.js";

let root: string;
let projectDir: string;
let cleanup: () => void;
let fetched: string[];
let library: DesignLibrary;

beforeEach(() => {
  const temp = makeTempDir("openvids-design-library-");
  cleanup = temp.cleanup;
  root = join(temp.dir, "library");
  projectDir = join(temp.dir, "project");
  mkdirSync(projectDir, { recursive: true });
  fetched = [];
  library = new DesignLibrary(root, {
    fetchFont: async (family, weights) => {
      fetched.push(family);
      return fakeFaces(family, weights);
    },
    resolveProjectFile: async (projectId, path) =>
      projectId === "p1" ? { absPath: join(projectDir, path) } : null,
    lockWaitMs: 200,
  });
});
afterEach(() => cleanup());

const failureOf = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!isDesignFailure(error)) throw new Error(`expected a DesignFailure, got ${String(error)}`);
  return error.error;
};
const ttf = (seed: string) => Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from(seed)]);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("png-body")]);

describe("create and read", () => {
  it("writes version 1 complete, shows it at the top level and lists it", async () => {
    const { system, notes } = await library.save("sunset-talks", sampleRequest());
    expect(system).toMatchObject({
      id: "sunset-talks",
      name: "Sunset Talks",
      version: 1,
      displayFont: "Space Grotesk",
      palette: ["#0b0b0f", "#f4f1ea", "#ff6a3d", "#ffd166", "#4ecdc4"],
      nonPortableFonts: ["Helvetica Neue"],
      unknownLicenses: ["font:Helvetica Neue"],
    });
    const dir = join(root, "sunset-talks");
    const faces = readdirSync(join(dir, "fonts"));
    expect(faces).toHaveLength(4); // two weights × two subsets
    expect(
      faces.every((file) =>
        /^space-grotesk-(400|700)-normal-latin(-ext)?-[0-9a-f]{8}\.woff2$/.test(file),
      ),
    ).toBe(true);
    for (const file of ["system.html", "tokens.css", "thumbnail.svg", "meta.json"])
      expect(existsSync(join(dir, file))).toBe(true);
    for (const file of ["system.html", "tokens.css", "thumbnail.svg", "version.json"])
      expect(existsSync(join(dir, "versions", "1", file))).toBe(true);
    expect(readdirSync(join(dir, "versions", "1", "fonts"))).toEqual(faces);
    const tokens = readFileSync(join(dir, "tokens.css"), "utf-8");
    expect(tokens).toContain(
      `url("fonts/${faces.find((file) => file.includes("-700-normal-latin-ext"))}")`,
    );
    expect(tokens).toContain("unicode-range: U+0100-02AF;");
    expect(
      validateDesignSystemHtml(readFileSync(join(dir, "system.html"), "utf-8"), {
        expectedVersion: 1,
        fileExists: (path) => existsSync(join(dir, path)),
      }),
    ).toEqual([]);
    expect(notes.join("\n")).toMatch(/Space Grotesk.*downloaded 4 files/);
    expect(notes.join("\n")).toMatch(/Space Grotesk.*license set to SIL Open Font License 1\.1/);
    expect(notes.join("\n")).toMatch(/"Helvetica Neue" is a system font/);
    expect(library.list().map((entry) => entry.id)).toEqual(["sunset-talks"]);
  });

  it("reads a system back to the spec it was saved from, with versions and files", async () => {
    await library.save("sunset-talks", sampleRequest());
    const detail = library.get("sunset-talks");
    const request = sampleRequest();
    expect(detail.spec.tokens).toEqual(request.spec.tokens);
    expect(detail.spec.transitions).toEqual(request.spec.transitions);
    expect(detail.spec.motionRules).toEqual(request.spec.motionRules);
    expect(
      detail.spec.fonts.map((font) => [font.family, font.source, font.license?.name ?? null]),
    ).toEqual([
      ["Space Grotesk", "google", "SIL Open Font License 1.1"],
      ["Helvetica Neue", "system", null],
    ]);
    expect(detail.manifest.fonts[0]?.files).toHaveLength(4);
    expect(detail.versions.map((entry) => entry.version)).toEqual([1]);
    expect(detail.files).toEqual(
      expect.arrayContaining(["system.html", "tokens.css", "thumbnail.svg"]),
    );
    expect(detail.files.filter((file) => file.startsWith("fonts/"))).toHaveLength(4);
  });

  it("lists newest updated first, skips unreadable entries and an absent root", async () => {
    expect(library.list()).toEqual([]);
    await library.save("first", sampleRequest({ name: "First" }));
    await library.save("second", sampleRequest({ name: "Second" }));
    mkdirSync(join(root, "broken"));
    writeFileSync(join(root, "broken", "meta.json"), "{ not json");
    mkdirSync(join(root, "Not A Valid Id"));
    mkdirSync(join(root, "mismatch"));
    writeFileSync(
      join(root, "mismatch", "meta.json"),
      readFileSync(join(root, "first", "meta.json")),
    );
    expect(library.list().map((entry) => entry.id)).toEqual(["second", "first"]);
    expect(library.readMeta("broken")).toBeNull();
    expect(library.readMeta("nope")).toBeNull();
  });
});

describe("versions", () => {
  it("creates only when the id is free, saves a new version only from the current one", async () => {
    await library.save("sunset-talks", sampleRequest());
    expect(await failureOf(library.save("sunset-talks", sampleRequest()))).toMatchObject({
      code: "conflict",
    });
    expect(await failureOf(library.save("other", sampleRequest({ baseVersion: 1 })))).toMatchObject(
      { code: "not_found" },
    );
    expect(
      await failureOf(library.save("sunset-talks", sampleRequest({ baseVersion: 5 }))),
    ).toMatchObject({ code: "conflict" });

    const brand = sampleSpec();
    brand.tokens["--brand"] = "#00aa66";
    const { system } = await library.save(
      "sunset-talks",
      sampleRequest({ baseVersion: 1, spec: brand }),
    );
    expect(system.version).toBe(2);
    expect(system.palette[2]).toBe("#00aa66");
    expect(
      await failureOf(library.save("sunset-talks", sampleRequest({ baseVersion: 1 }))),
    ).toMatchObject({ code: "conflict" });

    // Both versions are kept whole; the top level shows the newest; an old version reads as it was.
    expect(readdirSync(join(root, "sunset-talks", "versions")).sort()).toEqual(["1", "2"]);
    expect(library.get("sunset-talks").spec.tokens["--brand"]).toBe("#00aa66");
    expect(library.get("sunset-talks", 1).spec.tokens["--brand"]).toBe("#ff6a3d");
    expect(library.get("sunset-talks").versions.map((entry) => entry.version)).toEqual([2, 1]);
    expect(
      await failureOf(Promise.resolve().then(() => library.get("sunset-talks", 9))),
    ).toMatchObject({ code: "not_found" });
  });

  it("keeps the files of a font that did not change instead of fetching it again", async () => {
    await library.save("sunset-talks", sampleRequest());
    const before = library.get("sunset-talks");
    await library.save("sunset-talks", sampleRequest({ baseVersion: 1, spec: before.spec }));
    expect(fetched).toEqual(["Space Grotesk"]);
    expect(library.get("sunset-talks").manifest.fonts[0]?.files).toEqual(
      before.manifest.fonts[0]?.files,
    );
    expect(readdirSync(join(root, "sunset-talks", "versions", "2", "fonts"))).toHaveLength(4);
  });

  it("drops a font and its files from the top level when a new version no longer uses it", async () => {
    await library.save("sunset-talks", sampleRequest());
    await library.save(
      "sunset-talks",
      sampleRequest({ baseVersion: 1, spec: sampleSpec({ fonts: [] }) }),
    );
    expect(existsSync(join(root, "sunset-talks", "fonts"))).toBe(false);
    expect(readdirSync(join(root, "sunset-talks", "versions", "1", "fonts"))).toHaveLength(4);
    expect(library.snapshotFiles("sunset-talks").files).toEqual(["system.html", "tokens.css"]);
  });

  it("renames without a new version", async () => {
    await library.save("sunset-talks", sampleRequest());
    const before = library.readMeta("sunset-talks");
    const renamed = await library.rename("sunset-talks", "Golden Hour");
    expect(renamed).toMatchObject({ id: "sunset-talks", name: "Golden Hour", version: 1 });
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);
    expect(readdirSync(join(root, "sunset-talks", "versions"))).toEqual(["1"]);
    expect(library.get("sunset-talks").name).toBe("Golden Hour");
    expect(library.list()[0]?.name).toBe("Golden Hour");
    expect(await failureOf(library.rename("sunset-talks", "<b>x</b>"))).toMatchObject({
      code: "invalid_request",
    });
    expect(await failureOf(library.rename("nope", "X"))).toMatchObject({ code: "not_found" });
  });

  it("deletes a system with its versions", async () => {
    await library.save("sunset-talks", sampleRequest());
    await library.save("keep", sampleRequest());
    await library.delete("sunset-talks");
    expect(existsSync(join(root, "sunset-talks"))).toBe(false);
    expect(library.list().map((entry) => entry.id)).toEqual(["keep"]);
    expect(await failureOf(library.delete("sunset-talks"))).toMatchObject({ code: "not_found" });
  });

  it("serialises concurrent writers: one creation wins, one base version wins", async () => {
    const created = await Promise.allSettled([
      library.save("same", sampleRequest()),
      library.save("same", sampleRequest()),
    ]);
    expect(created.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const edits = await Promise.allSettled([
      library.save("same", sampleRequest({ baseVersion: 1 })),
      library.save("same", sampleRequest({ baseVersion: 1 })),
    ]);
    expect(edits.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(library.readMeta("same")?.version).toBe(2);
    const many = await Promise.all(["a", "b", "c"].map((id) => library.save(id, sampleRequest())));
    expect(many.map((result) => result.system.version)).toEqual([1, 1, 1]);
  });

  it("fails busy, writing nothing, when another process holds the lock", async () => {
    mkdirSync(root, { recursive: true });
    const start = await processStartKey(process.pid);
    writeFileSync(
      join(root, ".lock"),
      start === null ? String(process.pid) : `${process.pid} ${start}`,
    );
    expect(await failureOf(library.save("sunset-talks", sampleRequest()))).toMatchObject({
      code: "busy",
    });
    expect(existsSync(join(root, "sunset-talks"))).toBe(false);
    expect(library.list()).toEqual([]); // reads never wait for the lock
  });
});

describe("validation and ids", () => {
  it("refuses a spec that misses contract tokens, writing nothing", async () => {
    const spec = sampleSpec();
    delete spec.tokens["--brand"];
    delete spec.tokens["--radius"];
    const error = await failureOf(library.save("sunset-talks", sampleRequest({ spec })));
    expect(error.code).toBe("invalid_system");
    expect(error.issues).toEqual([
      "missing required token --brand",
      "missing required token --radius",
    ]);
    expect(existsSync(join(root, "sunset-talks"))).toBe(false);
  });

  it("refuses unsafe ids, names and token values", async () => {
    for (const id of ["../evil", "Upper", "-dash", ".lock", "a/b", ""])
      expect(await failureOf(library.save(id, sampleRequest()))).toMatchObject({
        code: "invalid_request",
      });
    expect(await failureOf(library.save("ok", sampleRequest({ name: "<script>" })))).toMatchObject({
      code: "invalid_request",
    });
    const spec = sampleSpec();
    spec.tokens["--bg"] = "red; } body { background: url(https://evil.test/x)";
    expect(await failureOf(library.save("ok", sampleRequest({ spec })))).toMatchObject({
      code: "invalid_request",
    });
    expect(await failureOf(Promise.resolve().then(() => library.get("..")))).toMatchObject({
      code: "not_found",
    });
    expect(library.list()).toEqual([]);
    expect(existsSync(join(root, "ok"))).toBe(false);
  });

  it("never follows a linked system folder", async () => {
    const outside = join(root, "..", "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, join(root, "linked"), "dir");
    expect(await failureOf(library.save("linked", sampleRequest()))).toMatchObject({
      code: "invalid_request",
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(library.readMeta("linked")).toBeNull();
    expect(library.list()).toEqual([]);
  });
});

describe("fonts and logo", () => {
  it("fails asset_unavailable when Google Fonts cannot supply a family, writing nothing", async () => {
    const failing = new DesignLibrary(root, {
      fetchFont: async (family) => {
        throw new DesignFailure("asset_unavailable", `no ${family}`);
      },
    });
    expect(await failureOf(failing.save("sunset-talks", sampleRequest()))).toMatchObject({
      code: "asset_unavailable",
    });
    expect(existsSync(join(root, "sunset-talks"))).toBe(false);
  });

  it("copies a project font file into the library, content-named", async () => {
    writeProjectFile(projectDir, "assets/Brand.ttf", ttf("brand"));
    const spec = sampleSpec({
      fonts: [
        {
          family: "Brand Sans",
          role: "display",
          source: "file",
          projectPath: "assets/Brand.ttf",
          weights: [400, 700],
          license: { name: "Commercial (Acme)" },
        },
      ],
    });
    const { system, notes } = await library.save("brand", sampleRequest({ spec, projectId: "p1" }));
    expect(system.unknownLicenses).toEqual([]);
    expect(system.nonPortableFonts).toEqual([]);
    const stored = readdirSync(join(root, "brand", "fonts"));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^brand-sans-normal-[0-9a-f]{8}\.ttf$/);
    expect(readFileSync(join(root, "brand", "fonts", stored[0] ?? ""))).toEqual(ttf("brand"));
    const css = readFileSync(join(root, "brand", "tokens.css"), "utf-8");
    expect(css.match(/@font-face/g)).toHaveLength(2); // one face per weight
    expect(css).toContain('format("truetype")');
    expect(notes.join("\n")).toContain("copied assets/Brand.ttf");
    expect(fetched).toEqual([]);
  });

  it("flags system fonts as not portable and unknown licenses for the export check", async () => {
    writeProjectFile(projectDir, "logo.svg", SVG);
    const spec = sampleSpec({
      fonts: [
        {
          family: "Helvetica Neue",
          role: "display",
          source: "system",
          weights: [400],
          license: null,
        },
        {
          family: "Inter",
          role: "body",
          source: "google",
          weights: [400],
          license: { name: "Apache 2.0" },
        },
      ],
      logo: { projectPath: "logo.svg", license: null },
    });
    const { system } = await library.save("flags", sampleRequest({ spec, projectId: "p1" }));
    expect(system.nonPortableFonts).toEqual(["Helvetica Neue"]);
    expect(system.unknownLicenses).toEqual(["font:Helvetica Neue", "logo"]);
    expect(library.get("flags").manifest.fonts[1]?.license).toEqual({ name: "Apache 2.0" });
  });

  it("refuses project files that are not safe or not what they claim", async () => {
    const fontSpec = (projectPath: string) =>
      sampleSpec({
        fonts: [
          {
            family: "Brand",
            role: "display",
            source: "file",
            projectPath,
            weights: [400],
            license: null,
          },
        ],
      });
    writeProjectFile(projectDir, "a.ttf", ttf("x"));
    writeProjectFile(projectDir, "fake.woff2", "<html>not a font</html>");
    writeProjectFile(projectDir, "font.exe", ttf("x"));
    writeProjectFile(
      projectDir,
      "big.ttf",
      Buffer.concat([ttf("x"), Buffer.alloc(8 * 1024 * 1024)]),
    );
    const attempt = (spec: ReturnType<typeof sampleSpec>, projectId: string | null = "p1") =>
      failureOf(library.save("x", sampleRequest({ spec, ...(projectId && { projectId }) })));

    expect(await attempt(fontSpec("a.ttf"), null)).toMatchObject({
      code: "asset_unavailable",
      message: expect.stringContaining("projectId"),
    });
    expect(await attempt(fontSpec("a.ttf"), "unknown-project")).toMatchObject({
      code: "asset_unavailable",
    });
    expect(await attempt(fontSpec("../a.ttf"))).toMatchObject({
      code: "asset_unavailable",
      message: expect.stringContaining("project-relative"),
    });
    expect(await attempt(fontSpec("/etc/passwd"))).toMatchObject({ code: "asset_unavailable" });
    expect(await attempt(fontSpec("fake.woff2"))).toMatchObject({
      code: "asset_unavailable",
      message: expect.stringContaining("not a woff2"),
    });
    expect(await attempt(fontSpec("font.exe"))).toMatchObject({ code: "asset_unavailable" });
    expect(await attempt(fontSpec("big.ttf"))).toMatchObject({
      code: "asset_unavailable",
      message: expect.stringContaining("8 MB"),
    });
    expect(await attempt(fontSpec("missing.ttf"))).toMatchObject({ code: "asset_unavailable" });
    expect(existsSync(join(root, "x"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a font or logo that is a symbolic link",
    async () => {
      writeProjectFile(projectDir, "real.ttf", ttf("x"));
      writeProjectFile(projectDir, "real.svg", SVG);
      symlinkSync(join(projectDir, "real.ttf"), join(projectDir, "link.ttf"));
      symlinkSync(join(projectDir, "real.svg"), join(projectDir, "link.svg"));
      const font = sampleSpec({
        fonts: [
          {
            family: "B",
            role: "display",
            source: "file",
            projectPath: "link.ttf",
            weights: [400],
            license: null,
          },
        ],
      });
      const logo = sampleSpec({ fonts: [], logo: { projectPath: "link.svg", license: null } });
      for (const spec of [font, logo])
        expect(
          await failureOf(library.save("linked", sampleRequest({ spec, projectId: "p1" }))),
        ).toMatchObject({
          code: "asset_unavailable",
          message: expect.stringContaining("regular file"),
        });
    },
  );

  it("stores a logo and rejects scripted or reaching SVGs and fake images", async () => {
    const withLogo = (projectPath: string) =>
      sampleRequest({
        spec: sampleSpec({ fonts: [], logo: { projectPath, license: { name: "Own work" } } }),
        projectId: "p1",
      });
    writeProjectFile(projectDir, "ok.svg", SVG);
    writeProjectFile(projectDir, "ok.png", PNG);
    writeProjectFile(projectDir, "fake.png", "GIF89a...");
    const bad: Record<string, string> = {
      "script.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "handler.svg": '<svg xmlns="http://www.w3.org/2000/svg"><rect onload="x()"/></svg>',
      "href.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.test/a.svg#x"/></svg>',
      "url.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.test/x)"/></svg>',
      "foreign.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
      "import.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://evil.test/a.css";</style></svg>',
    };
    for (const [name, content] of Object.entries(bad)) writeProjectFile(projectDir, name, content);
    for (const name of [...Object.keys(bad), "fake.png"])
      expect(await failureOf(library.save("logos", withLogo(name)))).toMatchObject({
        code: "asset_unavailable",
      });

    const svg = await library.save("logos", withLogo("ok.svg"));
    expect(svg.system.unknownLicenses).toEqual([]);
    expect(readFileSync(join(root, "logos", "logo.svg"), "utf-8")).toBe(SVG);
    expect(library.snapshotFiles("logos").files).toEqual(["logo.svg", "system.html", "tokens.css"]);
    expect(library.get("logos").spec.logo).toEqual({
      projectPath: "logo.svg",
      license: { name: "Own work" },
    });

    // A new version with another logo format replaces the old file at the top level.
    const png = await library.save("logos", { ...withLogo("ok.png"), baseVersion: 1 });
    expect(png.system.version).toBe(2);
    expect(existsSync(join(root, "logos", "logo.svg"))).toBe(false);
    expect(readFileSync(join(root, "logos", "logo.png"))).toEqual(PNG);
    expect(existsSync(join(root, "logos", "versions", "1", "logo.svg"))).toBe(true);
  });

  it("keeps a stored logo and file font when an edit names them without a project", async () => {
    writeProjectFile(projectDir, "assets/Brand.ttf", ttf("brand"));
    writeProjectFile(projectDir, "logo.svg", SVG);
    const spec = sampleSpec({
      fonts: [
        {
          family: "Brand",
          role: "display",
          source: "file",
          projectPath: "assets/Brand.ttf",
          weights: [400],
          license: null,
        },
      ],
      logo: { projectPath: "logo.svg", license: null },
    });
    await library.save("keep", sampleRequest({ spec, projectId: "p1" }));
    const stored = library.get("keep").spec;
    const edited = { ...stored, motionRules: ["Changed"] };
    const { system } = await library.save("keep", sampleRequest({ spec: edited, baseVersion: 1 }));
    expect(system.version).toBe(2);
    expect(readFileSync(join(root, "keep", "logo.svg"), "utf-8")).toBe(SVG);
    expect(readdirSync(join(root, "keep", "fonts"))).toHaveLength(1);
    expect(library.get("keep").spec.motionRules).toEqual(["Changed"]);
  });
});

describe("an edit that carries the projectId", () => {
  it("keeps a stored logo and file font when the project no longer has them", async () => {
    writeProjectFile(projectDir, "assets/Brand.ttf", ttf("brand"));
    writeProjectFile(projectDir, "assets/brand-logo.svg", SVG);
    const spec = sampleSpec({
      fonts: [
        {
          family: "Brand",
          role: "display",
          source: "file",
          projectPath: "assets/Brand.ttf",
          weights: [400],
          license: null,
        },
      ],
      logo: { projectPath: "assets/brand-logo.svg", license: { name: "Own work" } },
    });
    await library.save("keep", sampleRequest({ spec, projectId: "p1" }));
    // The author moved on: the project has neither file any more, and the edit names the library's own logo path.
    rmSync(join(projectDir, "assets"), { recursive: true });
    const stored = library.get("keep").spec;
    expect(stored.logo?.projectPath).toBe("logo.svg");
    const edited = { ...stored, motionRules: ["Changed"] };
    const { system } = await library.save(
      "keep",
      sampleRequest({ spec: edited, baseVersion: 1, projectId: "p1" }),
    );
    expect(system.version).toBe(2);
    expect(readFileSync(join(root, "keep", "logo.svg"), "utf-8")).toBe(SVG);
    expect(readdirSync(join(root, "keep", "fonts"))).toHaveLength(1);
    expect(library.get("keep").spec.logo?.license).toEqual({ name: "Own work" });

    // A file that was never stored is still reported missing, not silently dropped.
    const other = { ...stored, logo: { projectPath: "assets/other.svg", license: null } };
    expect(
      await failureOf(
        library.save("keep", sampleRequest({ spec: other, baseVersion: 2, projectId: "p1" })),
      ),
    ).toMatchObject({
      code: "asset_unavailable",
      message: expect.stringContaining("was not found in the project"),
    });
  });
});

describe("lineage and names on edits", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses an edit whose baseCreatedAt is another system's (deleted and created again meanwhile)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const first = await library.save("brand", sampleRequest({ name: "Brand" }));
    expect(first.system.createdAt).toBe(1_000_000);
    await library.delete("brand");
    vi.setSystemTime(2_000_000);
    const again = await library.save("brand", sampleRequest({ name: "Brand" }));
    expect(again.system).toMatchObject({ version: 1, createdAt: 2_000_000 });

    // An edit that started from the first system (same id, same version number) must not land on the new one.
    const stale = sampleRequest({ baseVersion: 1, baseCreatedAt: 1_000_000 });
    expect(await failureOf(library.save("brand", stale))).toMatchObject({ code: "conflict" });
    expect(library.readMeta("brand")?.version).toBe(1);

    const fresh = await library.save(
      "brand",
      sampleRequest({ baseVersion: 1, baseCreatedAt: 2_000_000 }),
    );
    expect(fresh.system).toMatchObject({ version: 2, createdAt: 2_000_000 });
    // Without baseCreatedAt the check is by version only, as before.
    expect((await library.save("brand", sampleRequest({ baseVersion: 2 }))).system.version).toBe(3);
  });

  it("keeps the current name when an edit sends none, so a rename made meanwhile is not undone", async () => {
    await library.save("sunset-talks", sampleRequest());
    await library.rename("sunset-talks", "Golden Hour");
    const { name: _name, ...nameless } = sampleRequest({ baseVersion: 1 });
    const { system } = await library.save("sunset-talks", nameless);
    expect(system).toMatchObject({ version: 2, name: "Golden Hour" });
    expect(library.get("sunset-talks").name).toBe("Golden Hour");
    // An edit that names the system changes it.
    const renamed = await library.save(
      "sunset-talks",
      sampleRequest({ baseVersion: 2, name: "New name" }),
    );
    expect(renamed.system.name).toBe("New name");
  });

  it("still needs a name to create a system", async () => {
    const { name: _name, ...nameless } = sampleRequest();
    expect(await failureOf(library.save("fresh", nameless))).toMatchObject({
      code: "invalid_request",
    });
    expect(library.readMeta("fresh")).toBeNull();
  });
});

describe("crash recovery", () => {
  const saveTwo = async () => {
    await library.save("sunset-talks", sampleRequest());
    const brand = sampleSpec();
    brand.tokens["--brand"] = "#00aa66";
    await library.save("sunset-talks", sampleRequest({ baseVersion: 1, spec: brand }));
  };

  it("re-materialises a top level that is behind its versions, on the next write and on heal", async () => {
    await saveTwo();
    const dir = join(root, "sunset-talks");
    // A crash after versions/2 was complete but before the top level switched: files of v1, meta of v1.
    cpSync(join(dir, "versions", "1", "system.html"), join(dir, "system.html"));
    cpSync(join(dir, "versions", "1", "tokens.css"), join(dir, "tokens.css"));
    const v1 = JSON.parse(readFileSync(join(dir, "versions", "1", "version.json"), "utf-8"));
    writeFileSync(join(dir, "meta.json"), JSON.stringify(v1.meta));
    expect(library.list()[0]?.version).toBe(1);

    await library.heal();
    expect(library.list()[0]?.version).toBe(2);
    expect(readFileSync(join(dir, "system.html"), "utf-8")).toBe(
      readFileSync(join(dir, "versions", "2", "system.html"), "utf-8"),
    );

    writeFileSync(join(dir, "meta.json"), JSON.stringify(v1.meta));
    await library.rename("sunset-talks", "Renamed");
    expect(library.readMeta("sunset-talks")).toMatchObject({ version: 2, name: "Renamed" });
    expect(readFileSync(join(dir, "tokens.css"), "utf-8")).toContain("#00aa66");
  });

  it("recovers a version whose folder is complete but whose meta.json is gone", async () => {
    await library.save("sunset-talks", sampleRequest());
    rmSync(join(root, "sunset-talks", "meta.json"));
    expect(library.list()).toEqual([]);
    await library.heal();
    expect(library.list().map((entry) => entry.id)).toEqual(["sunset-talks"]);
  });

  it("does not let a version folder without version.json count, and sweeps stale staging", async () => {
    await saveTwo();
    const dir = join(root, "sunset-talks");
    mkdirSync(join(dir, "versions", ".staging-dead", "fonts"), { recursive: true });
    mkdirSync(join(dir, "versions", "3"), { recursive: true }); // never completed: no version.json
    writeFileSync(join(dir, "meta.json.123.abc.tmp"), "partial");
    await library.rename("sunset-talks", "Again");
    expect(existsSync(join(dir, "versions", ".staging-dead"))).toBe(false);
    expect(existsSync(join(dir, "meta.json.123.abc.tmp"))).toBe(false);
    expect(library.readMeta("sunset-talks")?.version).toBe(2);
    const { system } = await library.save("sunset-talks", sampleRequest({ baseVersion: 2 }));
    expect(system.version).toBe(3); // the stray folder is not a version: it was swept and the number reused
  });

  it("gives copy-safe folders: currentDir and snapshotFiles", async () => {
    await saveTwo();
    const folder = library.currentDir("sunset-talks");
    expect(folder).toBe(join(root, "sunset-talks", "versions", "2"));
    const snapshot = library.snapshotFiles("sunset-talks");
    expect(snapshot.version).toBe(2);
    expect(snapshot.files.filter((file) => !file.startsWith("fonts/"))).toEqual([
      "system.html",
      "tokens.css",
    ]);
    expect(snapshot.files.every((file) => existsSync(join(folder, file)))).toBe(true);
    expect(() => library.snapshotFiles("nope")).toThrow(/no design system/);
  });
});

describe("designLibraryRoot", () => {
  it("honours OPENVIDS_DESIGN_SYSTEMS_DIR and otherwise lives under ~/.openvids", () => {
    const saved = process.env.OPENVIDS_DESIGN_SYSTEMS_DIR;
    try {
      process.env.OPENVIDS_DESIGN_SYSTEMS_DIR = "/tmp/custom-library";
      expect(designLibraryRoot()).toBe("/tmp/custom-library");
      delete process.env.OPENVIDS_DESIGN_SYSTEMS_DIR;
      expect(designLibraryRoot().endsWith(join(".openvids", "design-systems"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.OPENVIDS_DESIGN_SYSTEMS_DIR;
      else process.env.OPENVIDS_DESIGN_SYSTEMS_DIR = saved;
    }
  });
});
