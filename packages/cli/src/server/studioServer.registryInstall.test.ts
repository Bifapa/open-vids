import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStudioServer, type StudioServer } from "./studioServer.js";

const SCHEMA = "https://hyperframes.heygen.com/schema/registry-item.json";
// Names no other test uses: the registry cache is shared by every test in a run.
const block = (name: string, dependencies?: string[]) => ({
  $schema: SCHEMA,
  name,
  type: "hyperframes:block",
  title: name,
  description: "Block for tests",
  dimensions: { width: 1080, height: 1350 },
  duration: 6,
  ...(dependencies ? { registryDependencies: dependencies } : {}),
  files: [
    { path: `${name}.html`, target: `compositions/${name}.html`, type: "hyperframes:composition" },
  ],
});
const ITEMS = [
  block("studio-drop-block"),
  block("studio-drop-other"),
  block("studio-drop-parent", ["studio-drop-part"]),
  {
    $schema: SCHEMA,
    name: "studio-drop-part",
    type: "hyperframes:component",
    title: "part",
    description: "Component for tests",
    files: [
      {
        path: "studio-drop-part.html",
        target: "compositions/components/studio-drop-part.html",
        type: "hyperframes:snippet",
      },
    ],
  },
];

const dirs: string[] = [];
let server: StudioServer | undefined;

afterEach(() => {
  server?.watcher.close();
  server = undefined;
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project behind a symlink whose hyperframes.json points at a local fixture registry tree. */
function writeFixtureTree(root: string): string {
  const registry = join(root, "fixture-registry");
  const writeJson = (rel: string, value: unknown): void => {
    const path = join(registry, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value), "utf-8");
  };
  writeJson("registry.json", {
    $schema: "https://hyperframes.heygen.com/schema/registry.json",
    name: "t",
    homepage: "https://example.com",
    items: ITEMS.map(({ name, type }) => ({ name, type })),
  });
  const writeText = (rel: string, value: string): void => {
    const path = join(registry, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value, "utf-8");
  };
  for (const item of ITEMS) {
    const dirName = item.type === "hyperframes:component" ? "components" : "blocks";
    writeJson(`${dirName}/${item.name}/registry-item.json`, item);
    writeText(
      `${dirName}/${item.name}/${item.name}.html`,
      `<meta name="viewport" content="width=1920, height=1080"><div data-composition-id="${item.name}"></div>`,
    );
  }
  return registry;
}

function projectWithRegistry(): {
  link: string;
  real: string;
  registry: string;
} {
  const root = mkdtempSync(join(tmpdir(), "hf-studio-install-"));
  dirs.push(root);
  const registry = writeFixtureTree(root);
  const real = join(root, "real");
  mkdirSync(real);
  const link = join(root, "link");
  symlinkSync(real, link, "junction");
  writeFileSync(join(real, "index.html"), '<div data-width="1920" data-height="1080"></div>');
  writeFileSync(
    join(real, "hyperframes.json"),
    JSON.stringify({ registryDir: registry, paths: { blocks: "scenes" } }),
  );
  server = createStudioServer({ projectDir: link });
  return { link, real, registry };
}

function installer(link: string) {
  return (blockName: string) =>
    server!.adapter.installRegistryBlock!({
      project: { dir: link, id: "p", title: "p" },
      blockName,
    } as never);
}

describe("Studio catalog install", () => {
  it("installs through add: honours the project's block folder and records the item", async () => {
    const { link, real } = projectWithRegistry();

    const result = await installer(link)("studio-drop-block");

    expect(result.written).toEqual(["scenes/studio-drop-block.html"]);
    expect(result.block.name).toBe("studio-drop-block");
    expect(existsSync(join(real, "compositions/studio-drop-block.html"))).toBe(false);
    const config = JSON.parse(readFileSync(join(real, "hyperframes.json"), "utf-8"));
    expect(config.registryItems).toEqual([
      {
        name: "studio-drop-block",
        type: "hyperframes:block",
        target: "scenes/studio-drop-block.html",
      },
    ]);
  });

  it("lists the catalog from the registry install uses", async () => {
    projectWithRegistry();

    const items = await server!.adapter.listRegistryCatalog!();

    expect(items.map((item) => item.name).sort()).toEqual(ITEMS.map((item) => item.name).sort());
  });

  it("installs a block sized unlike the project twice, and leaves a real edit alone", async () => {
    const { link, real } = projectWithRegistry();
    const install = installer(link);
    const file = join(real, "scenes/studio-drop-block.html");

    await install("studio-drop-block");
    expect(readFileSync(file, "utf-8")).toContain('content="width=1920, height=1080"');
    expect((await install("studio-drop-block")).written).toEqual(["scenes/studio-drop-block.html"]);

    writeFileSync(file, "my own edit");
    expect((await install("studio-drop-block")).written).toEqual([]);
    expect(readFileSync(file, "utf-8")).toBe("my own edit");
  });

  it("keeps an edit to one block when another block is installed", async () => {
    const { link, real } = projectWithRegistry();
    const install = installer(link);
    const file = join(real, "scenes/studio-drop-block.html");

    await install("studio-drop-block");
    writeFileSync(file, "my own edit");
    await install("studio-drop-other");
    await install("studio-drop-block");

    expect(readFileSync(file, "utf-8")).toBe("my own edit");
  });

  it("names the block's own file, as recorded, when its folder is a symlink inside the project", async () => {
    const { link, real } = projectWithRegistry();
    mkdirSync(join(real, "shared-scenes"));
    symlinkSync(join(real, "shared-scenes"), join(real, "scenes"), "junction");
    const install = installer(link);

    await install("studio-drop-block");
    expect(readFileSync(join(real, "scenes/studio-drop-block.html"), "utf-8")).toContain(
      "width=1920",
    );
    expect((await install("studio-drop-block")).written).toEqual(["scenes/studio-drop-block.html"]);
  });

  it("names the requested block's file first, before its dependencies'", async () => {
    const { link } = projectWithRegistry();

    const { written } = await installer(link)("studio-drop-parent");

    expect(written).toEqual([
      "scenes/studio-drop-parent.html",
      "compositions/components/studio-drop-part.html",
    ]);
  });
});
