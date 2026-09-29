import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HostTool } from "../backend.ts";
import { terminalEventResult, translateOmpEvent } from "./events.ts";
import { createModelCatalog, mapModelInfo, parseModelRole } from "./model-mapping.ts";
import { guardToolCallPaths } from "./path-guard.ts";

describe("OMP model mapping", () => {
  it("maps model metadata and excludes the non-controllable off effort", () => {
    expect(
      mapModelInfo({
        provider: "anthropic",
        modelId: "claude-sonnet",
        name: "Claude Sonnet",
        reasoning: true,
        contextWindow: 200_000,
        supportedEfforts: ["off", "low", "high", "future"],
      }),
    ).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet",
      name: "Claude Sonnet",
      reasoning: true,
      efforts: ["low", "high"],
      contextWindow: 200_000,
    });
  });

  it("derives a default selection and effort only from a matching role model", () => {
    const sources = [
      {
        provider: "google",
        modelId: "gemini-pro",
        name: "Gemini Pro",
        reasoning: true,
        supportedEfforts: ["low", "high"],
      },
    ];
    expect(createModelCatalog(sources, "google/gemini-pro:high", "high")).toEqual({
      models: [
        {
          provider: "google",
          modelId: "gemini-pro",
          name: "Gemini Pro",
          reasoning: true,
          efforts: ["low", "high"],
        },
      ],
      defaultModel: { provider: "google", modelId: "gemini-pro" },
      defaultThinking: "high",
    });
    expect(createModelCatalog(sources, "google/not-listed:high", "high")).toMatchObject({
      defaultModel: null,
      defaultThinking: null,
    });
  });

  it("parses effort suffixes without guessing unsupported selector formats", () => {
    expect(parseModelRole("anthropic/claude-sonnet:medium")).toEqual({
      model: { provider: "anthropic", modelId: "claude-sonnet" },
      thinking: "medium",
    });
    expect(parseModelRole("not-a-selector")).toBeNull();
    expect(parseModelRole("anthropic/claude-sonnet:unknown")).toEqual({
      model: { provider: "anthropic", modelId: "claude-sonnet:unknown" },
      thinking: null,
    });
  });
});

describe("OMP event translation", () => {
  it("translates only user-facing deltas and normalized tool events", () => {
    const projectDir = path.resolve("/project");
    expect(
      translateOmpEvent(
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Hello" },
        },
        projectDir,
      ),
    ).toEqual({ type: "text.delta", delta: "Hello" });
    expect(
      translateOmpEvent(
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" },
        },
        projectDir,
      ),
    ).toEqual({ type: "thinking.delta", delta: "reasoning" });
    expect(
      translateOmpEvent(
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_end" },
        },
        projectDir,
      ),
    ).toEqual({ type: "thinking.end" });
    expect(
      translateOmpEvent(
        {
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "read",
          args: { path: "src/index.html" },
        },
        projectDir,
      ),
    ).toEqual({
      type: "tool.start",
      toolCallId: "call-1",
      kind: "inspect",
      targets: ["src/index.html"],
    });
    expect(
      translateOmpEvent(
        {
          type: "tool_execution_start",
          toolCallId: "call-2",
          toolName: "find",
          args: { path: "src" },
        },
        projectDir,
      ),
    ).toMatchObject({ type: "tool.start", kind: "search" });
    expect(
      translateOmpEvent(
        {
          type: "tool_execution_start",
          toolCallId: "call-3",
          toolName: "write",
          args: { path: "src/index.html" },
        },
        projectDir,
      ),
    ).toMatchObject({ type: "tool.start", kind: "edit" });
    expect(
      translateOmpEvent(
        {
          type: "tool_execution_end",
          toolCallId: "call-3",
          isError: true,
        },
        projectDir,
      ),
    ).toEqual({ type: "tool.end", toolCallId: "call-3", ok: false });
    expect(translateOmpEvent({ type: "raw_omp_internal_event" }, projectDir)).toBeNull();
  });

  it("reports host tools only when they declare an activity, with their own label", () => {
    const projectDir = path.resolve("/project");
    const execute = async () => ({ text: "" });
    const hostTools = new Map<string, HostTool>([
      [
        "edit_timeline",
        {
          name: "edit_timeline",
          description: "",
          parameters: {},
          execute,
          activity: () => ({ category: "edit", label: "Editing the timeline · 1 change (trim)" }),
        },
      ],
      ["delegate", { name: "delegate", description: "", parameters: {}, execute }],
    ]);
    const start = (toolName: string) => ({
      type: "tool_execution_start",
      toolCallId: `call-${toolName}`,
      toolName,
      args: { path: "src/index.html" },
    });
    expect(translateOmpEvent(start("edit_timeline"), projectDir, hostTools)).toEqual({
      type: "tool.start",
      toolCallId: "call-edit_timeline",
      kind: "edit",
      targets: [],
      label: "Editing the timeline · 1 change (trim)",
    });
    expect(translateOmpEvent(start("delegate"), projectDir, hostTools)).toBeNull();
  });

  it("waits for terminal completion and extracts provider errors", () => {
    expect(terminalEventResult({ type: "agent_end", isTerminal: false, messages: [] })).toBeNull();
    expect(
      terminalEventResult({
        type: "agent_end",
        messages: [
          { role: "assistant", stopReason: "error", errorMessage: "Provider denied access" },
        ],
      }),
    ).toEqual({ aborted: false, error: "Provider denied access" });
    expect(
      terminalEventResult({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "aborted" }],
      }),
    ).toEqual({ aborted: true, error: null });
  });
});

