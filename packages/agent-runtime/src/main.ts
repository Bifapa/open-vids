import { join } from "node:path";
import { serve } from "@hono/node-server";
import { AGENT_PROTOCOL_VERSION } from "@hyperframes/agent-protocol";
import { createOmpBackend } from "./omp/index.ts";
import { HttpCheckpointHost } from "./checkpointHost.http.js";
import { HttpAnalysisHost } from "./analysis/host.http.js";
import { HttpEditingHost } from "./editing/host.http.js";
import { HttpStoryHost } from "./story/host.http.js";
import { HttpResearchHost } from "./research/host.http.js";
import { HttpQaHost } from "./qa/host.http.js";
import { createShutdown, watchParent } from "./lifecycle.js";
import { createRuntimeApp } from "./server.js";
import { AgentSettingsStore } from "./settings.js";

const token = process.env.OPENVIDS_AGENT_TOKEN;
if (!token) throw new Error("OPENVIDS_AGENT_TOKEN is required");
const port = parsePort(process.env.OPENVIDS_AGENT_PORT);
const parentPid = parseParentPid(process.env.OPENVIDS_AGENT_PARENT_PID);
const settings = new AgentSettingsStore();
const app = createRuntimeApp({
  // Provider keys the user entered in OpenVids are read on use, so a key saved by another runtime process applies here too.
  backend: createOmpBackend({
    providerKeys: () => settings.providerApiKeys(),
    // Sign-ins made in the app are stored (and refreshed) here, never in OMP's database.
    authDbPath: join(settings.dir, "auth.db"),
  }),
  checkpoints: new HttpCheckpointHost(),
  editing: (scope) => new HttpEditingHost(scope),
  analysis: (scope) => new HttpAnalysisHost(scope),
  story: (scope) => new HttpStoryHost(scope),
  research: (scope) => new HttpResearchHost(scope),
  qa: (scope) => new HttpQaHost(scope),
  settings,
  token,
});

const server = serve(
  {
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port,
  },
  (address) => {
    process.stdout.write(
      `${JSON.stringify({ "openvids-agent": "listening", port: address.port, protocolVersion: AGENT_PROTOCOL_VERSION })}\n`,
    );
  },
);

/** Longest the graceful stop may take: past it the process ends, so no orphan keeps its tools and the chat log. */
const SHUTDOWN_DEADLINE_MS = 5_000;

let stopParentWatch: (() => void) | undefined;
const shutdown = createShutdown({
  stop: async () => {
    server.close();
    try {
      await app.dispose();
    } finally {
      // A throwing dispose must not leave keep-alive connections holding the server open.
      if ("closeAllConnections" in server && typeof server.closeAllConnections === "function")
        server.closeAllConnections();
    }
  },
  deadlineMs: SHUTDOWN_DEADLINE_MS,
  onDeadline: (stage) =>
    process.stderr.write(
      stage === "stopping"
        ? `OpenVids Agent Runtime did not shut down within ${SHUTDOWN_DEADLINE_MS} ms; exiting\n`
        : `OpenVids Agent Runtime is still running ${SHUTDOWN_DEADLINE_MS} ms after its shutdown (${stage}); exiting\n`,
    ),
  exit: (code) => process.exit(code),
});

const handleSignal = () => {
  void shutdown()
    .catch((error: unknown) => {
      process.stderr.write(`OpenVids Agent Runtime shutdown failed: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    })
    // The parent watch keeps running through the shutdown and only stops once it is over.
    .finally(() => stopParentWatch?.());
};
process.once("SIGTERM", handleSignal);
process.once("SIGINT", handleSignal);

if (parentPid !== null) stopParentWatch = watchParent(parentPid, handleSignal, 1_000);

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  const portValue = Number(value);
  if (!Number.isInteger(portValue) || portValue < 0 || portValue > 65_535) {
    throw new Error("OPENVIDS_AGENT_PORT must be an integer between 0 and 65535");
  }
  return portValue;
}

function parseParentPid(value: string | undefined): number | null {
  if (!value) return null;
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("OPENVIDS_AGENT_PARENT_PID must be a positive process id");
  return pid;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
