import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi, beforeEach } from "vitest";
import type { RegistryItem } from "@hyperframes/core";

// The installer reads from the local registry tree; the point of these tests
// is what it does to files on disk, so each test stages a scratch registry
// holding the item under test. `staged` carries the file bytes the next
// install reads (a "REGISTRY VERSION 2" write = upstream changed the file).
const staged = vi.hoisted(() => ({ contents: "REGISTRY VERSION\n", root: "" }));
vi.mock("./local.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./local.js")>();
  return {
    ...actual,
    localRegistryRoot: () => staged.root,
  };
});

const { hasLocalEdits, installItem, prepareItem, publishItem } = await import("./installer.js");

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-installer-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Stage `staged.contents` as the item's source bytes in a scratch registry. */
function stageRegistry(itemName: string, filePath: string): void {
  const registryDir = mkdtempSync(join(tmpdir(), "hf-installer-reg-"));
  onTestFinished(() => rmSync(registryDir, { recursive: true, force: true }));
  const itemDir = join(registryDir, "components", itemName);
  mkdirSync(itemDir, { recursive: true });
  writeFileSync(join(itemDir, "registry-item.json"), JSON.stringify({ name: itemName }));
  writeFileSync(join(itemDir, filePath), staged.contents);
  staged.root = registryDir;
}

const item = {
  name: "data-chart",
  title: "Data chart",
  description: "Chart component",
  type: "hyperframes:component",
  files: [
    { path: "data-chart.html", target: "components/data-chart.html", type: "hyperframes:snippet" },
  ],
} as unknown as RegistryItem;

const target = "components/data-chart.html";

beforeEach(() => {
  staged.contents = "REGISTRY VERSION\n";
  stageRegistry("data-chart", "data-chart.html");
});

describe("hasLocalEdits", () => {
  it("treats a file with no record as edited", () => {
    // Covers a project that wrote the file itself, and one that installed
    // before the record existed. Both would rather keep what they have.
    expect(hasLocalEdits({}, target, "anything")).toBe(true);
  });

  it("treats a file matching its record as untouched", () => {
    const hash = createHash("sha256").update("REGISTRY VERSION\n").digest("hex");
    expect(hasLocalEdits({ [target]: hash }, target, "REGISTRY VERSION\n")).toBe(false);
  });

  it("treats a file that no longer matches its record as edited", () => {
    const hash = createHash("sha256").update("REGISTRY VERSION\n").digest("hex");
    expect(hasLocalEdits({ [target]: hash }, target, "MY OWN COLOURS\n")).toBe(true);
  });
});

