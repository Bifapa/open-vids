import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectToolCallGuard } from "./tool-guard.ts";

let projectDir = "";

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "ov-tool-guard-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("the turn's refusal in the tool_call guard", () => {
  it("blocks an in-project write the turn does not allow, with the turn's own reason", async () => {
    const guard = projectToolCallGuard(projectDir, (toolName) =>
      toolName === "write" || toolName === "edit" ? "Ask turn: no file changes" : null,
    );
    const input = { path: "notes.txt", content: "x" };
    expect(await guard({ toolName: "write", input })).toEqual({
      block: true,
      reason: "Ask turn: no file changes",
    });
    expect(await guard({ toolName: "edit", input })).toMatchObject({ block: true });
    expect(await guard({ toolName: "read", input: { path: "notes.txt" } })).toBeUndefined();
  });

  it("lets the call through to the project guards when the turn refuses nothing", async () => {
    const guard = projectToolCallGuard(projectDir, () => null);
    expect(
      await guard({ toolName: "write", input: { path: "notes.txt", content: "x" } }),
    ).toBeUndefined();
    expect(
      (await guard({ toolName: "write", input: { path: "../escape.txt", content: "x" } }))?.reason,
    ).toContain("resolves outside this project");
  });
});

describe("the write notice of the tool_call guard", () => {
  const write = { path: "index.html", content: "<div></div>" };

  it("is given only after every check let the write through", async () => {
    const noted: string[] = [];
    const options = { noteFileWrite: (toolName: string) => void noted.push(toolName) };

    const asking = projectToolCallGuard(projectDir, () => "Ask turn: no file changes", undefined, {
      ...options,
      agent: "editor",
    });
    expect(await asking({ toolName: "write", input: write })).toMatchObject({ block: true });

    const vision = projectToolCallGuard(projectDir, () => null, undefined, {
      ...options,
      agent: "vision",
    });
    expect(await vision({ toolName: "write", input: write })).toMatchObject({ block: true });

    const outside = projectToolCallGuard(projectDir, () => null, undefined, options);
    expect(
      await outside({ toolName: "write", input: { path: "../escape.txt", content: "x" } }),
    ).toMatchObject({ block: true });

    const leased = projectToolCallGuard(projectDir, () => null, undefined, {
      ...options,
      claimWriteFiles: () => "held by another run",
    });
    expect(await leased({ toolName: "write", input: write })).toMatchObject({
      block: true,
      reason: "held by another run",
    });
    expect(noted).toEqual([]);

    const open = projectToolCallGuard(projectDir, () => null, undefined, {
      ...options,
      claimWriteFiles: () => null,
    });
    expect(await open({ toolName: "write", input: write })).toBeUndefined();
    expect(await open({ toolName: "read", input: { path: "index.html" } })).toBeUndefined();
    expect(noted).toEqual(["write"]);
  });
});
