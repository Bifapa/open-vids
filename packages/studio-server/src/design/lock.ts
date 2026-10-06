import { join } from "node:path";
import { takeOwnerLock } from "../history/ownerLock.js";
import { DesignFailure } from "./errors.js";

const DEFAULT_WAIT_MS = 15_000;

/** Callers of one root in this process, in order: the file lock then only ever arbitrates between processes. */
const queues = new Map<string, Promise<void>>();

/**
 * Runs `work` as the only writer of the library at `root`, across processes: the owner lock `<root>/.lock` (a pid and
 * its process start, claimed by hard link; the protocol of the project history's owner lock). A live owner is waited
 * for up to `waitMs`, then the call fails `busy`; a dead owner's lock (a crash, a SIGKILL) is evicted, so no cleanup
 * handler is needed. Callers in this process go one at a time, first come first served.
 */
export async function withLibraryLock<T>(
  root: string,
  work: () => Promise<T> | T,
  waitMs: number = DEFAULT_WAIT_MS,
): Promise<T> {
  const previous = queues.get(root) ?? Promise.resolve();
  let done: () => void = () => undefined;
  const turn = new Promise<void>((resolve) => {
    done = resolve;
  });
  const queued = previous.then(() => turn);
  queues.set(root, queued);
  await previous;
  try {
    const release = await takeOwnerLock(
      join(root, ".lock"),
      waitMs,
      (pid) =>
        new DesignFailure(
          "busy",
          `The design library is being written by another process (pid ${pid}). Try again in a moment.`,
        ),
    );
    try {
      return await work();
    } finally {
      release();
    }
  } finally {
    done();
    if (queues.get(root) === queued) queues.delete(root);
  }
}
