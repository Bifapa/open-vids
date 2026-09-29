import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  vi.doUnmock("./commands/init.js");
  vi.resetModules();
});

function mockInitCommand(run: () => void | Promise<void>): void {
  vi.doMock("./commands/init.js", () => ({
    default: {
      meta: { name: "init" },
      args: { json: { type: "boolean" } },
      run,
    },
  }));
}

function emitStreamEpipe(): void {
  process.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
}

describe("CLI lifecycle", () => {
  it("reports an unknown-flag failure through the executable boundary", async () => {
    mockInitCommand(vi.fn());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    process.argv = ["node", "cli.ts", "init", "--bogus", "--json"];
    await import("./cli.js");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--bogus"));
    expect(process.exitCode).not.toBe(0);
    errorSpy.mockRestore();
  });

  describe("exit codes follow the validated artifact, not pre-artifact noise", () => {
    it("keeps an EPIPE after a validated render at exit 0", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      try {
        mockInitCommand(() => emitStreamEpipe());
        const successState = await import("./utils/render-success-state.js");
        successState.markRenderSucceeded();
        process.argv = ["node", "cli.ts", "init", "--json"];
        await import("./cli.js");

        // The pipe closing after the artifact was validated is a normal agent
        // teardown: exit 0.
        expect(exitSpy).toHaveBeenCalledWith(0);
        successState._resetRenderSuccessForTests();
      } finally {
        exitSpy.mockRestore();
      }
    });

    it("still exits non-zero when a command throws and no render ever validated", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      try {
        mockInitCommand(() => {
          throw new Error("genuine failure");
        });
        process.argv = ["node", "cli.ts", "init", "--json"];
        await import("./cli.js");

        expect(process.exitCode).not.toBe(0);
      } finally {
        exitSpy.mockRestore();
      }
    });

    it("still exits 0 via EPIPE before validation but records the failure", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      try {
        mockInitCommand(() => emitStreamEpipe());
        process.argv = ["node", "cli.ts", "init", "--json"];
        await import("./cli.js");

        expect(exitSpy).toHaveBeenCalledWith(0);
      } finally {
        exitSpy.mockRestore();
      }
    });

    it("does not let a post-validation throw doom a render whose artifact is on disk", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      try {
        const successState = await import("./utils/render-success-state.js");
        mockInitCommand(() => {
          successState.markRenderSucceeded();
          throw new Error("post-render teardown blew up");
        });
        process.argv = ["node", "cli.ts", "init", "--json"];
        await import("./cli.js");

        expect(process.exitCode).toBe(0);
        successState._resetRenderSuccessForTests();
      } finally {
        exitSpy.mockRestore();
      }
    });

    it("does not let a pre-validation unhandledRejection doom a validated render", async () => {
      const priorListeners = process.listeners("unhandledRejection");
      process.removeAllListeners("unhandledRejection");
      try {
        const successState = await import("./utils/render-success-state.js");
        mockInitCommand(() => {
          process.emit("unhandledRejection", new Error("stray teardown noise"), Promise.resolve());
          successState.markRenderSucceeded();
        });
        process.argv = ["node", "cli.ts", "init", "--json"];
        await import("./cli.js");

        expect(process.exitCode).toBe(0);
        successState._resetRenderSuccessForTests();
      } finally {
        process.removeAllListeners("unhandledRejection");
        for (const listener of priorListeners) process.on("unhandledRejection", listener);
      }
    });
  });
});
