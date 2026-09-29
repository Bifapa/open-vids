import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRegistryItems,
  loadAllItems,
  resolveItem,
  resolveItemWithDependencies,
  unreachableRegistryMessage,
} from "./resolver.js";

let root = "";
let registryDir = "";

function writeItem(
  name: string,
  type: "hyperframes:example" | "hyperframes:block",
  dependencies?: string[],
): void {
  const dir = type === "hyperframes:example" ? "examples" : "blocks";
  const files =
    type === "hyperframes:example"
      ? [{ path: "index.html", target: "index.html", type: "hyperframes:composition" }]
      : [
          {
            path: `${name}.html`,
            target: `compositions/${name}.html`,
            type: "hyperframes:composition",
          },
        ];
  const item: Record<string, unknown> = {
    name,
    type,
    title: name.toUpperCase(),
    description: `${name} description`,
    files,
    dimensions: { width: 1920, height: 1080 },
    duration: 10,
  };
  if (dependencies) item["registryDependencies"] = dependencies;
  const itemDir = join(registryDir, dir, name);
  mkdirSync(itemDir, { recursive: true });
  writeFileSync(join(itemDir, "registry-item.json"), JSON.stringify(item));
  const filePath = type === "hyperframes:example" ? "index.html" : `${name}.html`;
  writeFileSync(join(itemDir, filePath), `<div data-composition-id="${name}"></div>`);
}

function writeManifest(): void {
  writeFileSync(
    join(registryDir, "registry.json"),
    JSON.stringify({
      name: "test",
      homepage: "https://example.com",
      items: [
        { name: "alpha", type: "hyperframes:example" },
        { name: "beta", type: "hyperframes:example" },
        { name: "gamma", type: "hyperframes:block" },
      ],
    }),
  );
}

