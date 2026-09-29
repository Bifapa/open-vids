import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RegistryItem, RegistryManifest } from "@hyperframes/core";
import { lintHyperframeHtml } from "@hyperframes/lint";
import type { RunAddResult } from "./add.js";
import {
  AddError,
  buildSnippet,
  compositionRootId,
  describeInstallFailure,
  parseVariableValues,
  remapTarget,
  runAdd,
  tagAddJson,
} from "./add.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const MANIFEST: RegistryManifest = {
  $schema: "https://hyperframes.heygen.com/schema/registry.json",
  name: "test",
  homepage: "https://example.com",
  items: [
    { name: "my-block", type: "hyperframes:block" },
    { name: "deprecated-block", type: "hyperframes:block" },
    { name: "future-block", type: "hyperframes:block" },
    { name: "dep-block", type: "hyperframes:block" },
    { name: "base-component", type: "hyperframes:component" },
    { name: "my-component", type: "hyperframes:component" },
    { name: "my-example", type: "hyperframes:example" },
  ],
};

const BLOCK_ITEM: RegistryItem = {
  $schema: "https://hyperframes.heygen.com/schema/registry-item.json",
  name: "my-block",
  type: "hyperframes:block",
  title: "My Block",
  description: "Block for tests",
  dimensions: { width: 1080, height: 1350 },
  duration: 6,
  files: [
    {
      path: "my-block.html",
      target: "compositions/my-block.html",
      type: "hyperframes:composition",
    },
  ],
};

const COMPONENT_ITEM: RegistryItem = {
  $schema: "https://hyperframes.heygen.com/schema/registry-item.json",
  name: "my-component",
  type: "hyperframes:component",
  title: "My Component",
  description: "Component for tests",
  files: [
    {
      path: "my-component.html",
      target: "compositions/components/my-component/my-component.html",
      type: "hyperframes:snippet",
    },
    {
      path: "my-component.css",
      target: "compositions/components/my-component/my-component.css",
      type: "hyperframes:style",
    },
    {
      path: "assets/mask.png",
      target: "assets/my-component/mask.png",
      type: "hyperframes:asset",
    },
  ],
};

const DEPRECATED_BLOCK_ITEM: RegistryItem = {
  ...BLOCK_ITEM,
  name: "deprecated-block",
  title: "Deprecated Block",
  deprecated: "Use `my-block` instead.",
  files: [
    {
      path: "deprecated-block.html",
      target: "compositions/deprecated-block.html",
      type: "hyperframes:composition",
    },
  ],
};

const FUTURE_BLOCK_ITEM: RegistryItem = {
  ...BLOCK_ITEM,
  name: "future-block",
  title: "Future Block",
  minCliVersion: "999.0.0",
  files: [
    {
      path: "future-block.html",
      target: "compositions/future-block.html",
      type: "hyperframes:composition",
    },
  ],
};

const BASE_COMPONENT_ITEM: RegistryItem = {
  $schema: "https://hyperframes.heygen.com/schema/registry-item.json",
  name: "base-component",
  type: "hyperframes:component",
  title: "Base Component",
  description: "Base component dependency for tests",
  files: [
    {
      path: "base-component.css",
      target: "compositions/components/base-component/base-component.css",
      type: "hyperframes:style",
    },
  ],
};

// A block that declares a transitive registryDependency on base-component.
const DEP_BLOCK_ITEM: RegistryItem = {
  ...BLOCK_ITEM,
  name: "dep-block",
  title: "Dependent Block",
  registryDependencies: ["base-component"],
  files: [
    {
      path: "dep-block.html",
      target: "compositions/dep-block.html",
      type: "hyperframes:composition",
    },
  ],
};

const EXAMPLE_ITEM: RegistryItem = {
  $schema: "https://hyperframes.heygen.com/schema/registry-item.json",
  name: "my-example",
  type: "hyperframes:example",
  title: "My Example",
  description: "Example for tests",
  dimensions: { width: 1920, height: 1080 },
  duration: 10,
  files: [{ path: "index.html", target: "index.html", type: "hyperframes:composition" }],
};

