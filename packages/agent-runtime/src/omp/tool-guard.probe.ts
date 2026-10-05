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

async function callTool(
  session: AgentSession,
  tool: string,
  params: Record<string, unknown>,
): Promise<Outcome> {
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

function sessionOf(adapter: object): AgentSession {
  const candidate: unknown = Reflect.get(adapter, "session");
  if (!(candidate instanceof AgentSession)) throw new Error("the adapter has no OMP session");
  return candidate;
}

const root = await mkdtemp(path.join(tmpdir(), "ov-tool-guard-"));
const projectDir = path.join(root, "project");
const agentDir = path.join(root, "agent");
await mkdir(projectDir);
await mkdir(agentDir);
await writeFile(path.join(projectDir, "notes.txt"), "hello\n");

// The bundled skills tree, wherever it lives (source checkout or packaged app), is found through this override.
const skillsDir = path.join(root, "skills");
await mkdir(path.join(skillsDir, "hyperframes"), { recursive: true });
await writeFile(path.join(skillsDir, "hyperframes", "SKILL.md"), "# the skill\n");
process.env.OPENVIDS_SKILLS_DIR = skillsDir;

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
  const session = sessionOf(adapter);

  const call = (tool: string, params: Record<string, unknown>) => callTool(session, tool, params);

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

  // Vision is read-only whatever the turn allows; the bundled skills are readable but never writable.
  const vision = await backend.openSession({
    chatId: "probe",
    agent: "vision",
    projectDir,
    stateDir: null,
    instructions: "probe",
    hostTools: [],
  });
  const visionSession = sessionOf(vision);
  const visionWrite = await callTool(visionSession, "write", { path: "v.txt", content: "x" });
  const visionFileExists = await Bun.file(path.join(projectDir, "v.txt")).exists();
  const visionRead = await callTool(visionSession, "read", { path: "notes.txt" });
  const skillsRead = await callTool(visionSession, "read", {
    path: path.join(skillsDir, "hyperframes", "SKILL.md"),
  });
  const skillsWrite = await callTool(session, "write", {
    path: path.join(skillsDir, "hyperframes", "new.md"),
    content: "x",
  });
  const skillsWriteExists = await Bun.file(path.join(skillsDir, "hyperframes", "new.md")).exists();
  const skillsEdit = await callTool(session, "edit", {
    path: path.join(skillsDir, "hyperframes", "SKILL.md"),
    old_string: "the skill",
    new_string: "changed",
  });
  const skillsAfterEdit = await readFile(path.join(skillsDir, "hyperframes", "SKILL.md"), "utf8");
  const outsideRead = await callTool(visionSession, "read", { path: path.join(root, "agent") });
  const hasSkillsNote = visionSession.systemPrompt.join("\n").includes(skillsDir);
  const readParameters = visionSession.getToolByName("read")?.parameters;
  const intentArgument =
    typeof readParameters === "object" &&
    readParameters !== null &&
    "properties" in readParameters &&
    typeof readParameters.properties === "object" &&
    readParameters.properties !== null &&
    "i" in readParameters.properties;
  await vision.dispose();

  // A composition file goes through the write lease; other files do not.
  const claims: string[][] = [];
  const editor = await backend.openSession({
    chatId: "probe",
    agent: "editor",
    projectDir,
    stateDir: null,
    instructions: "probe",
    hostTools: [],
    claimWriteFiles: (files) => {
      claims.push(files);
      return files.includes("index.html") ? "index.html is held by the Motion Designer run" : null;
    },
  });
  const editorSession = sessionOf(editor);
  const leasedWrite = await callTool(editorSession, "write", {
    path: "index.html",
    content: "<p>",
  });
  const leasedExists = await Bun.file(path.join(projectDir, "index.html")).exists();
  const freeWrite = await callTool(editorSession, "write", { path: "free.html", content: "<p>" });
  const textWrite = await callTool(editorSession, "write", { path: "plain.txt", content: "x" });
  await editor.dispose();

  process.stdout.write(
    JSON.stringify({
      visionWrite,
      visionFileExists,
      visionRead,
      skillsRead,
      skillsWrite,
      skillsWriteExists,
      skillsEdit,
      skillsAfterEdit,
      outsideRead,
      hasSkillsNote,
      intentArgument,
      leasedWrite,
      leasedExists,
      freeWrite,
      textWrite,
      claims,
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
