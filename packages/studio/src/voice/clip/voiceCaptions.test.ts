// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceClipDeps } from "./voiceClipOps";
import { addVoiceCaptions } from "./voiceCaptions";

const files = new Map<string, string>([["index.html", "<main>before</main>"]]);

function deps(overrides: Partial<VoiceClipDeps> = {}) {
  const recordEdit = vi.fn(async () => undefined);
  const value: VoiceClipDeps = {
    projectId: "p1",
    activeCompPath: "index.html",
    elements: () => [],
    rippleEnabled: () => true,
    playhead: () => 0,
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error("missing");
      return content;
    },
    writeProjectFile: vi.fn(async () => undefined),
    recordEdit,
    pendingEditPaths: new Set<string>(),
    groupMove: vi.fn(async () => undefined),
    setElements: vi.fn(),
    refreshPreview: vi.fn(),
    previewDocument: () => null,
    findNode: () => null,
    reveal: vi.fn(),
    blockedReason: () => null,
    ...overrides,
  };
  return { value, recordEdit };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  files.clear();
  files.set("index.html", "<main>before</main>");
});

describe("addVoiceCaptions", () => {
  it("plans with a dry run, applies for real, and records every changed file as one undo entry", async () => {
    const requests: Array<{
      url: string;
      body: { dryRun?: boolean; composition?: string; operations: unknown[] };
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        requests.push({ url, body });
        if (body.dryRun !== true) {
          // The server writes: the composition changes and the captions file appears.
          files.set("index.html", "<main>after</main>");
          files.set("compositions/captions.html", "<captions/>");
        }
        return json({
          changedFiles: ["index.html", "compositions/captions.html"],
          warnings: ["one clip skipped"],
        });
      }),
    );
    const { value, recordEdit } = deps();
    const report = await addVoiceCaptions(value);
    expect(report).toEqual({ kind: "added", files: 2, skipped: 1 });
    expect(requests.map((request) => request.body.dryRun === true)).toEqual([true, false]);
    expect(requests[0]?.url).toBe("/api/projects/p1/editing/apply");
    expect(requests[1]?.body).toMatchObject({
      composition: "index.html",
      operations: [{ op: "captions_from_voiceover" }],
    });
    expect(recordEdit).toHaveBeenCalledTimes(1);
    expect(recordEdit.mock.calls[0]?.[0]).toMatchObject({
      files: {
        "index.html": { before: "<main>before</main>", after: "<main>after</main>" },
        // A file the write created had no content before.
        "compositions/captions.html": { before: "", after: "<captions/>" },
      },
    });
  });

  it("refuses while an agent turn runs and writes nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { value, recordEdit } = deps({ blockedReason: () => "The agent is editing" });
    expect(await addVoiceCaptions(value)).toEqual({
      kind: "failed",
      message: "The agent is editing",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(recordEdit).not.toHaveBeenCalled();
  });

  it("reports the editing service's refusal and records nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            error: {
              code: "unsupported",
              message: "No clip on this timeline speaks a voiceover line",
            },
          },
          400,
        ),
      ),
    );
    const { value, recordEdit } = deps();
    expect(await addVoiceCaptions(value)).toEqual({
      kind: "failed",
      message: "No clip on this timeline speaks a voiceover line",
    });
    expect(recordEdit).not.toHaveBeenCalled();
  });
});
