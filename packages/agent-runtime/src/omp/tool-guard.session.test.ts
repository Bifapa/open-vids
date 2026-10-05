import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface Outcome {
  ok: boolean;
  text?: string;
  error?: string;
}

interface Probe {
  refusedWrite: Outcome;
  refusedFileExists: boolean;
  refusedEdit: Outcome;
  notesAfterRefusal: string;
  readWhileRefusing: Outcome;
  escape: Outcome;
  escapeFileExists: boolean;
  allowedWrite: Outcome;
  allowedFileExists: boolean;
  visionWrite: Outcome;
  visionFileExists: boolean;
  visionRead: Outcome;
  skillsRead: Outcome;
  skillsWrite: Outcome;
  skillsWriteExists: boolean;
  skillsEdit: Outcome;
  skillsAfterEdit: string;
  outsideRead: Outcome;
  hasSkillsNote: boolean;
  intentArgument: boolean;
  leasedWrite: Outcome;
  leasedExists: boolean;
  freeWrite: Outcome;
  textWrite: Outcome;
  claims: string[][];
}

function runProbe(): Probe {
  const script = fileURLToPath(new URL("./tool-guard.probe.ts", import.meta.url));
  return JSON.parse(execFileSync("bun", [script], { encoding: "utf8", timeout: 90_000 }));
}

describe("the tool_call guard of a real OMP session (run under Bun, no model)", () => {
  const probe = runProbe();

  it("refuses the project's own file tools while the turn forbids changes, and touches nothing", () => {
    expect(probe.refusedWrite).toEqual({ ok: false, error: "Ask turn: no file changes" });
    expect(probe.refusedEdit).toEqual({ ok: false, error: "Ask turn: no file changes" });
    expect(probe.refusedFileExists).toBe(false);
    expect(probe.notesAfterRefusal).toBe("hello\n");
  });

  it("keeps reads working during a refusing turn", () => {
    expect(probe.readWhileRefusing).toMatchObject({ ok: true, text: "hello" });
  });

  it("still blocks a write outside the project when the turn refuses nothing", () => {
    expect(probe.escape.ok).toBe(false);
    expect(probe.escape.error).toContain("resolves outside this project");
    expect(probe.escapeFileExists).toBe(false);
  });

  it("lets an in-project write run once the turn allows changes", () => {
    expect(probe.allowedWrite.ok).toBe(true);
    expect(probe.allowedFileExists).toBe(true);
  });

  it("keeps Vision read-only even when the turn allows changes", () => {
    expect(probe.visionWrite.ok).toBe(false);
    expect(JSON.stringify(probe.visionWrite)).toContain("Vision is read-only");
    expect(probe.visionFileExists).toBe(false);
    expect(probe.visionRead).toMatchObject({ ok: true, text: "hello" });
  });

  it("lets agents read the bundled skills but never change them or anything else outside the project", () => {
    expect(probe.skillsRead).toMatchObject({ ok: true });
    expect(JSON.stringify(probe.skillsRead)).toContain("the skill");
    expect(probe.skillsWrite.ok).toBe(false);
    expect(probe.skillsWriteExists).toBe(false);
    expect(probe.skillsEdit.ok).toBe(false);
    expect(probe.skillsAfterEdit).toBe("# the skill\n");
    expect(probe.outsideRead.ok).toBe(false);
    expect(probe.hasSkillsNote).toBe(true);
  });

  it("does not add the SDK's `i` intent argument to tools, which models glued onto tool names", () => {
    expect(probe.intentArgument).toBe(false);
  });

  it("asks the write lease before a composition file is written, and only for those", () => {
    expect(probe.leasedWrite.ok).toBe(false);
    expect(JSON.stringify(probe.leasedWrite)).toContain("held by the Motion Designer run");
    expect(probe.leasedExists).toBe(false);
    expect(probe.freeWrite.ok).toBe(true);
    expect(probe.textWrite.ok).toBe(true);
    expect(probe.claims).toEqual([["index.html"], ["free.html"]]);
  });
});
