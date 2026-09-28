/**
 * The production Studio backend entry point.
 *
 * Runs HyperFrames' embedded Studio server and guarantees it does not outlive
 * OpenVids.
 *
 * Why this exists rather than spawning `cli.js` directly: on macOS an
 * ad-hoc-signed Tauri app cannot signal processes it spawned. Measured on
 * darwin-arm64 — `libc::killpg(pgid, SIGTERM)` and `/bin/kill -TERM -<pgid>`
 * both return EPERM from inside the running .app, while the same signals from an
 * ordinary shell succeed. The app's own `Drop` therefore cannot reap what it
 * spawned, and a Studio server would survive Cmd+Q holding a loopback port.
 *
 * A plain process has no such restriction, so the watch lives here. This
 * process records OpenVids' pid, and while `process.kill(pid, 0)` — a
 * permission probe, not a signal — keeps succeeding the server is healthy. When
 * it starts failing, OpenVids is gone and the server is killed outright.
 *
 * Everything else — argument handling, the port, the lifecycle line on stdout —
 * is the CLI's own. This launcher only wraps it and guarantees teardown.
 *
 * Usage: serve.mjs <cli.js> <preview args...>
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [, , cliPath, ...args] = process.argv;
if (!cliPath) {
  process.stderr.write("[openvids:serve] usage: serve.mjs <cli.js> <args...>\n");
  process.exit(2);
}

// `process.ppid` is OpenVids, recorded before spawning so a reparent can never
// be mistaken for the original parent.
const owner = process.ppid;
const cli = cliPath.startsWith("/")
  ? cliPath
  : join(dirname(fileURLToPath(import.meta.url)), cliPath);

const child = spawn(process.execPath, [cli, ...args], {
  stdio: ["ignore", "inherit", "inherit"],
});

let escalation = null;

function stop(initial) {
  if (escalation !== null) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(initial);
  // Not unref'd on purpose: the launcher must outlive the shutdown it started.
  // An exit that races the escalation leaves the server running unsupervised.
  escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3000);
}

// OpenVids is gone, so there is nothing left to be graceful *for*: the server
// holds a loopback port and may have Chrome running, and neither should
// outlive the app that owns it.
const watch = setInterval(() => {
  try {
    process.kill(owner, 0);
  } catch {
    process.stderr.write(`[openvids:serve] OpenVids (pid ${owner}) is gone; stopping Studio\n`);
    stop("SIGKILL");
  }
}, 1000);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => stop("SIGTERM"));
}

child.on("exit", (code, signal) => {
  clearInterval(watch);
  clearTimeout(escalation);
  process.exit(signal ? 1 : (code ?? 0));
});