const ITEM_BY_NAME: Record<string, RegistryItem> = {
  "my-block": BLOCK_ITEM,
  "deprecated-block": DEPRECATED_BLOCK_ITEM,
  "future-block": FUTURE_BLOCK_ITEM,
  "dep-block": DEP_BLOCK_ITEM,
  "base-component": BASE_COMPONENT_ITEM,
  "my-component": COMPONENT_ITEM,
  "my-example": EXAMPLE_ITEM,
};

const DEP_BLOCK_HTML = `<div data-composition-variables='[{ "id": "maths", "type": "boolean", "label": "Maths", "default": false }]'></div>`;

import { ITEM_TYPE_DIRS } from "@hyperframes/core";

const FILE_BODIES: Record<string, string> = {
  "dep-block.html": DEP_BLOCK_HTML,
  "deprecated-block.html": `<div data-composition-id="deprecated-block"></div>`,
  "my-block.html": `<div data-composition-id="my-block-root" data-width="1080" data-height="1350"></div>`,
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "hf-add-test-"));
}

function writeRegistryTree(dir: string): string {
  const root = join(dir, "test-registry");
  const writeJson = (rel: string, value: unknown): void => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value), "utf-8");
  };
  writeJson("registry.json", MANIFEST);
  for (const [name, item] of Object.entries(ITEM_BY_NAME)) {
    const dirName = ITEM_TYPE_DIRS[item.type];
    writeJson(`${dirName}/${name}/registry-item.json`, item);
    for (const file of item.files ?? []) {
      const body = FILE_BODIES[file.path] ?? `/* ${file.path} */\n`;
      const path = join(root, dirName, name, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body, "utf-8");
    }
  }
  return root;
}

const DEFAULT_TEST_PATHS = {
  blocks: "compositions",
  components: "compositions/components",
  assets: "assets",
};

