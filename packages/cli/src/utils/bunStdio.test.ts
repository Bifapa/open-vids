import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE = fileURLToPath(new URL("./bunStdio.ts", import.meta.url));
const PAYLOAD_BYTES = 300_000;

/** Runs `body` in a Bun process whose stdout and stderr are pipes, as under the Studio server or an agent. */
function runUnderBun(body: string) {
  const program = `
    import { completeConsoleOutputUnderBun, flushStdio } from ${JSON.stringify(MODULE)};
    process.stdout.on("error", () => {});
    ${body}
  `;
  return spawnSync("bun", ["-e", program], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

describe("completeConsoleOutputUnderBun", () => {
  it("delivers a large console.log whole, then exits by an explicit process.exit", () => {
    const run = runUnderBun(`
      completeConsoleOutputUnderBun();
      console.log(JSON.stringify({ blob: "x".repeat(${PAYLOAD_BYTES}) }));
      console.error("e".repeat(${PAYLOAD_BYTES}));
      await flushStdio();
      process.exit(3);
    `);
    expect(run.status).toBe(3);
    expect(JSON.parse(run.stdout)).toEqual({ blob: "x".repeat(PAYLOAD_BYTES) });
    expect(run.stderr.trimEnd()).toBe("e".repeat(PAYLOAD_BYTES));
  });

  it("formats like console.log", () => {
    const run = runUnderBun(`
      completeConsoleOutputUnderBun();
      console.log("%s has %d items", "list", 3, { a: [1, 2] });
    `);
    expect(run.stdout).toBe("list has 3 items { a: [ 1, 2 ] }\n");
  });
});
