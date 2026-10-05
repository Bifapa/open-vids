/**
 * Opens a real OMP session through `OmpBackend.openSession` (no model is ever called) and invokes the session's own
 * tools as OMP tool calls, so the project guard's `tool_call` hook runs exactly as it does in a turn. Only Bun can
 * load OMP; `tool-guard.session.test.ts` starts this file with `bun` and checks the printed outcomes.
 *
 * Usage: bun tool-guard.probe.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createOmpBackend } from "./index.ts";

type Outcome = { ok: true; text: string } | { ok: false; error: string };

const root = await mkdtemp(path.join(tmpdir(), "ov-tool-guard-"));
const projectDir = path.join(root, "project");
const agentDir = path.join(root, "agent");
await mkdir(projectDir);
await mkdir(agentDir);
await writeFile(path.join(projectDir, "notes.txt"), "hello\n");

let refusing = true;
const backend = createOmpBackend({ agentDir });
try {
  const adapter = await backend.openSession({
    chatId: "probe",
    agent: "director",
    projectDir,
    stateDir: null,
    instructions: "probe",
    hostTools: [],
    // A Plan or Ask turn: nothing may write while `refusing` is on.
    fileWriteRefusal: (toolName) =>
      refusing && (toolName === "write" || toolName === "edit")
        ? "Ask turn: no file changes"
        : null,
  });
  // The adapter keeps its OMP session private; the probe needs the session's wrapped tools.
  const candidate: unknown = Reflect.get(adapter, "session");
  if (!(candidate instanceof AgentSession)) throw new Error("the adapter has no OMP session");
  const session = candidate;

  async function call(tool: string, params: Record<string, unknown>): Promise<Outcome> {
    const target = session.getToolByName(tool);
    if (!target) return { ok: false, error: `no tool ${tool}` };
    try {
      const result = await target.execute(`call-${Math.random()}`, params);
      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      return { ok: true, text };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const written = path.join(projectDir, "written.txt");
  const refusedWrite = await call("write", { path: "written.txt", content: "x" });
  const refusedFileExists = await Bun.file(written).exists();
  const refusedEdit = await call("edit", {
    path: "notes.txt",
    old_string: "hello",
    new_string: "bye",
  });
  const notesAfterRefusal = await readFile(path.join(projectDir, "notes.txt"), "utf8");
  const readWhileRefusing = await call("read", { path: "notes.txt" });

  refusing = false;
  const escape = await call("write", { path: "../escape.txt", content: "x" });
  const escapeFileExists = await Bun.file(path.join(root, "escape.txt")).exists();
  const allowedWrite = await call("write", { path: "written.txt", content: "x" });
  const allowedFileExists = await Bun.file(written).exists();

  process.stdout.write(
    JSON.stringify({
      refusedWrite,
      refusedFileExists,
      refusedEdit,
      notesAfterRefusal,
      readWhileRefusing,
      escape,
      escapeFileExists,
      allowedWrite,
      allowedFileExists,
    }),
  );
  await adapter.dispose();
} finally {
  await backend.dispose().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