describe("installItem", () => {
  it("rejects a target directory symlink that escapes the project even with force", async () => {
    const dir = project();
    const outside = project();
    symlinkSync(outside, join(dir, "components"), "junction");
    await expect(installItem(item, { destDir: dir, force: true })).rejects.toThrow(/Unsafe target/);
    expect(existsSync(join(outside, "data-chart.html"))).toBe(false);
  });
  it("preserves directory symlinks whose destination stays inside the project", async () => {
    const dir = project();
    mkdirSync(join(dir, "actual"));
    symlinkSync(join(dir, "actual"), join(dir, "components"), "junction");
    await installItem(item, { destDir: dir, force: true });
    expect(readFileSync(join(dir, "actual/data-chart.html"), "utf8")).toContain("REGISTRY VERSION");
  });
  it.each(["darwin", "win32"] as const)(
    "rejects absent case and Unicode aliases on %s before downloads",
    async (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      try {
        for (const names of [
          ["Foo.html", "foo.html"],
          ["Café.html", "Café.html"],
        ]) {
          const dir = project();
          const conflicting = {
            ...item,
            files: names.map((name) => ({ ...item.files[0]!, target: `components/${name}` })),
          };
          await expect(installItem(conflicting, { destDir: dir, force: true })).rejects.toThrow(
            /duplicate/,
          );
          expect(existsSync(join(dir, "components"))).toBe(false);
        }
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
  it("records what it installed, so a later install can tell", async () => {
    const dir = project();
    const result = await installItem(item, { destDir: dir });

    expect(result.written).toHaveLength(1);
    expect(result.preserved).toEqual([]);
    const record = JSON.parse(readFileSync(join(dir, "hyperframes.lock.json"), "utf-8"));
    expect(record[target]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replaces a file the project has not touched", async () => {
    const dir = project();
    await installItem(item, { destDir: dir });

    staged.contents = "REGISTRY VERSION 2\n";
    stageRegistry("data-chart", "data-chart.html");
    const again = await installItem(item, { destDir: dir });

    expect(again.preserved).toEqual([]);
    expect(readFileSync(join(dir, target), "utf-8")).toBe("REGISTRY VERSION 2\n");
  });

  it("keeps a file the project has edited", async () => {
    const dir = project();
    await installItem(item, { destDir: dir });
    writeFileSync(join(dir, target), "MY OWN COLOURS\n", "utf-8");

    const again = await installItem(item, { destDir: dir });

    expect(again.written).toEqual([]);
    expect(again.preserved).toHaveLength(1);
    expect(readFileSync(join(dir, target), "utf-8")).toBe("MY OWN COLOURS\n");
  });

  it("keeps an edit saved while the rest of the plan was still being read", async () => {
    const dir = project();
    await installItem(item, { destDir: dir });
    staged.contents = "REGISTRY VERSION 2\n";
    stageRegistry("data-chart", "data-chart.html");
    const prepared = await prepareItem(item, { destDir: dir });
    writeFileSync(join(dir, target), "MY OWN COLOURS\n", "utf-8");

    const result = publishItem(prepared);

    expect(result.written).toEqual([]);
    expect(result.preserved).toHaveLength(1);
    expect(readFileSync(join(dir, target), "utf-8")).toBe("MY OWN COLOURS\n");
  });

  it("keeps a file that was there before any install", async () => {
    const dir = project();
    mkdirSync(join(dir, "components"), { recursive: true });
    writeFileSync(join(dir, target), "PRE-EXISTING\n", "utf-8");

    const result = await installItem(item, { destDir: dir });

    expect(result.preserved).toHaveLength(1);
    expect(readFileSync(join(dir, target), "utf-8")).toBe("PRE-EXISTING\n");
  });

  it("overwrites an edited file when forced", async () => {
    const dir = project();
    await installItem(item, { destDir: dir });
    writeFileSync(join(dir, target), "MY OWN COLOURS\n", "utf-8");

    const forced = await installItem(item, { destDir: dir, force: true });

    expect(forced.preserved).toEqual([]);
    expect(readFileSync(join(dir, target), "utf-8")).toBe("REGISTRY VERSION\n");
  });

  it("does not read its own edit back as the project's", async () => {
    // A block composition gets a marker comment added after reading. Recording
    // the pre-marker bytes would make every reinstall look like an edit.
    const blockDir = join(staged.root, "blocks", "hero");
    mkdirSync(blockDir, { recursive: true });
    writeFileSync(join(blockDir, "hero.html"), "<div>hero</div>");
    const block = {
      name: "hero",
      title: "Hero",
      description: "Hero block",
      dimensions: { width: 100, height: 100 },
      duration: 1,
      type: "hyperframes:block",
      files: [{ path: "hero.html", target: "blocks/hero.html", type: "hyperframes:composition" }],
    } as unknown as RegistryItem;

    const dir = project();
    await installItem(block, { destDir: dir });
    const second = await installItem(block, { destDir: dir });

    expect(second.preserved).toEqual([]);
    expect(second.written).toHaveLength(1);
  });
});

describe("installing several items, as a dependency plan does", () => {
  const other = {
    name: "shared-caption",
    title: "Shared caption",
    description: "Shared component",
    type: "hyperframes:component",
    files: [
      {
        path: "shared-caption.html",
        target: "components/shared-caption.html",
        type: "hyperframes:snippet",
      },
    ],
  } as unknown as RegistryItem;

  const otherTarget = "components/shared-caption.html";

  beforeEach(() => {
    const itemDir = join(staged.root, "components", "shared-caption");
    mkdirSync(itemDir, { recursive: true });
    writeFileSync(join(itemDir, "shared-caption.html"), staged.contents);
  });

  it("keeps a record for every item, not just the last one installed", () => {
    // `add` installs dependencies first and the requested item last. A record
    // rewritten per item rather than merged would forget the dependency, and
    // the next install would read it as edited and refuse to update it.
    const dir = project();
    return installItem(item, { destDir: dir })
      .then(() => installItem(other, { destDir: dir }))
      .then(() => {
        const record = JSON.parse(readFileSync(join(dir, "hyperframes.lock.json"), "utf-8"));
        expect(Object.keys(record).sort()).toEqual([otherTarget, target].sort());
      });
  });

  it("preserves an edit to one item while updating another", async () => {
    const dir = project();
    await installItem(item, { destDir: dir });
    await installItem(other, { destDir: dir });
    writeFileSync(join(dir, target), "EDITED DEPENDENCY\n", "utf-8");

    const edited = await installItem(item, { destDir: dir });
    const untouched = await installItem(other, { destDir: dir });

    expect(edited.preserved).toHaveLength(1);
    expect(untouched.written).toHaveLength(1);
    expect(readFileSync(join(dir, target), "utf-8")).toBe("EDITED DEPENDENCY\n");
  });
});

describe("installing with --vars the item cannot take", () => {
  const declaration = `<div data-composition-id="demo" data-composition-variables='[{"id":"maths","type":"boolean","label":"Maths","default":false}]'></div>`;
  const block = {
    name: "demo-block",
    title: "Demo block",
    description: "Block",
    dimensions: { width: 100, height: 100 },
    duration: 1,
    type: "hyperframes:block",
    files: [
      {
        path: "demo-block.html",
        target: "compositions/demo-block.html",
        type: "hyperframes:composition",
      },
    ],
  } as unknown as RegistryItem;

  beforeEach(() => {
    staged.contents = declaration;
    const itemDir = join(staged.root, "blocks", "demo-block");
    mkdirSync(itemDir, { recursive: true });
    writeFileSync(join(itemDir, "demo-block.html"), declaration);
    const compDir = join(staged.root, "components", "data-chart");
    writeFileSync(join(compDir, "data-chart.html"), declaration);
  });

  it.each([
    ["block", block, "compositions/demo-block.html"],
    ["component", item, target],
  ])(
    "refuses a wrong-typed value for a %s and writes nothing",
    async (_kind, installable, file) => {
      const dir = project();
      await expect(
        installItem(installable, { destDir: dir, variableValues: { maths: 1 } }),
      ).rejects.toThrow(/maths: expected boolean, got number/);
      expect(existsSync(join(dir, file))).toBe(false);
    },
  );
});
