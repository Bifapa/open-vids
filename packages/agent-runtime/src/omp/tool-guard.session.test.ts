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
});