function writeRegistryConfig(
  dir: string,
  paths: typeof DEFAULT_TEST_PATHS = DEFAULT_TEST_PATHS,
): void {
  writeFileSync(
    join(dir, "hyperframes.json"),
    JSON.stringify({
      registryDir: writeRegistryTree(dir),
      paths,
    }),
    "utf-8",
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("add command pure helpers", () => {
  describe("remapTarget", () => {
    const PATHS = { blocks: "src/scenes", components: "src/fx" };

    it("rewrites block default path to paths.blocks", () => {
      expect(remapTarget(BLOCK_ITEM, "compositions/my-block.html", PATHS)).toBe(
        "src/scenes/my-block.html",
      );
    });

    it("rewrites component default path to paths.components", () => {
      expect(
        remapTarget(
          COMPONENT_ITEM,
          "compositions/components/my-component/my-component.html",
          PATHS,
        ),
      ).toBe("src/fx/my-component/my-component.html");
    });

    it("leaves example targets alone", () => {
      expect(remapTarget(EXAMPLE_ITEM, "index.html", PATHS)).toBe("index.html");
    });

    it("leaves non-default block paths alone (no blind string replace)", () => {
      // A block's manifest could in future use a non-default target — make
      // sure the prefix match is anchored.
      expect(remapTarget(BLOCK_ITEM, "elsewhere/my-block.html", PATHS)).toBe(
        "elsewhere/my-block.html",
      );
    });
  });

  describe("buildSnippet", () => {
    it("wraps blocks in a div with data-composition-src and duration", () => {
      const snip = buildSnippet(BLOCK_ITEM, "src/scenes/my-block.html");
      expect(snip).toContain('data-composition-src="src/scenes/my-block.html"');
      expect(snip).toContain('data-duration="6"');
    });

    it("reads a composition's root id, inside its <template> when it has one", () => {
      expect(compositionRootId(`<div data-composition-id="plain" data-width="1"></div>`)).toBe(
        "plain",
      );
      expect(
        compositionRootId(
          `<html><head><template id="t"><div data-composition-id="templated"></div></template></head><body></body></html>`,
        ),
      ).toBe("templated");
      expect(compositionRootId(`<div>no root</div>`)).toBeUndefined();
    });

    it("gives the block host the composition id that check requires", async () => {
      const snip = buildSnippet(BLOCK_ITEM, "compositions/my-block.html", null, "my-block-root");
      const html = `<!doctype html><html><body><div data-composition-id="root" data-width="1080" data-height="1350">${snip}</div></body></html>`;
      const { findings } = await lintHyperframeHtml(html);
      expect(findings.map((f) => f.code)).not.toContain("host_missing_composition_id");
      expect(snip).toContain('data-composition-id="my-block-root"');
    });

    it("emits a paste hint for components", () => {
      const snip = buildSnippet(COMPONENT_ITEM, "src/fx/my-component/my-component.html");
      expect(snip).toContain("paste from");
      expect(snip).toContain("my-component.html");
    });

    it("returns empty string for examples", () => {
      expect(buildSnippet(EXAMPLE_ITEM, "index.html")).toBe("");
    });
  });
});

describe("runAdd (integration, mocked registry)", () => {
  it("installs a block into the default compositions/ path and returns the snippet", async () => {
    const dir = tmp();
    try {
      // Write hyperframes.json so runAdd uses our fixture registry tree.
      writeRegistryConfig(dir);

      const result = await runAdd({ name: "my-block", projectDir: dir, skipClipboard: true });
      expect(result.ok).toBe(true);
      expect(result.name).toBe("my-block");
      expect(result.type).toBe("hyperframes:block");
      expect(result.written).toHaveLength(1);
      expect(result.installed).toEqual(["my-block"]);
      expect(result.warnings).toEqual([]);
      expect(existsSync(join(dir, "compositions/my-block.html"))).toBe(true);
      const installed = readFileSync(join(dir, "compositions/my-block.html"), "utf-8");
      expect(installed).toContain("<!-- hyperframes-registry-item: my-block -->");
      expect(installed).toContain('data-composition-id="my-block-root"');
      expect(result.snippet).toContain("compositions/my-block.html");
      expect(result.snippet).toContain('data-composition-id="my-block-root"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a warning for deprecated registry items while still installing", async () => {
    const dir = tmp();
    try {
      writeRegistryConfig(dir);

      const result = await runAdd({
        name: "deprecated-block",
        projectDir: dir,
        skipClipboard: true,
      });
      expect(result.warnings).toEqual([
        'Registry item "deprecated-block" is deprecated: Use `my-block` instead.',
      ]);
      expect(existsSync(join(dir, "compositions/deprecated-block.html"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks registry items that require a newer CLI before writing files", async () => {
    const dir = tmp();
    try {
      writeRegistryConfig(dir);

      await expect(
        runAdd({
          name: "future-block",
          projectDir: dir,
          skipClipboard: true,
          cliVersion: "0.6.79",
        }),
      ).rejects.toMatchObject({
        code: "incompatible-cli",
      });
      expect(existsSync(join(dir, "compositions/future-block.html"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("remaps component snippet/style targets while leaving asset targets stable", async () => {
    const dir = tmp();
    try {
      writeRegistryConfig(dir, { blocks: "compositions", components: "src/fx", assets: "assets" });

      const result = await runAdd({
        name: "my-component",
        projectDir: dir,
        skipClipboard: true,
      });
      expect(result.written.length).toBe(3);
      expect(existsSync(join(dir, "src/fx/my-component/my-component.html"))).toBe(true);
      expect(existsSync(join(dir, "src/fx/my-component/my-component.css"))).toBe(true);
      expect(existsSync(join(dir, "assets/my-component/mask.png"))).toBe(true);
      expect(result.snippet).toContain("src/fx/my-component/my-component.html");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a wrong-typed --vars before writing any item in the plan", async () => {
    const dir = tmp();
    try {
      writeRegistryConfig(dir);
      await expect(
        runAdd({ name: "dep-block", projectDir: dir, skipClipboard: true, vars: '{"maths":1}' }),
      ).rejects.toThrow(/maths: expected boolean, got number/);
      expect(existsSync(join(dir, "compositions/components/base-component"))).toBe(false);
      expect(existsSync(join(dir, "hyperframes.lock.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs transitive registryDependencies before the requested item", async () => {
    const dir = tmp();
    try {
      writeRegistryConfig(dir);

      const result = await runAdd({ name: "dep-block", projectDir: dir, skipClipboard: true });
      expect(result.name).toBe("dep-block");
      // Dependency first, requested item last.
      expect(result.installed).toEqual(["base-component", "dep-block"]);
      expect(result.written).toHaveLength(2);
      expect(
        existsSync(join(dir, "compositions/components/base-component/base-component.css")),
      ).toBe(true);
      expect(existsSync(join(dir, "compositions/dep-block.html"))).toBe(true);
      // Snippet points at the requested block, not the dependency.
      expect(result.snippet).toContain("compositions/dep-block.html");
      expect(result.warnings).toEqual([
        expect.stringContaining("compositions/dep-block.html declares no data-composition-id"),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports every installed item, marking only the requested one", async () => {
    const dir = tmp();
    try {
      writeRegistryConfig(dir);

      await runAdd({ name: "dep-block", projectDir: dir, skipClipboard: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws AddError with code 'example-type' when asked to add an example", async () => {
    const dir = tmp();
    try {
      writeRegistryConfig(dir);

      await expect(
        runAdd({ name: "my-example", projectDir: dir, skipClipboard: true }),
      ).rejects.toMatchObject({
        code: "example-type",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws AddError with code 'unknown-item' for a missing name", async () => {
    const dir = tmp();
    try {
      writeRegistryConfig(dir);

      await expect(
        runAdd({ name: "nope", projectDir: dir, skipClipboard: true }),
      ).rejects.toBeInstanceOf(AddError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("variable values in the snippet", () => {
  const block = {
    name: "split-flap-board",
    type: "hyperframes:block",
    duration: 3.5,
    dimensions: { width: 1920, height: 1080 },
  } as unknown as RegistryItem;

  it("leaves the snippet alone when no values are passed", () => {
    const snippet = buildSnippet(block, "compositions/split-flap-board.html");
    expect(snippet).not.toContain("data-variable-values");
  });

  it("carries values tuned on the catalog page", () => {
    const snippet = buildSnippet(block, "compositions/split-flap-board.html", {
      boardText: "GATE 42",
      cellCount: 16,
    });
    expect(snippet).toContain(`data-variable-values='{"boardText":"GATE 42","cellCount":16}'`);
  });

  it("escapes a single quote rather than letting it close the attribute", () => {
    const snippet = buildSnippet(block, "x.html", { boardText: "IT'S BOARDING" });
    expect(snippet).toContain("&#39;");
    expect(snippet.match(/data-variable-values='/g)?.length).toBe(1);
  });

  it("treats an empty object as nothing to say", () => {
    expect(buildSnippet(block, "x.html", {})).not.toContain("data-variable-values");
  });

  it("rejects --vars that is not a JSON object", () => {
    expect(() => parseVariableValues("not json")).toThrow(/JSON object/);
    expect(() => parseVariableValues("[1,2]")).toThrow(/JSON object/);
    expect(parseVariableValues(undefined)).toBeNull();
  });
});

describe("describeInstallFailure", () => {
  it("names the failing file read instead of echoing it", () => {
    const message = describeInstallFailure(new Error("fetch failed"));

    expect(message).toContain("could not read the item's files");
    expect(message).toContain("fetch failed");
  });

  it("names the project's own registry directory when one is set", () => {
    const message = describeInstallFailure(new Error("fetch failed"), "/private/registry");

    expect(message).toContain("/private/registry");
    expect(message).toContain("not the bundled registry");
  });

  it("stays quiet about the registry when none is set", () => {
    const message = describeInstallFailure(new Error("fetch failed"));

    expect(message).not.toContain("not the bundled registry");
  });

  it("wraps any failure with the install context", () => {
    const message = describeInstallFailure(new Error('Unsafe target "../x"'));

    expect(message).toBe(
      'Install failed: could not read the item\'s files.\n  Unsafe target "../x"',
    );
  });
});

describe("tagAddJson", () => {
  it("carries every installed item's warnings", () => {
    const result = (name: string, warnings: string[]) => ({ name, warnings }) as RunAddResult;
    expect(tagAddJson("lower-thirds", [result("a", []), result("b", ["no id"])])).toEqual({
      ok: true,
      tag: "lower-thirds",
      installed: ["a", "b"],
      warnings: ["b: no id"],
    });
  });
});
