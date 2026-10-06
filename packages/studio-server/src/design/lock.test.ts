// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processStartKey } from "../history/ownerLock.js";
import { isDesignFailure } from "./errors.js";
import { withLibraryLock } from "./lock.js";
import { makeTempDir } from "./testSupport.js";

let root: string;
let cleanup: () => void;
beforeEach(() => {
  const temp = makeTempDir("openvids-design-lock-");
  root = join(temp.dir, "library");
  cleanup = temp.cleanup;
});
afterEach(() => cleanup());

// A live owner is waited for in real time: the lock polls the platform clock, so the busy cases use short real waits.
describe("withLibraryLock", () => {
  it("runs concurrent writers one at a time, in order", async () => {
    const events: string[] = [];
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let started: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = withLibraryLock(root, async () => {
      events.push("a start");
      started();
      await gate;
      events.push("a end");
      return "a";
    });
    const rest = ["b", "c"].map((name) =>
      withLibraryLock(root, () => {
        events.push(`${name} start`);
        return name;
      }),
    );
    await firstStarted;
    await new Promise((settle) => setImmediate(settle));
    expect(events).toEqual(["a start"]); // the others wait for the lock
    open();
    expect(await Promise.all([first, ...rest])).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["a start", "a end", "b start", "c start"]);
    expect(existsSync(join(root, ".lock"))).toBe(false);
  });

  it("releases the lock when the work throws", async () => {
    await expect(
      withLibraryLock(root, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(join(root, ".lock"))).toBe(false);
    expect(await withLibraryLock(root, () => "next")).toBe("next");
  });

  it("evicts the lock of an owner that no longer runs", async () => {
    const finished = spawnSync(process.execPath, [
      "-e",
      "process.stdout.write(String(process.pid))",
    ]);
    const deadPid = Number(finished.stdout.toString());
    await withLibraryLock(root, () => undefined); // creates the folder
    writeFileSync(join(root, ".lock"), String(deadPid));
    expect(await withLibraryLock(root, () => "took over", 1_000)).toBe("took over");
  });

  it("evicts the lock of a pid that was reused by another process", async () => {
    await withLibraryLock(root, () => undefined);
    writeFileSync(join(root, ".lock"), `${process.pid} Thu Jan  1 00:00:00 1970`);
    expect(await withLibraryLock(root, () => "took over", 1_000)).toBe("took over");
  });

  it("waits for a live owner and fails busy when it does not let go", async () => {
    await withLibraryLock(root, () => undefined);
    const start = await processStartKey(process.pid);
    writeFileSync(
      join(root, ".lock"),
      start === null ? String(process.pid) : `${process.pid} ${start}`,
    );
    const started = Date.now();
    const failure = await withLibraryLock(root, () => "never", 200).catch(
      (error: unknown) => error,
    );
    expect(isDesignFailure(failure) && failure.error.code).toBe("busy");
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(existsSync(join(root, ".lock"))).toBe(true);
  });

  it("survives a SIGKILLed owner: waits while it lives, takes over once it is gone", async () => {
    await withLibraryLock(root, () => undefined);
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      if (owner.pid === undefined) throw new Error("the owner did not start");
      const start = await processStartKey(owner.pid);
      writeFileSync(
        join(root, ".lock"),
        start === null ? String(owner.pid) : `${owner.pid} ${start}`,
      );
      const busy = await withLibraryLock(root, () => "never", 150).catch((error: unknown) => error);
      expect(isDesignFailure(busy) && busy.error.code).toBe("busy");

      const exited = new Promise((settle) => owner.once("exit", settle));
      owner.kill("SIGKILL");
      await exited;
      expect(await withLibraryLock(root, () => "took over", 2_000)).toBe("took over");
    } finally {
      owner.kill("SIGKILL");
    }
  });
});