describe("OMP project path boundary", () => {
  it("allows project paths and blocks traversal, external, symlink, and private-state paths", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "omp-project-boundary-"));
    const projectDir = path.join(tempRoot, "project");
    const outsideDir = path.join(tempRoot, "outside");
    await mkdir(projectDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await mkdir(path.join(projectDir, ".hyperframes"), { recursive: true });
    await writeFile(path.join(outsideDir, "secret.txt"), "secret");
    await symlink(outsideDir, path.join(projectDir, "outside-link"), "dir");

    try {
      expect(await guardToolCallPaths(projectDir, { path: "src/index.html" })).toBeNull();
      expect(
        await guardToolCallPaths(projectDir, {
          path: path.join(projectDir, "absolute.html"),
        }),
      ).toBeNull();
      expect(await guardToolCallPaths(projectDir, { path: "../outside/secret.txt" })).toContain(
        "resolves outside this project",
      );
      expect(
        await guardToolCallPaths(projectDir, {
          path: path.join(outsideDir, "secret.txt"),
        }),
      ).toContain("resolves outside this project");
      expect(
        await guardToolCallPaths(projectDir, {
          path: "outside-link/secret.txt",
        }),
      ).toContain("resolves outside this project");
      expect(
        await guardToolCallPaths(projectDir, {
          path: ".hyperframes/agent/chats/chat/events.jsonl",
        }),
      ).toContain(".hyperframes directory");

      // read/grep/find fan one `path` string out into several targets
      for (const path of [
        "src;../outside/secret.txt",
        "src,../outside/secret.txt",
        "src ../outside/secret.txt",
        "{src,../outside}/secret.txt",
        "src/../../outside/secret.txt:1-5",
      ]) {
        expect(await guardToolCallPaths(projectDir, { path }, "read")).toContain("outside");
      }
      // real file names with spaces stay usable
      expect(await guardToolCallPaths(projectDir, { path: "my clip.mp4" }, "read")).toBeNull();
      expect(await guardToolCallPaths(projectDir, { path: "a/{b,c}.html" }, "grep")).toBeNull();

      // mutating calls fail closed when the target is not a checkable `path`
      const opaque = { input: "*** Add File: ../outside/x.txt\n+x" };
      expect(await guardToolCallPaths(projectDir, opaque, "edit")).toContain("cannot be checked");
      expect(await guardToolCallPaths(projectDir, {}, "write")).toContain("cannot be checked");
      expect(
        await guardToolCallPaths(
          projectDir,
          { path: "ok.html", input: "*** Move to: ../x" },
          "edit",
        ),
      ).toContain("cannot be checked");
      expect(
        await guardToolCallPaths(
          projectDir,
          { path: "a.html", edits: [{ op: "update", rename: "../outside/a.html" }] },
          "edit",
        ),
      ).toContain("outside");
      expect(
        await guardToolCallPaths(
          projectDir,
          { path: "a.html", old_string: "a", new_string: "b" },
          "edit",
        ),
      ).toBeNull();
      expect(
        await guardToolCallPaths(
          projectDir,
          { path: "{a,b,c,d,e,f,g,h}{a,b,c,d,e,f,g,h}{a,b,c}.txt" },
          "read",
        ),
      ).toContain("too broad");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