/** Rewrite one item's manifest in place (dependency injection for tests). */
function rewriteItem(
  name: string,
  type: "hyperframes:example" | "hyperframes:block",
  dependencies: string[] | undefined,
): void {
  writeItem(name, type, dependencies);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hf-resolver-"));
  registryDir = join(root, "registry");
  mkdirSync(join(registryDir, "examples"), { recursive: true });
  mkdirSync(join(registryDir, "blocks"), { recursive: true });
  mkdirSync(join(registryDir, "components"), { recursive: true });
  writeManifest();
  writeItem("alpha", "hyperframes:example");
  writeItem("beta", "hyperframes:example");
  writeItem("gamma", "hyperframes:block");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("registry resolver", () => {
  describe("listRegistryItems", () => {
    it("returns all items when no filter is given", async () => {
      const items = await listRegistryItems(undefined, { registryDir: registryDir });
      expect(items.map((i) => i.name)).toEqual(["alpha", "beta", "gamma"]);
    });

    it("filters by type", async () => {
      const examples = await listRegistryItems(
        { type: "hyperframes:example" },
        { registryDir: registryDir },
      );
      expect(examples.map((i) => i.name)).toEqual(["alpha", "beta"]);

      const blocks = await listRegistryItems(
        { type: "hyperframes:block" },
        { registryDir: registryDir },
      );
      expect(blocks.map((i) => i.name)).toEqual(["gamma"]);
    });

    it("returns empty when the registry directory is missing", async () => {
      const items = await listRegistryItems(undefined, {
        registryDir: join(root, "no-such-registry"),
      });
      expect(items).toEqual([]);
    });
  });

  describe("loadAllItems", () => {
    it("loads manifests in parallel", async () => {
      const entries = await listRegistryItems(undefined, { registryDir: registryDir });
      const items = await loadAllItems(entries, { registryDir: registryDir });
      expect(items.map((i) => i.name).sort()).toEqual(["alpha", "beta", "gamma"]);
      expect(items.find((i) => i.name === "alpha")?.title).toBe("ALPHA");
    });

    it("skips items whose manifest fails to load (warning, not failure)", async () => {
      rmSync(join(registryDir, "examples", "beta", "registry-item.json"));
      const warnings: string[] = [];
      // List against the committed manifest (still names beta) so the missing
      // item exercises the skip path rather than vanishing from the listing.
      const entries = [
        { name: "alpha", type: "hyperframes:example" as const },
        { name: "beta", type: "hyperframes:example" as const },
        { name: "gamma", type: "hyperframes:block" as const },
      ];
      const items = await loadAllItems(entries, {
        registryDir: registryDir,
        onWarn: (m) => warnings.push(m),
      });
      expect(items.map((i) => i.name).sort()).toEqual(["alpha", "gamma"]);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some((w) => w.includes("beta"))).toBe(true);
    });
  });

  describe("resolveItem", () => {
    it("returns the full manifest for a known item", async () => {
      const item = await resolveItem("alpha", { registryDir: registryDir });
      expect(item.name).toBe("alpha");
      expect(item.type).toBe("hyperframes:example");
      expect(item.files).toHaveLength(1);
    });

    it("throws with an `Available:` list when the name is unknown", async () => {
      await expect(resolveItem("nonexistent", { registryDir: registryDir })).rejects.toThrow(
        /Available: alpha, beta, gamma/,
      );
    });

    it("throws a clear message when the registry itself is missing", async () => {
      await expect(
        resolveItem("alpha", { registryDir: join(root, "no-such-registry") }),
      ).rejects.toThrow(/unreachable/);
    });

    it("refuses an item that declares registryDependencies", async () => {
      rewriteItem("beta", "hyperframes:example", ["alpha"]);
      await expect(resolveItem("beta", { registryDir: registryDir })).rejects.toThrow(
        /declares registryDependencies \(alpha\); use resolveItemWithDependencies/,
      );
    });
  });

  describe("resolveItemWithDependencies", () => {
    it("returns dependencies first, then the requested item (linear chain)", async () => {
      rewriteItem("beta", "hyperframes:example", ["alpha"]);
      rewriteItem("gamma", "hyperframes:block", ["beta"]);
      const items = await resolveItemWithDependencies("gamma", { registryDir: registryDir });
      expect(items.map((item) => item.name)).toEqual(["alpha", "beta", "gamma"]);
    });

    it("returns a single item when there are no dependencies", async () => {
      const items = await resolveItemWithDependencies("alpha", { registryDir: registryDir });
      expect(items.map((item) => item.name)).toEqual(["alpha"]);
    });

    it("installs a shared transitive dependency exactly once (diamond)", async () => {
      // gamma depends on both alpha and beta; beta also depends on alpha.
      rewriteItem("gamma", "hyperframes:block", ["alpha", "beta"]);
      rewriteItem("beta", "hyperframes:example", ["alpha"]);
      const items = await resolveItemWithDependencies("gamma", { registryDir: registryDir });
      expect(items.map((item) => item.name)).toEqual(["alpha", "beta", "gamma"]);
      expect(items.filter((item) => item.name === "alpha")).toHaveLength(1);
    });

    it("throws when a transitive dependency is missing from the registry", async () => {
      rewriteItem("beta", "hyperframes:example", ["does-not-exist"]);
      rewriteItem("gamma", "hyperframes:block", ["beta"]);
      await expect(
        resolveItemWithDependencies("gamma", { registryDir: registryDir }),
      ).rejects.toThrow(/Dependency "does-not-exist" not found in registry/);
    });

    it("throws a clear cycle error for circular dependencies", async () => {
      rewriteItem("alpha", "hyperframes:example", ["gamma"]);
      rewriteItem("beta", "hyperframes:example", ["alpha"]);
      rewriteItem("gamma", "hyperframes:block", ["beta"]);
      await expect(
        resolveItemWithDependencies("gamma", { registryDir: registryDir }),
      ).rejects.toThrow(/Circular registryDependencies detected: gamma -> beta -> alpha -> gamma/);
    });
  });
});

describe("unreachableRegistryMessage", () => {
  it("names a custom registry dir, so the reader looks at the right place", () => {
    const message = unreachableRegistryMessage("blur-in", "/custom/registry");

    expect(message).toContain("/custom/registry");
    expect(message).toContain("hyperframes.json");
  });

  it("stays quiet when no registry was supplied at all", () => {
    expect(unreachableRegistryMessage("blur-in")).toBe(
      'Item "blur-in" not found \u2014 registry unreachable or empty.',
    );
  });
});
