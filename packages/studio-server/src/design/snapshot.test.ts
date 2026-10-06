// @vitest-environment node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectSignature, listProjectFiles } from "../helpers/projectSignature.js";
import { exportCheck } from "../research/sourcesView.js";
import { isDesignFailure } from "./errors.js";
import type { DesignLibrary } from "./library.js";
import {
  attachDesign,
  detachDesign,
  projectSnapshotFiles,
  readProjectDesignState,
  updateDesign,
} from "./snapshot.js";
import { projectSpec, seedSystem, tempLibrary, tempProject } from "./projectTestSupport.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup(files: Record<string, string> = {}): { library: DesignLibrary; dir: string } {
  const lib = tempLibrary();
  const project = tempProject(files);
  cleanups.push(lib.dispose, project.dispose);
  return { library: lib.library, dir: project.dir };
}

function listing(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listing(dir, rel));
    else found.push(rel);
  }
  return found.sort();
}

function bytesOf(dir: string, paths: string[]): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(dir, path), "utf-8")]));
}

const COMPOSITIONS = ["index.html", "compositions/outro.html", "styles.css"];

describe("attachDesign", () => {
  it("copies the library's current version into design/ and touches no composition", async () => {
    const { library, dir } = setup();
    await seedSystem(library, "midnight");
    const before = bytesOf(dir, COMPOSITIONS);

    const state = await attachDesign(dir, library, "midnight");

    expect(state).toMatchObject({
      attached: {
        schema: "openvids.project-design/1",
        id: "midnight",
        version: 1,
        name: "Midnight",
        unknownLicenses: ["font:Helvetica Neue"],
        nonPortableFonts: ["Helvetica Neue"],
      },
      library: { name: "Midnight", version: 1 },
      updateAvailable: false,
      snapshotOk: true,
    });
    const files = listing(dir, "design");
    expect(files).toContain("design/system.html");
    expect(files).toContain("design/tokens.css");
    expect(files).toContain("design/design.json");
    expect(files.some((file) => file.startsWith("design/fonts/") && file.endsWith(".woff2"))).toBe(
      true,
    );
    expect(files.some((file) => file.includes("thumbnail") || file.includes("meta.json"))).toBe(
      false,
    );
    const { version, files: wanted } = library.snapshotFiles("midnight");
    expect(version).toBe(1);
    for (const file of wanted) {
      expect(readFileSync(join(dir, "design", file))).toEqual(
        readFileSync(join(library.currentDir("midnight"), file)),
      );
    }
    expect(bytesOf(dir, COMPOSITIONS)).toEqual(before);
    expect(listing(dir).filter((file) => file.startsWith(".hyperframes/design-staging"))).toEqual(
      [],
    );
  });

  it("writes design.json in the layout the shell writes (key order, 2 spaces, trailing newline)", async () => {
    const { library, dir } = setup();
    await seedSystem(library, "midnight");
    const state = await attachDesign(dir, library, "midnight");
    const text = readFileSync(join(dir, "design/design.json"), "utf-8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual([
      "schema",
      "id",
      "version",
      "name",
      "attachedAt",
      "unknownLicenses",
      "nonPortableFonts",
    ]);
    expect(text).toBe(`${JSON.stringify(state.attached, null, 2)}\n`);
  });

  it("switches to another system, dropping the first one's fonts", async () => {
    const { library, dir } = setup();
    await seedSystem(library, "midnight");
    const first = await attachDesign(dir, library, "midnight");
    const firstFonts = listing(dir, "design/fonts");
    await library.save("plain", {
      name: "Plain",
      source: { kind: "scratch" },
      spec: {
        ...projectSpec(),
        fonts: [
          {
            family: "Inter",
            role: "body",
            source: "google",
            weights: [500],
            license: { name: "OFL" },
          },
        ],
      },
    });
    const second = await attachDesign(dir, library, "plain");
    expect(first.attached?.id).toBe("midnight");
    expect(second.attached).toMatchObject({
      id: "plain",
      unknownLicenses: [],
      nonPortableFonts: [],
    });
    expect(second.snapshotOk).toBe(true);
    const nowFonts = listing(dir, "design/fonts");
    expect(nowFonts.length).toBeGreaterThan(0);
    expect(nowFonts.some((file) => firstFonts.includes(file))).toBe(false);
  });

  it("refuses an unknown system and a library file that fails validation, leaving the project untouched", async () => {
    const { library, dir } = setup();
    await seedSystem(library, "midnight");
    const before = listing(dir);
    await expect(attachDesign(dir, library, "ghost")).rejects.toMatchObject({
      error: { code: "not_found" },
    });
    writeFileSync(
      join(library.currentDir("midnight"), "system.html"),
      "<html><body><script>alert(1)</script></body></html>",
    );
    const failure = await attachDesign(dir, library, "midnight").catch((error: unknown) => error);
    expect(isDesignFailure(failure)).toBe(true);
    expect(failure).toMatchObject({ error: { code: "invalid_system" } });
    expect(listing(dir)).toEqual(before);
  });

  it("does not overwrite a design/ file of the user's that is not part of a snapshot", async () => {
    const { library, dir } = setup({ "design/tokens.css": ":root { --mine: 1; }" });
    await seedSystem(library, "midnight");
    await expect(attachDesign(dir, library, "midnight")).rejects.toMatchObject({
      error: { code: "conflict" },
    });
    expect(readFileSync(join(dir, "design/tokens.css"), "utf-8")).toBe(":root { --mine: 1; }");
    expect(listing(dir, "design")).toEqual(["design/tokens.css"]);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a design/ that links out of the project",
    async () => {
      const { library, dir } = setup();
      const outside = tempProject();
      cleanups.push(outside.dispose);
      await seedSystem(library, "midnight");
      symlinkSync(outside.dir, join(dir, "design"));
      await expect(attachDesign(dir, library, "midnight")).rejects.toMatchObject({
        error: { code: "invalid_request" },
      });
      expect(existsSync(join(outside.dir, "tokens.css"))).toBe(false);
      expect(existsSync(join(outside.dir, "system.html"))).toBe(false);
    },
  );
});

