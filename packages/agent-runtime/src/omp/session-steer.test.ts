import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface Probe {
  idle: string;
  starting: string;
  outcome: string;
}

function runProbe(): Probe {
  const script = fileURLToPath(new URL("./session-steer.probe.ts", import.meta.url));
  return JSON.parse(execFileSync("bun", [script], { encoding: "utf8", timeout: 90_000 }));
}

describe("steering a real OMP session (run under Bun, no model)", () => {
  const probe = runProbe();

  it("refuses a steer while the prompt is still starting, so the runtime queues it instead of losing it", () => {
    expect(probe.starting).toBe("The agent is not working on a prompt right now.");
    expect(probe.idle).toBe("The agent is not working on a prompt right now.");
  });

  it("ends the prompt it was steered during by the abort, not by a failure", () => {
    expect(probe.outcome).toBe("aborted");
  });
});
