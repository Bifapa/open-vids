import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LockBusyError, takeLock, withLock } from "./processLock.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lockFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ov-process-lock-"));
  dirs.push(dir);
  return join(dir, "sub", "owner.pid");
}

describe("takeLock", () => {
  it("is held by one taker at a time, names its pid, and is free again after release", async () => {
    const file = lockFile();
    const release = await takeLock(file, 0);
    expect(readFileSync(file, "utf8")).toMatch(new RegExp(`^${process.pid}\\b`));
    await expect(takeLock(file, 0)).rejects.toBeInstanceOf(LockBusyError);
    release();
    release();
    (await takeLock(file, 0))();
  });

  it("waits for a holder that lets go within the wait", async () => {
    const file = lockFile();
    const release = await takeLock(file, 0);
    setTimeout(release, 80);
    (await takeLock(file, 2_000, 10))();
  });

  it("takes over the lock of a process that died, and respects one that still runs", async () => {
    const file = lockFile();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error("no child pid");
      const release = await takeLock(file, 0);
      release();
      // A lock of a live foreign process (no start recorded: alive is enough) keeps this one out.
      writeFileSync(file, String(pid));
      await expect(takeLock(file, 0)).rejects.toMatchObject({ pid });
      child.kill();
      await new Promise((done) => child.once("exit", done));
      (await takeLock(file, 2_000))();
    } finally {
      child.kill();
    }
  });
});

describe("withLock", () => {
  it("runs critical sections one after another and releases on failure", async () => {
    const file = lockFile();
    const order: string[] = [];
    const section = (name: string) =>
      withLock(file, 5_000, async () => {
        order.push(`${name}:in`);
        await new Promise((done) => setTimeout(done, 20));
        order.push(`${name}:out`);
      });
    await Promise.all([section("a"), section("b"), section("c")]);
    for (let index = 0; index < order.length; index += 2) {
      expect(order[index]?.endsWith(":in")).toBe(true);
      expect(order[index + 1]).toBe(order[index]?.replace(":in", ":out"));
    }
    await expect(withLock(file, 0, () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(await withLock(file, 0, async () => "free")).toBe("free");
  });
});
