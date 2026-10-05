import { formatWithOptions } from "node:util";

/**
 * Under Bun, `console.log` onto a pipe or file is one non-blocking write(2) once `process.stdout` has been touched
 * (the CLI always touches it: colour detection, the EPIPE listener). A payload past the pipe's 64 KiB buffer is cut
 * there, silently, and the reader sees invalid JSON. `process.stdout.write` keeps retrying until the data is out, so
 * route the console methods through it. Node, and terminals, are left alone: they write synchronously and in full.
 */
export function completeConsoleOutputUnderBun(): void {
  if (!("Bun" in globalThis)) return;
  routeThroughStream(["log", "info", "debug"], process.stdout);
  routeThroughStream(["warn", "error"], process.stderr);
}

function routeThroughStream(
  methods: readonly ("log" | "info" | "debug" | "warn" | "error")[],
  stream: NodeJS.WriteStream,
): void {
  if (stream.isTTY) return;
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      stream.write(`${formatWithOptions({}, ...args)}\n`);
    };
  }
}

/**
 * Resolves once everything written to stdout/stderr so far has reached the OS, so a following `process.exit()` cannot
 * cut it. Only Bun needs this (its pipe writes continue in the background; Node's are synchronous): it ends the two
 * streams, whose callback fires after the queued data. A reader that went away still ends the wait, with an error.
 */
export function flushStdio(): Promise<void> {
  if (!("Bun" in globalThis)) return Promise.resolve();
  const finished = (stream: NodeJS.WriteStream) =>
    stream.isTTY
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          stream.once("error", () => resolve());
          stream.once("close", () => resolve());
          stream.end(() => resolve());
        });
  return Promise.all([finished(process.stdout), finished(process.stderr)]).then(() => undefined);
}
