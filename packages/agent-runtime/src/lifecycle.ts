/**
 * Whether a failed `process.kill(pid, 0)` says the process we watch is no longer ours: `ESRCH` (gone) or `EPERM`
 * (the pid now belongs to another user's process, so the parent that spawned us was replaced).
 */
export function isParentGone(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ESRCH" || error.code === "EPERM")
  );
}

/** Calls `onGone` once per poll while the process `pid` is gone; returns the function that stops the watch. */
export function watchParent(pid: number, onGone: () => void, intervalMs: number): () => void {
  const timer = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isParentGone(error)) onGone();
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

/** Where the graceful stop stood when the deadline ran out. */
export type ShutdownStage = "stopping" | "stopped" | "failed";

export interface ShutdownOptions {
  /** The graceful part: stop accepting work and release everything. */
  stop: () => Promise<void>;
  /** How long the process may stay alive after the shutdown began before it is ended anyway. */
  deadlineMs: number;
  /** Runs when the process is still alive at the deadline, just before `exit`. */
  onDeadline: (stage: ShutdownStage) => void;
  exit: (code: number) => void;
}

/**
 * One shutdown for every trigger (signals, a dead parent): the first call starts it, later calls share it. The
 * deadline stays armed for the whole life of the process, not only while `stop` runs: a `stop` that hangs (an
 * aborting tool) or finishes and leaves a handle behind (a socket or timer OMP keeps open, a connection a failed
 * dispose never closed) still cannot keep an orphan alive. The timer is unreferenced, so when nothing else holds the
 * loop the process exits on its own at once and the deadline never delays it; it fires only while something does.
 * A deadline after a clean stop ends the process with 0, after a hang or a failed stop with 1.
 */
export function createShutdown(options: ShutdownOptions): () => Promise<void> {
  let shutdown: Promise<void> | null = null;
  return () => {
    shutdown ??= (async () => {
      let stage: ShutdownStage = "stopping";
      setTimeout(() => {
        options.onDeadline(stage);
        options.exit(stage === "stopped" ? 0 : 1);
      }, options.deadlineMs).unref();
      try {
        await options.stop();
        stage = "stopped";
      } catch (error) {
        stage = "failed";
        throw error;
      }
    })();
    return shutdown;
  };
}