describe("project history and the preview signature", () => {
  it("treat design/ like any project file and ignore the staging folder", async () => {
    const { library, dir } = setup();
    await seedSystem(library, "midnight");
    const before = createProjectSignature(dir);
    await attachDesign(dir, library, "midnight");
    const tracked = listProjectFiles(dir).map((file) => file.path);
    expect(tracked).toEqual(
      expect.arrayContaining(["design/system.html", "design/tokens.css", "design/design.json"]),
    );
    expect(tracked.some((path) => path.startsWith(".hyperframes/design-staging"))).toBe(false);
    const attachedSignature = createProjectSignature(dir);
    expect(attachedSignature).not.toBe(before);

    mkdirSync(join(dir, ".hyperframes/design-staging-1-x"), { recursive: true });
    writeFileSync(join(dir, ".hyperframes/design-staging-1-x/system.html"), "partial");
    expect(createProjectSignature(dir)).toBe(attachedSignature);
    expect(listProjectFiles(dir).map((file) => file.path)).toEqual(tracked);
  });
});

describe("updateDesign", () => {
  it("only moves to a newer library version when asked", async () => {
    const { library, dir } = setup();
    await seedSystem(library, "midnight");
    await attachDesign(dir, library, "midnight");
    const v1 = bytesOf(dir, ["design/system.html", "design/tokens.css"]);

    await seedSystem(library, "midnight", { baseVersion: 1, brand: "#00ff88" });

    const waiting = await readProjectDesignState(dir, library);
    expect(waiting).toMatchObject({
      attached: { version: 1 },
      library: { version: 2 },
      updateAvailable: true,
      snapshotOk: true,
    });
    expect(bytesOf(dir, ["design/system.html", "design/tokens.css"])).toEqual(v1);

    const updated = await updateDesign(dir, library);
    expect(updated).toMatchObject({ attached: { version: 2 }, updateAvailable: false });
    expect(readFileSync(join(dir, "design/tokens.css"), "utf-8")).toContain("#00ff88");

    await expect(updateDesign(dir, library)).rejects.toMatchObject({ error: { code: "conflict" } });
  });

  it("reports nothing attached and a deleted library system", async () => {
    const { library, dir } = setup();
    await expect(updateDesign(dir, library)).rejects.toMatchObject({
      error: { code: "not_found" },
    });
    await seedSystem(library, "midnight");
    await attachDesign(dir, library, "midnight");
    await library.delete("midnight");
    expect(await readProjectDesignState(dir, library)).toMatchObject({
      attached: { id: "midnight" },
      library: null,
      updateAvailable: false,
      snapshotOk: true,
    });
    await expect(updateDesign(dir, library)).rejects.toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("repairs a damaged snapshot even at the same version", async () => {
    const { library, dir } = setup();
    await seedSystem(library, "midnight");
    await attachDesign(dir, library, "midnight");
    rmSync(join(dir, "design/tokens.css"));
    expect((await readProjectDesignState(dir, library)).snapshotOk).toBe(false);
    expect((await updateDesign(dir, library)).snapshotOk).toBe(true);
  });
});

describe("detachDesign", () => {
  it("removes exactly the snapshot's files and keeps the user's", async () => {
    const { library, dir } = setup();
    await seedSystem(library, "midnight");
    await attachDesign(dir, library, "midnight");
    mkdirSync(join(dir, "design/fonts"), { recursive: true });
    writeFileSync(join(dir, "design/notes.md"), "mine");
    writeFileSync(join(dir, "design/fonts/Mine.ttf"), "mine");
    const before = bytesOf(dir, COMPOSITIONS);

    const state = await detachDesign(dir, library);

    expect(state).toEqual({
      attached: null,
      library: null,
      updateAvailable: false,
      snapshotOk: false,
    });
    expect(listing(dir, "design")).toEqual(["design/fonts/Mine.ttf", "design/notes.md"]);
    expect(bytesOf(dir, COMPOSITIONS)).toEqual(before);
  });

  it("removes design/ itself when nothing else is in it, and does nothing without a snapshot", async () => {
    const { library, dir } = setup();
    await seedSystem(library, "midnight");
    await attachDesign(dir, library, "midnight");
    await detachDesign(dir, library);
    expect(existsSync(join(dir, "design"))).toBe(false);

    const other = setup({ "design/system.html": "<p>mine</p>", "design/tokens.css": "x" });
    await detachDesign(other.dir, other.library);
    expect(listing(other.dir, "design")).toEqual(["design/system.html", "design/tokens.css"]);
  });

  it("names the snapshot's files from its own content", async () => {
    const { library, dir } = setup();
    await seedSystem(library, "midnight");
    await attachDesign(dir, library, "midnight");
    const names = projectSnapshotFiles(dir);
    expect(names[names.length - 1]).toBe("design/design.json");
    expect(names).toEqual(expect.arrayContaining(["design/system.html", "design/tokens.css"]));
    expect(names.filter((name) => name.startsWith("design/fonts/")).length).toBeGreaterThan(0);
    for (const name of names) expect(existsSync(join(dir, name))).toBe(true);
  });
});

describe("crash leftovers and forks", () => {
  it("sweeps an unfinished staging folder at the next call", async () => {
    const { library, dir } = setup();
    const stale = join(dir, ".hyperframes/design-staging-2147483646-dead");
    mkdirSync(join(stale, "fonts"), { recursive: true });
    writeFileSync(join(stale, "system.html"), "partial");
    await seedSystem(library, "midnight");

    await readProjectDesignState(dir, library);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(dir, "design"))).toBe(false);
  });

  it("finishes the swap of a complete staging folder (design.json was written last)", async () => {
    const { library, dir } = setup();
    await seedSystem(library, "midnight");
    const staged = join(dir, ".hyperframes/design-staging-2147483646-done");
    const { files } = library.snapshotFiles("midnight");
    for (const file of files) {
      mkdirSync(dirname(join(staged, file)), { recursive: true });
      cpSync(join(library.currentDir("midnight"), file), join(staged, file));
    }
    writeFileSync(join(staged, "previous.json"), "[]");
    writeFileSync(
      join(staged, "design.json"),
      `${JSON.stringify({ schema: "openvids.project-design/1", id: "midnight", version: 1, name: "Midnight", attachedAt: 1, unknownLicenses: [], nonPortableFonts: [] }, null, 2)}\n`,
    );

    const state = await readProjectDesignState(dir, library);

    expect(state).toMatchObject({ attached: { id: "midnight", version: 1 }, snapshotOk: true });
    expect(existsSync(staged)).toBe(false);
    expect(listing(dir, "design")).toContain("design/system.html");
  });

  it("a copy of the project (a fork) keeps a valid snapshot without the library", async () => {
    const { library, dir } = setup();
    await seedSystem(library, "midnight");
    await attachDesign(dir, library, "midnight");
    const fork = tempProject();
    cleanups.push(fork.dispose);
    cpSync(join(dir, "design"), join(fork.dir, "design"), { recursive: true });

    const emptyLibrary = tempLibrary();
    cleanups.push(emptyLibrary.dispose);
    expect(await readProjectDesignState(fork.dir, emptyLibrary.library)).toMatchObject({
      attached: { id: "midnight", version: 1 },
      library: null,
      updateAvailable: false,
      snapshotOk: true,
    });
  });
});

