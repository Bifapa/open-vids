import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const taskkill = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawnSync: taskkill,
}));

import { runCli } from "./cliChild.js";

const PID = 4242;
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: PID,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return { child, spawn: vi.fn(() => child) };
}

const invocation = () => ({ command: "/usr/bin/runtime", prefix: ["/cli/cli.js"] });

afterEach(() => {
  if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
  taskkill.mockClear();
  vi.restoreAllMocks();
});

describe("runCli abort", () => {
  it("kills the Windows process tree once, while the handle is live, not again by a pid that may be reused", async () => {
    setPlatform("win32");
    const { child, spawn } = fakeChild();
    const controller = new AbortController();
    const run = runCli(
      ["transcribe"],
      { signal: controller.signal },
      {
        spawn: spawn as never,
        invocation,
      },
    );

    controller.abort(new Error("cancelled"));
    expect(taskkill).toHaveBeenCalledTimes(1);
    expect(taskkill).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", String(PID), "/T", "/F"],
      expect.anything(),
    );

    child.emit("close", null);
    await expect(run).rejects.toThrow("cancelled");
    expect(taskkill, "no second taskkill after close").toHaveBeenCalledTimes(1);
  });

  it("still sweeps the process group after the CLI closed on POSIX", async () => {
    setPlatform("linux");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { child, spawn } = fakeChild();
    const controller = new AbortController();
    const run = runCli(
      ["transcribe"],
      { signal: controller.signal },
      {
        spawn: spawn as never,
        invocation,
      },
    );

    controller.abort(new Error("cancelled"));
    child.emit("close", null);
    await expect(run).rejects.toThrow("cancelled");

    expect(kill.mock.calls).toEqual([
      [-PID, "SIGTERM"],
      [-PID, "SIGKILL"],
    ]);
    expect(taskkill).not.toHaveBeenCalled();
  });
});
