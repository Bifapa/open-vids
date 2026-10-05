import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectPackageLicenses,
  licenseLabel,
  renderThirdPartyNotices,
  stageLicenses,
} from "../apps/desktop/scripts/licenses.mjs";

function writePackage(modulesDir, name, manifest, files = {}) {
  const dir = join(modulesDir, ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
}

describe("licenseLabel", () => {
  it("reads the string, object and legacy array forms", () => {
    assert.equal(licenseLabel({ license: "MIT" }), "MIT");
    assert.equal(licenseLabel({ license: { type: "ISC" } }), "ISC");
    assert.equal(
      licenseLabel({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
      "MIT OR Apache-2.0",
    );
    assert.equal(licenseLabel({}), "no license declared");
  });
});

describe("third-party notices", () => {
  it("lists scoped and nested packages and prints identical texts once", () => {
    const root = mkdtempSync(join(tmpdir(), "ov-licenses-"));
    try {
      const modules = join(root, "node_modules");
      writePackage(modules, "a", { version: "1.0.0", license: "MIT" }, { LICENSE: "MIT text\n" });
      writePackage(
        modules,
        "@s/b",
        { version: "2.0.0", license: "MIT" },
        { "LICENSE.md": "MIT text" },
      );
      writePackage(modules, "bare", { version: "0.1.0", license: "LGPL-3.0-or-later" });
      writePackage(
        join(modules, "a", "node_modules"),
        "nested",
        { version: "3.0.0" },
        { NOTICE: "n" },
      );

      const packages = collectPackageLicenses(modules);
      assert.deepEqual(
        packages.map((pkg) => `${pkg.name}@${pkg.version}`),
        ["@s/b@2.0.0", "a@1.0.0", "bare@0.1.0", "nested@3.0.0"],
      );

      const text = renderThirdPartyNotices(packages);
      assert.equal(text.split("MIT text").length - 1, 1);
      assert.match(text, /Carried by: @s\/b@2\.0\.0, a@1\.0\.0/);
      assert.match(text, /bare@0\.1\.0 {2}LGPL-3\.0-or-later/);
      assert.match(text, /Packages that ship no license file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("stageLicenses", () => {
  it("copies the root files and kept texts and writes the generated notice", () => {
    const root = mkdtempSync(join(tmpdir(), "ov-licenses-"));
    try {
      const repo = join(root, "repo");
      const kept = join(root, "kept");
      const tree = join(root, "runtime", "hyperframes");
      mkdirSync(repo, { recursive: true });
      mkdirSync(kept, { recursive: true });
      for (const name of ["LICENSE", "NOTICE", "CREDITS.md"]) writeFileSync(join(repo, name), name);
      writeFileSync(join(kept, "bun-LICENSE.md"), "bun");
      writePackage(
        join(tree, "node_modules"),
        "a",
        { version: "1.0.0", license: "MIT" },
        { LICENSE: "x" },
      );

      const result = stageLicenses({
        runtimeDir: join(root, "runtime"),
        repoRoot: repo,
        keptDir: kept,
        treeDirs: [tree, join(root, "runtime", "missing")],
      });
      assert.equal(result.packages, 1);
      for (const name of [
        "LICENSE",
        "NOTICE",
        "CREDITS.md",
        "bun-LICENSE.md",
        "THIRD_PARTY_NOTICES.txt",
      ]) {
        assert.ok(existsSync(join(result.directory, name)), name);
      }
      assert.match(
        readFileSync(join(result.directory, "THIRD_PARTY_NOTICES.txt"), "utf8"),
        /a@1\.0\.0 {2}MIT/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to stage without the repository license files", () => {
    const root = mkdtempSync(join(tmpdir(), "ov-licenses-"));
    try {
      mkdirSync(join(root, "kept"), { recursive: true });
      writeFileSync(join(root, "kept", "x"), "x");
      assert.throws(
        () =>
          stageLicenses({
            runtimeDir: root,
            repoRoot: join(root, "none"),
            keptDir: join(root, "kept"),
            treeDirs: [],
          }),
        /ships with the app/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
