import { serve } from "@hono/node-server";
import { AGENT_PROTOCOL_VERSION } from "@hyperframes/agent-protocol";
import { createOmpBackend } from "./omp/index.ts";
import { HttpCheckpointHost } from "./checkpointHost.http.js";
import { HttpEditingHost } from "./editing/host.http.js";
import { createRuntimeApp } from "./server.js";
import { AgentSettingsStore } from "./settings.js";

const token = process.env.OPENVIDS_AGENT_TOKEN;
if (!token) throw new Error("OPENVIDS_AGENT_TOKEN is required");
const port = parsePort(process.env.OPENVIDS_AGENT_PORT);
const parentPid = parseParentPid(process.env.OPENVIDS_AGENT_PARENT_PID);
const app = createRuntimeApp({
  backend: createOmpBackend(),
  checkpoints: new HttpCheckpointHost(),
  editing: (scope) => new HttpEditingHost(scope),
  settings: new AgentSettingsStore(),
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

let shutdownPromise: Promise<void> | null = null;
let parentPoll: NodeJS.Timeout | undefined;
const shutdown = (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    clearInterval(parentPoll);
    parentPoll = undefined;
    server.close();
    await app.dispose();
    if ("closeAllConnections" in server && typeof server.closeAllConnections === "function")
      server.closeAllConnections();
  })();
  return shutdownPromise;
};

const handleSignal = () => {
  void shutdown().catch((error: unknown) => {
    process.stderr.write(`OpenVids Agent Runtime shutdown failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
};
process.once("SIGTERM", handleSignal);
process.once("SIGINT", handleSignal);

if (parentPid !== null) {
  parentPoll = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if (isProcessGone(error)) handleSignal();
    }
  }, 1_000);
}

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

function isProcessGone(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
