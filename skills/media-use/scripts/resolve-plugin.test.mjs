import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test(
  "standalone resolver runs the hyperframes command from PATH without a repository checkout",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "hf-resolve-standalone-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const scripts = join(dir, "skills/media-use/scripts");
    mkdirSync(scripts, { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("resolve.mjs", import.meta.url)),
      join(scripts, "resolve.mjs"),
    );
    writeFileSync(
      join(dir, "hyperframes"),
      `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),skip:process.env.HYPERFRAMES_SKIP_SKILLS}));process.exit(7);`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [join(scripts, "resolve.mjs"), "--intent", "a & b"],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH}`,
          HYPERFRAMES_SKIP_SKILLS: "1",
        },
      },
    );
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["media-use", "resolve", "--intent", "a & b"],
      skip: "1",
    });
  },
);

test("standalone resolver explains a missing hyperframes command", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hf-resolve-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = join(dir, "skills/media-use/scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("resolve.mjs", import.meta.url)),
    join(scripts, "resolve.mjs"),
  );
  const result = spawnSync(process.execPath, [join(scripts, "resolve.mjs")], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /`hyperframes` was not found on PATH/);
});

test("a contributor checkout keeps using its local CLI build", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hf-resolve-local-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "skills/media-use/scripts");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, "packages/cli/dist"), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("resolve.mjs", import.meta.url)),
    join(scripts, "resolve.mjs"),
  );
  writeFileSync(join(root, "packages/cli/dist/cli.js"), 'console.log("local-cli");');
  const result = spawnSync(process.execPath, [join(scripts, "resolve.mjs")], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "local-cli");
});