describe("export check", () => {
  it("lists the attached system's unknown licenses and machine-only fonts as warnings", async () => {
    const { library, dir } = setup();
    expect(exportCheck(dir, "index.html", []).warnings).toEqual([]);
    await seedSystem(library, "midnight");
    await attachDesign(dir, library, "midnight");

    const { warnings } = exportCheck(dir, "index.html", []);

    expect(warnings).toEqual([
      {
        asset: "design:font:Helvetica Neue",
        status: "unknown",
        license: "unknown",
        message:
          "Font “Helvetica Neue” in the design system “Midnight”: license unknown; check it before publishing; Font “Helvetica Neue” in the design system “Midnight” is installed on the author's machine only; it may render differently elsewhere",
      },
    ]);
  });

  it("warns about a logo with no known license", async () => {
    const { dir } = setup({
      "design/design.json": JSON.stringify({
        schema: "openvids.project-design/1",
        id: "x",
        version: 1,
        name: "Acme",
        attachedAt: 1,
        unknownLicenses: ["logo", "font:Foo"],
        nonPortableFonts: [],
      }),
    });
    expect(exportCheck(dir, "index.html", []).warnings.map((warning) => warning.asset)).toEqual([
      "design:logo",
      "design:font:Foo",
    ]);
    expect(exportCheck(dir, "index.html", []).warnings[0]?.message).toBe(
      "The logo in the design system “Acme”: license unknown; check it before publishing",
    );
  });
});
