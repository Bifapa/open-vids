import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnP, synthResult } from "./tts.mjs";

// spawnP takes an injectable spawnFn so this doesn't need to mock
// node:child_process (whose ESM exports are non-configurable).
function fakeSpawn(captured, event = ["exit", 0]) {
  return (cmd, args, opts) => {
    captured.push({ cmd, args, opts });
    const p = new EventEmitter();
    setImmediate(() => p.emit(...event));
    return p;
  };
}

test("spawnP runs the command directly with argv data and no shell", async () => {
  const captured = [];
  const result = await spawnP(
    "hyperframes",
    ["tts", "C:\\Users\\Test User\\line.txt", "hello & calc"],
    { cwd: "/project" },
    fakeSpawn(captured),
  );
  assert.equal(result.status, 0);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].cmd, "hyperframes");
  assert.deepEqual(captured[0].args, ["tts", "C:\\Users\\Test User\\line.txt", "hello & calc"]);
  assert.equal(captured[0].opts.cwd, "/project");
  assert.equal(captured[0].opts.stdio, "ignore");
  assert.equal(captured[0].opts.shell, undefined);
});

test("spawnP resolves with the spawn error when the command cannot start", async () => {
  const error = Object.assign(new Error("spawn hyperframes ENOENT"), { code: "ENOENT" });
  const result = await spawnP("hyperframes", ["tts"], {}, fakeSpawn([], ["error", error]));
  assert.equal(result.status, -1);
  assert.equal(result.error, error);
});

test("synthResult names a command that could not start", () => {
  const error = new Error("spawn hyperframes ENOENT");
  const res = synthResult({ status: -1, error }, "/tmp/none.wav", "kokoro (hyperframes tts)");
  assert.equal(res.ok, false);
  assert.match(res.error, /kokoro \(hyperframes tts\) could not start: spawn hyperframes ENOENT/);
});
