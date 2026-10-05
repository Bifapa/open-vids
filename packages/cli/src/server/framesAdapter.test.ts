import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, type Mock } from "vitest";
import { captureFramesViaCli } from "./framesAdapter.js";

interface Script {
  /** Files the CLI writes into its `--out` directory. */
  files?: Record<string, string>;
  report?: (outDir: string) => Record<string, unknown>;
  stderr?: string;
  code?: number;
  hang?: boolean;
}

interface FakeSpawn {
  spawn: Mock<(command: string, args: string[]) => EventEmitter>;
  calls: string[][];
  children: EventEmitter[];
  outDir(): string;
}

/** A spawn that plays `script` instead of running the CLI, writing files where `--out` points. */
function fakeSpawn(script: Script): FakeSpawn {
  const calls: string[][] = [];
  const children: EventEmitter[] = [];
  let outDir = "";
  const spawn = vi.fn((_command: string, args: string[]) => {
    calls.push(args);
    outDir = args[args.indexOf("--out") + 1] ?? "";
    const child = Object.assign(new EventEmitter(), {
      pid: 7373,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        setImmediate(() => child.emit("close", null));
        return true;
      }),
    });
    setImmediate(() => {
      for (const [name, content] of Object.entries(script.files ?? {})) {
        writeFileSync(join(outDir, name), content);
      }
      if (script.stderr) child.stderr.write(script.stderr);
      if (script.report) child.stdout.write(`${JSON.stringify(script.report(outDir))}\n`);
      if (!script.hang) setImmediate(() => child.emit("close", script.code ?? 0));
    });
    children.push(child);
    return child;
  });
  return { spawn, calls, children, outDir: () => outDir };
}

const deps = (fake: FakeSpawn) => ({
  spawn: fake.spawn as never,
  invocation: () => ({ command: "/usr/bin/runtime", prefix: ["/cli/cli.js"] }),
});

const input = (signal = new AbortController().signal) => ({
  project: { dir: "/projects/demo" },
  composition: "compositions/intro.html",
  times: [1, 2.5],
  width: 480,
  signal,
});

const okReport = (outDir: string) => ({
  ok: true,
  duration: 8,
  frames: [
    { requested: 1, time: 1, file: join(outDir, "a.jpg"), width: 480, height: 270 },
    { requested: 2.5, time: 2.5, file: join(outDir, "b.jpg"), width: 480, height: 270 },
  ],
});

describe("captureFramesViaCli", () => {
  it("runs `frames` with the times, width and composition, returns the JPEG bytes and removes its folder", async () => {
    const fake = fakeSpawn({ files: { "a.jpg": "AAA", "b.jpg": "BBB" }, report: okReport });
    const result = await captureFramesViaCli(input(), deps(fake));
    expect(fake.calls[0]?.slice(0, 4)).toEqual(["/cli/cli.js", "frames", "/projects/demo", "--at"]);
    expect(fake.calls[0]).toEqual(
      expect.arrayContaining([
        "1,2.5",
        "--width",
        "480",
        "--composition",
        "compositions/intro.html",
        "--json",
      ]),
    );
    if ("unavailable" in result) throw new Error("expected frames");
    expect(result.duration).toBe(8);
    expect(result.frames.map((frame) => [frame.time, Buffer.from(frame.data).toString()])).toEqual([
      [1, "AAA"],
      [2.5, "BBB"],
    ]);
    expect(existsSync(fake.outDir())).toBe(false);
  });

  it("says unavailable only when Chrome is unavailable; a failed capture and a crash throw", async () => {
    const refused = fakeSpawn({
      report: () => ({ ok: false, code: "unavailable", error: "Chrome is not installed" }),
      code: 1,
    });
    expect(await captureFramesViaCli(input(), deps(refused))).toEqual({
      unavailable: "Chrome is not installed",
    });
    const failed = fakeSpawn({
      report: () => ({ ok: false, code: "capture_failed", error: "Navigation timed out" }),
      code: 1,
    });
    await expect(captureFramesViaCli(input(), deps(failed))).rejects.toThrow(
      "Navigation timed out",
    );
    const crashed = fakeSpawn({ code: 3, stderr: "out of memory\n" });
    await expect(captureFramesViaCli(input(), deps(crashed))).rejects.toThrow(
      /frames exited with code 3: out of memory/,
    );
  });

  it("refuses a frame file outside its folder", async () => {
    const escaping = fakeSpawn({
      report: () => ({
        ok: true,
        duration: 1,
        frames: [{ requested: 1, time: 1, file: "/etc/hosts", width: 1, height: 1 }],
      }),
    });
    await expect(captureFramesViaCli(input(), deps(escaping))).rejects.toThrow(/escapes/);
    expect(existsSync(escaping.outDir())).toBe(false);
  });

  it("kills the child's group on abort and still removes the folder", async () => {
    const hanging = fakeSpawn({ hang: true });
    const signals: Array<[number, unknown]> = [];
    vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      signals.push([pid, sig]);
      if (sig === "SIGTERM") setImmediate(() => hanging.children[0]?.emit("close", null));
      return true;
    });
    const abort = new AbortController();
    const pending = captureFramesViaCli(input(abort.signal), deps(hanging));
    await vi.waitFor(() => expect(hanging.spawn).toHaveBeenCalled());
    abort.abort(new Error("client went away"));
    await expect(pending).rejects.toThrow("client went away");
    if (process.platform !== "win32") expect(signals[0]).toEqual([-7373, "SIGTERM"]);
    expect(existsSync(hanging.outDir())).toBe(false);
    vi.restoreAllMocks();
  });
});
