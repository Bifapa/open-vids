/**
 * Opens a real OMP session through `OmpBackend.openSession` (no model answers) and steers it in the window where its
 * prompt has started but is not running yet (the model is still being set). Only Bun can load OMP;
 * `session-steer.test.ts` starts this file with `bun` and checks the printed outcome.
 *
 * Usage: bun session-steer.probe.ts
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOmpBackend } from "./index.ts";

const root = await mkdtemp(path.join(tmpdir(), "ov-session-steer-"));
const projectDir = path.join(root, "project");
const agentDir = path.join(root, "agent");
await mkdir(projectDir);
await mkdir(agentDir);

const backend = createOmpBackend({ agentDir });
try {
  const adapter = await backend.openSession({
    chatId: "probe",
    agent: "director",
    projectDir,
    stateDir: null,
    instructions: "probe",
    hostTools: [],
    credentials: { provider: "anthropic", apiKey: "sk-probe-not-a-real-key" },
  });
  const idle = await adapter.steer("before any prompt").then(
    () => "accepted",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  const controller = new AbortController();
  const prompt = adapter
    .prompt({
      text: "hello",
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      thinking: null,
      signal: controller.signal,
      onEvent: () => undefined,
    })
    .then(
      (outcome) => outcome,
      (error: unknown) => `threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  // The prompt is in its start-up (model being set): the session cannot take a steer yet.
  const starting = await adapter.steer("while the prompt starts").then(
    () => "accepted",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  controller.abort();
  const outcome = await prompt;
  process.stdout.write(JSON.stringify({ idle, starting, outcome }));
  await adapter.dispose();
} finally {
  await backend.dispose().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
