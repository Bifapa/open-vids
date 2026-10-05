import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { invocation } from "./plugin-cli.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hf-plugin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launcher = join(root, "plugin-cli.mjs");
  copyFileSync(new URL("./plugin-cli.mjs", import.meta.url), launcher);
  return { root, launcher };
}

test("runs the bare hyperframes command, suppresses standalone refresh, preserves environment", () => {
  const result = invocation(["init", "project with spaces", "--non-interactive"], {
    env: { PATH: "/bin", HYPERFRAMES_SKIP_SKILLS: "0" },
  });
  assert.equal(result.command, "hyperframes");
  assert.deepEqual(result.args, ["init", "project with spaces", "--non-interactive"]);
  assert.deepEqual(result.env, {
    PATH: "/bin",
    HYPERFRAMES_SKIP_SKILLS: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
  });
  assert.throws(() => invocation(["skills", "update"]), /plugin manager/);
});

test("--script runs the given Node script and requires a path", () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`;
  const result = invocation(["--script", "helper.mjs", "a & b"], { env: {}, node });
  assert.equal(result.command, node);
  assert.deepEqual(result.args, ["helper.mjs", "a & b"]);
  assert.throws(() => invocation(["--script"]), /requires a Node script path/);
});

test(
  "launcher keeps cwd, arguments, environment and exit code of the PATH command",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const { root, launcher } = fixture(t);
    const project = join(root, "user project");
    mkdirSync(project);
    writeFileSync(
      join(root, "hyperframes"),
      `#!${process.execPath}\nconsole.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), skip: process.env.HYPERFRAMES_SKIP_SKILLS }));process.exit(7);`,
      { mode: 0o755 },
    );
    const result = spawnSync(process.execPath, [launcher, "render", "literal $value & spaces"], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      cwd: realpathSync(project),
      args: ["render", "literal $value & spaces"],
      skip: "1",
    });
  },
);

test("launcher reports a missing hyperframes command", (t) => {
  const { launcher } = fixture(t);
  const result = spawnSync(process.execPath, [launcher, "--help"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not found on PATH/);
});

test("--script keeps cwd, arguments, environment and exit code", (t) => {
  const { root, launcher } = fixture(t);
  const project = join(root, "user project");
  mkdirSync(project);
  const helper = join(root, "helper.mjs");
  writeFileSync(
    helper,
    "console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), skip: process.env.HYPERFRAMES_SKIP_SKILLS })); process.exit(7);",
  );
  const result = spawnSync(
    process.execPath,
    [launcher, "--script", helper, "literal $value & spaces"],
    { cwd: project, encoding: "utf8" },
  );
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: realpathSync(project),
    args: ["literal $value & spaces"],
    skip: "1",
  });
});
