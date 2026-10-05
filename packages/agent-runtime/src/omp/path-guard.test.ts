import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  guardToolCallPaths,
  projectRelativeTargets,
  resolveProjectFileTargets,
} from "./path-guard.ts";

let tempRoot: string;
let projectDir: string;
let secret: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "omp-path-guard-"));
  projectDir = path.join(tempRoot, "project");
  const outsideDir = path.join(tempRoot, "outside");
  await mkdir(path.join(projectDir, "src"), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  secret = path.join(outsideDir, "secret.txt");
  await writeFile(secret, "secret");
  await writeFile(path.join(projectDir, "src", "a.html"), "<div></div>");
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function inputFor(tool: string, target: string): Record<string, unknown> {
  if (tool === "edit") return { path: target, old_string: "a", new_string: "b" };
  if (tool === "write") return { path: target, content: "x" };
  return { path: target };
}

const TOOLS = ["read", "write", "edit", "grep", "find"];

describe("path spellings OMP's file tools normalize before acting", () => {
  it("refuses every spelling that resolves outside the project, for every file tool", async () => {
    const relativeSecret = path.relative(projectDir, secret);
    const spellings = [
      `@${secret}`,
      `:${secret}`,
      `[${secret}]`,
      `[${secret}#ABCD]`,
      `:[${secret}]`,
      `:${relativeSecret}`,
      `[${relativeSecret}]`,
      `[${relativeSecret}#ABCD]`,
      `"${relativeSecret}"`,
      `"${secret}"`,
      `@${relativeSecret.split(path.sep).join("/")}`,
      "~/openvids-guard-test/x",
      "~openvids-guard-test/x",
      "~",
    ];
    for (const spelling of spellings) {
      for (const tool of TOOLS) {
        const reason = await guardToolCallPaths(projectDir, inputFor(tool, spelling), tool);
        expect(reason, `${tool} ${spelling}`).not.toBeNull();
      }
    }
  });

  it("allows the same spellings when they stay inside the project", async () => {
    for (const spelling of [
      "src/a.html",
      "./src/a.html",
      ":./src/a.html",
      "[src/a.html]",
      "[src/a.html#ABCD]",
      "@src/a.html",
      `@${path.join(projectDir, "src", "a.html")}`,
      `:${path.join(projectDir, "src", "a.html")}`,
      `[${path.join(projectDir, "src", "a.html")}]`,
      '"src/a.html"',
    ]) {
      for (const tool of TOOLS) {
        expect(
          await guardToolCallPaths(projectDir, inputFor(tool, spelling), tool),
          `${tool} ${spelling}`,
        ).toBeNull();
      }
    }
  });

  it("keeps the private state directory closed under every spelling", async () => {
    for (const spelling of [
      ".hyperframes/agent",
      ":./.hyperframes/agent",
      "[.hyperframes/agent]",
      "@.hyperframes/agent",
    ]) {
      expect(await guardToolCallPaths(projectDir, { path: spelling }, "read"), spelling).toContain(
        ".hyperframes",
      );
    }
  });

  it("shows the file a spelling really names in the transcript", () => {
    expect(projectRelativeTargets(projectDir, { path: "[src/a.html#ABCD]" })).toEqual([
      "src/a.html",
    ]);
    expect(projectRelativeTargets(projectDir, { path: ":./src/a.html" })).toEqual(["src/a.html"]);
    expect(projectRelativeTargets(projectDir, { path: `[${secret}]` })).toEqual([]);
  });
});

describe("URL reads", () => {
  it("refuses every URL spelling OMP's read fetches, not only scheme://", async () => {
    for (const target of [
      "http://127.0.0.1:1/x",
      "https://example.com/a.mp4",
      "http:/127.0.0.1:1/x",
      "HTTPS:/example.com/x",
      "www.example.com",
      "www.example.com/a.mp4:1-5",
      '"http:/127.0.0.1:1/x"',
      "file:///etc/hosts",
      "agent://0",
    ]) {
      const reason = await guardToolCallPaths(projectDir, { path: target }, "read");
      expect(reason, target).toContain("URLs");
    }
  });

  it("does not mistake project files for URLs", async () => {
    for (const target of ["http.html", "wwwroot/a.html", "src/www.example.com.txt"]) {
      expect(await guardToolCallPaths(projectDir, { path: target }, "read"), target).toBeNull();
    }
  });
});

describe("lock-guard targets", () => {
  it("resolves the same spellings the tools do", async () => {
    await writeFile(path.join(projectDir, "index.html"), "<div></div>");
    const expected = path.join(await realpath(projectDir), "index.html");
    for (const spelling of [
      "index.html",
      "[index.html]",
      "[index.html#ABCD]",
      ":./index.html",
      "@index.html",
      `@${path.join(projectDir, "index.html")}`,
    ]) {
      const targets = await resolveProjectFileTargets(projectDir, { path: spelling });
      expect(targets, spelling).toContain(expected);
    }
  });
});
