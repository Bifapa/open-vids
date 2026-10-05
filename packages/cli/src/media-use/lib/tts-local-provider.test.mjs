import { test } from "node:test";
import assert from "node:assert/strict";
import { cliInvocation, localTtsGenerate } from "./tts-local-provider.mjs";

// The Kokoro delegation runs the CLI that spawned the engine (execPath + its own entry, handed
// over in HYPERFRAMES_CLI_INVOCATION); PATH `hyperframes` is only the fallback. argv is data.
const NO_ENV = {};

test("runs the handed-over CLI entry with the voice option and piped stdio", async () => {
  const captured = [];
  const fakeExec = (cmd, args, opts) => {
    captured.push({ cmd, args, opts });
    // Synthesize nothing — the provider then returns null via the
    // missing-output check, which is fine: we only assert the spawn shape.
  };

  const env = { HYPERFRAMES_CLI_INVOCATION: JSON.stringify(["--import", "tsx", "/x/cli.ts"]) };
  const result = await localTtsGenerate("hello there", { voice: "am_michael" }, fakeExec, env);

  assert.equal(result, null);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].cmd, process.execPath);
  assert.deepEqual(captured[0].args.slice(0, 4), ["--import", "tsx", "/x/cli.ts", "tts"]);
  assert.equal(captured[0].args[4], "hello there");
  assert.ok(captured[0].args.includes("--voice"));
  // Pipes are what let the caller read the "kokoro-onnx not installed" hint back out.
  assert.deepEqual(captured[0].opts.stdio, ["ignore", "pipe", "pipe"]);
});

test("adds --lang for non-English voices", async () => {
  const captured = [];
  const fakeExec = (cmd, args) => captured.push({ cmd, args });

  await localTtsGenerate("hola", { lang: "es" }, fakeExec, NO_ENV);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].cmd, "hyperframes");
  assert.deepEqual(captured[0].args.slice(0, 2), ["tts", "hola"]);
  assert.ok(captured[0].args.includes("--lang"));
});

test("falls back to `hyperframes` on PATH when no entry was handed over", async () => {
  const captured = [];
  const fakeExec = (cmd, args) => captured.push({ cmd, args });

  await localTtsGenerate("hi", {}, fakeExec, NO_ENV);

  assert.equal(captured[0].cmd, "hyperframes");
  assert.equal(captured[0].args[0], "tts");
});

test("a malformed or empty hand-over is ignored", () => {
  for (const value of ["not json", "[]", "[1]", '"x"', "null"]) {
    assert.deepEqual(cliInvocation({ HYPERFRAMES_CLI_INVOCATION: value }), {
      cmd: "hyperframes",
      prefix: [],
    });
  }
});

test("a failing CLI falls through to the next provider (null)", async () => {
  const fakeExec = () => {
    throw Object.assign(new Error("spawnSync hyperframes ENOENT"), { code: "ENOENT" });
  };

  assert.equal(await localTtsGenerate("hello", {}, fakeExec, NO_ENV), null);
});
