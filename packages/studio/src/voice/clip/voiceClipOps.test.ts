// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import type { VoiceTake } from "@hyperframes/agent-protocol";
import type { TimelineElement } from "../../player";
import { applyVoiceTakes, type VoiceClipDeps } from "./voiceClipOps";

const SOURCE = `<div data-composition-id="main" data-duration="8">
<audio id="a" data-hf-id="hf-a" class="clip" src="assets/voice/old.wav" data-start="0" data-duration="3" data-track-index="2" data-ov-voice-line="l1"></audio>
<audio id="b" data-hf-id="hf-b" class="clip" src="assets/voice/b.wav" data-start="3" data-duration="2" data-track-index="2"></audio>
</div>`;

const TAKE: VoiceTake = {
  id: "t2",
  file: "assets/voice/new.wav",
  start: 0,
  end: 4.5,
  speakerText: "x",
  style: "",
  presetId: "p",
  model: "m",
  voiceId: "Kore",
  requestHash: "h",
  scene: null,
  usdCost: null,
  createdAt: 1,
  createdBy: { agent: "user", turnId: null },
};

function element(
  id: string,
  start: number,
  duration: number,
  extra: Partial<TimelineElement> = {},
) {
  return {
    id,
    key: id,
    domId: id,
    hfId: `hf-${id}`,
    tag: "audio",
    start,
    duration,
    track: 2,
    authoredTrack: 2,
    sourceFile: "index.html",
    ...extra,
  } satisfies TimelineElement;
}

function deps(overrides: Partial<VoiceClipDeps> = {}) {
  const elements = [element("a", 0, 3, { voiceLine: "l1" }), element("b", 3, 2)];
  const recordEdit = vi.fn(async () => undefined);
  const groupMove = vi.fn(async () => undefined);
  const writeProjectFile = vi.fn(async () => undefined);
  const value: VoiceClipDeps = {
    projectId: "p1",
    activeCompPath: "index.html",
    elements: () => elements,
    rippleEnabled: () => true,
    playhead: () => 0,
    readFile: async () => SOURCE,
    writeProjectFile,
    recordEdit,
    pendingEditPaths: new Set<string>(),
    groupMove,
    setElements: vi.fn(),
    refreshPreview: vi.fn(),
    previewDocument: () => null,
    findNode: () => null,
    reveal: vi.fn(),
    blockedReason: () => null,
    ...overrides,
  };
  return { value, recordEdit, groupMove, writeProjectFile };
}

describe("applyVoiceTakes", () => {
  it("writes the clip once and folds the ripple into the same undo entry", async () => {
    const { value, recordEdit, groupMove, writeProjectFile } = deps();
    const report = await applyVoiceTakes(value, [{ lineId: "l1", take: TAKE }]);
    expect(report).toMatchObject({ updated: 1, shifted: 1, failure: null });
    expect(writeProjectFile).toHaveBeenCalledTimes(1);
    const entry = recordEdit.mock.calls[0]?.[0];
    expect(entry?.files["index.html"]?.after).toContain('src="assets/voice/new.wav"');
    expect(entry?.files["index.html"]?.after).toMatch(/id="a"[^>]*data-duration="4.5"/);
    const [changes, options] = groupMove.mock.calls[0]!;
    expect(changes.map((change) => [change.element.id, change.start])).toEqual([["b", 4.5]]);
    expect(options).toMatchObject({ coalesceKey: entry?.coalesceKey, label: entry?.label });
  });

  it("changes only the clip when ripple is off", async () => {
    const { value, groupMove } = deps({ rippleEnabled: () => false });
    const report = await applyVoiceTakes(value, [{ lineId: "l1", take: TAKE }]);
    expect(report).toMatchObject({ updated: 1, shifted: 0 });
    expect(groupMove).not.toHaveBeenCalled();
  });

  it("refuses the whole change and names the locked clip when a later clip is locked", async () => {
    const elements = [
      element("a", 0, 3, { voiceLine: "l1" }),
      element("b", 3, 2, { timelineLocked: true, label: "Outro" }),
    ];
    const { value, recordEdit, groupMove, writeProjectFile } = deps({ elements: () => elements });
    const report = await applyVoiceTakes(value, [{ lineId: "l1", take: TAKE }]);
    expect(report).toMatchObject({
      updated: 0,
      shifted: 0,
      blockedBy: ["Outro"],
      blockedLines: ["l1"],
    });
    expect(writeProjectFile).not.toHaveBeenCalled();
    expect(recordEdit).not.toHaveBeenCalled();
    expect(groupMove).not.toHaveBeenCalled();
  });

  it("writes nothing and says why while an agent turn runs", async () => {
    const { value, writeProjectFile } = deps({ blockedReason: () => "The agent is editing" });
    const report = await applyVoiceTakes(value, [{ lineId: "l1", take: TAKE }]);
    expect(report.failure).toBe("The agent is editing");
    expect(writeProjectFile).not.toHaveBeenCalled();
  });
});
