// @vitest-environment happy-dom

/**
 * The Voiceover tab and the voice clip's inspector module on a fake voice service: lines, badges and tag chips from a
 * `VoiceScriptView`, switching takes (the clips follow), and every write control off while an agent turn runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VOICE_DIALECTS,
  type VoiceDialect,
  type VoiceLineView,
  type VoiceTake,
} from "@hyperframes/agent-protocol";
import { setAgentTurnRunning } from "../../agent/agentTurnLock";
import { VoiceClipModule } from "../../components/editor/propertyPanelVoiceGroup";
import { cleanupMounted } from "../../components/ui/mountHost.testHelpers";
import { usePlayerStore } from "../../player";
import type { VoiceApplyReport } from "../clip/voiceClipOps";
import { VoiceClipOpsProvider } from "../clip/voiceClipOpsContext";
import {
  button,
  blur,
  byTestId,
  mountVoice,
  pressAndSettle,
  settle,
  typeInto,
} from "../voiceDom.testHelpers";
import { scriptView, voicePreset } from "../voiceTestHarness";
import { VoiceoverPanel } from "./VoiceoverPanel";

const DIALECT: VoiceDialect = Object.values(VOICE_DIALECTS).find(
  (dialect) => dialect.tags.syntax !== "none" && dialect.tags.allowed.length > 0,
)!;
const TAG = DIALECT.tags.allowed[0]!;
const TAGGED = DIALECT.tags.syntax === "angle" ? `<${TAG}>` : `[${TAG}]`;

function take(id: string, overrides: Partial<VoiceTake> = {}): VoiceTake {
  return {
    id,
    file: `assets/voice/${id}.wav`,
    start: 0,
    end: 3.4,
    speakerText: "Hello there",
    style: "",
    presetId: "preset1",
    model: "gemini-3.8-flash-tts",
    voiceId: "Kore",
    requestHash: id,
    scene: null,
    usdCost: null,
    createdAt: 1,
    createdBy: { agent: "user", turnId: null },
    ...overrides,
  };
}

function line(id: string, overrides: Partial<VoiceLineView> = {}): VoiceLineView {
  return {
    id,
    text: "Hello there",
    speakerText: "Hello there",
    style: "",
    presetId: null,
    takes: [],
    selectedTakeId: null,
    textChanged: false,
    durationSeconds: null,
    clipIds: [],
    ...overrides,
  };
}

const SCRIPT = scriptView({
  language: "en",
  voice: voicePreset(),
  dialect: DIALECT,
  lines: [
    line("l1", {
      speakerText: `Hello ${TAGGED} there`,
      takes: [take("t1"), take("t2", { speakerText: "Older" })],
      selectedTakeId: "t1",
      durationSeconds: 3.4,
      textChanged: true,
    }),
    line("l2", { text: "Second line", speakerText: "Second line" }),
  ],
});

function clipOps() {
  return {
    applyTakes: vi.fn(
      async (): Promise<VoiceApplyReport> => ({
        updated: 1,
        shifted: 0,
        skipped: [],
        blockedBy: [],
        blockedLines: [],
        shiftFailed: false,
        failure: null,
      }),
    ),
    addLines: vi.fn(async () => ({ added: 1, failure: null })),
    carveMusic: vi.fn(async () => ({ kind: "carved" as const, beds: 1 })),
    addCaptions: vi.fn(async () => ({ kind: "added" as const, files: 2, skipped: 0 })),
  };
}

beforeEach(() => {
  usePlayerStore.getState().setElements([]);
});

afterEach(() => {
  setAgentTurnRunning(false);
  cleanupMounted();
});

describe("Voiceover panel", () => {
  it("draws the script: lines, badges, tag chips and the project voice", async () => {
    const { host, calls } = mountVoice(<VoiceoverPanel projectId="p1" />, { script: SCRIPT });
    await settle();
    expect(calls.script).toHaveBeenCalledWith("p1");
    expect(host.querySelectorAll('[data-testid="voice-line"]')).toHaveLength(2);
    expect(byTestId(host, "voice-project-voice-name")?.textContent).toBe("Warm narrator");
    const first = host.querySelector('[data-line-id="l1"]')!;
    expect(byTestId(first, "voice-line-text-changed")).not.toBeNull();
    expect(first.querySelector(`[data-voice-tag="${TAG}"]`)).not.toBeNull();
    expect(byTestId(first, "voice-line-status")?.textContent).toContain("1");
    const second = host.querySelector('[data-line-id="l2"]')!;
    expect(byTestId(second, "voice-line-text-changed")).toBeNull();
    expect(byTestId(second, "voice-line-status")?.textContent).toBe("Not generated yet");
  });

  it("lists the takes with the one in use marked, and switching one picks it and moves the clips", async () => {
    const ops = clipOps();
    const { host, calls } = mountVoice(
      <VoiceClipOpsProvider value={ops}>
        <VoiceoverPanel projectId="p1" />
      </VoiceClipOpsProvider>,
      { script: SCRIPT },
    );
    await settle();
    const first = host.querySelector('[data-line-id="l1"]')!;
    await pressAndSettle(byTestId(first, "voice-line-details"));
    expect(first.querySelectorAll('[data-testid="voice-take"]')).toHaveLength(2);
    expect(first.querySelector('[data-take-id="t1"]')?.getAttribute("data-selected")).toBe("true");
    calls.selectTake.mockResolvedValueOnce(
      scriptView({
        ...SCRIPT,
        lines: [{ ...SCRIPT.lines[0]!, selectedTakeId: "t2" }, SCRIPT.lines[1]!],
      }),
    );
    await pressAndSettle(byTestId(first, "voice-take-use"));
    expect(calls.selectTake).toHaveBeenCalledWith("p1", "l1", { takeId: "t2" });
    expect(ops.applyTakes).toHaveBeenCalledWith([
      expect.objectContaining({ lineId: "l1", take: expect.objectContaining({ id: "t2" }) }),
    ]);
  });

  it("puts the script back on the take the clips play when the timeline refuses the switch", async () => {
    const ops = clipOps();
    ops.applyTakes.mockResolvedValueOnce({
      updated: 0,
      shifted: 0,
      skipped: [],
      blockedBy: ["Outro"],
      blockedLines: ["l1"],
      shiftFailed: false,
      failure: null,
    });
    const { host, calls } = mountVoice(
      <VoiceClipOpsProvider value={ops}>
        <VoiceoverPanel projectId="p1" />
      </VoiceClipOpsProvider>,
      { script: SCRIPT },
    );
    await settle();
    const first = host.querySelector('[data-line-id="l1"]')!;
    await pressAndSettle(byTestId(first, "voice-line-details"));
    await pressAndSettle(byTestId(first, "voice-take-use"));
    expect(calls.selectTake.mock.calls.map(([, , request]) => request.takeId)).toEqual([
      "t2",
      "t1",
    ]);
  });

  it("asks what a regeneration costs before it spends anything", async () => {
    const { host, calls } = mountVoice(<VoiceoverPanel projectId="p1" />, { script: SCRIPT });
    calls.check.mockResolvedValue({
      ok: true,
      issues: [],
      dialect: DIALECT,
      estimate: {
        lines: 1,
        cachedLines: 0,
        requests: 1,
        seconds: 3,
        usdCost: 0.0004,
        scene: false,
        charsPerSecond: 14,
      },
    });
    await settle();
    const first = host.querySelector('[data-line-id="l1"]')!;
    await pressAndSettle(byTestId(first, "voice-line-generate-ask"));
    expect(calls.check).toHaveBeenCalledWith("p1", { lineIds: ["l1"], force: true });
    expect(calls.synthesize).not.toHaveBeenCalled();
    expect(byTestId(first, "voice-line-generate-estimate")?.textContent).toContain("$");
  });

  it("turns every write control off, with the reason, while an agent turn runs", async () => {
    const { host } = mountVoice(
      <VoiceClipOpsProvider value={clipOps()}>
        <VoiceoverPanel projectId="p1" />
      </VoiceClipOpsProvider>,
      { script: SCRIPT },
    );
    await settle();
    setAgentTurnRunning(true);
    await settle();
    expect(byTestId(host, "voiceover-locked")?.textContent).toContain("agent is editing");
    const first = host.querySelector('[data-line-id="l1"]')!;
    expect(byTestId(first, "voice-line-generate-ask")?.hasAttribute("disabled")).toBe(true);
    expect(byTestId(first, "voice-line-remove")?.hasAttribute("disabled")).toBe(true);
    expect(byTestId(host, "voiceover-generate-ask")?.hasAttribute("disabled")).toBe(true);
    expect(byTestId(host, "voiceover-add-line")?.hasAttribute("disabled")).toBe(true);
    expect(byTestId(host, "voice-project-voice-change")?.hasAttribute("disabled")).toBe(true);
    expect(byTestId(host, "voice-carve-button")?.hasAttribute("disabled")).toBe(true);
    // Text is read-only: a click does not open a field.
    await pressAndSettle(byTestId(first, "voice-line-speaker"));
    expect(byTestId(first, "voice-line-speaker-field")).toBeNull();
    // Playing stays open.
    expect(first.querySelector('[aria-label="Play line 1"]')?.hasAttribute("disabled")).toBe(false);
  });

  it("adds captions from the voiceover once a voice clip is on the timeline, and says why not before", async () => {
    const ops = clipOps();
    const { host } = mountVoice(
      <VoiceClipOpsProvider value={ops}>
        <VoiceoverPanel projectId="p1" />
      </VoiceClipOpsProvider>,
      { script: SCRIPT },
    );
    await settle();
    expect(byTestId(host, "voice-captions-button")?.hasAttribute("disabled")).toBe(true);
    expect(byTestId(host, "voice-captions-reason")?.textContent).toBe(
      "Add a voiceover line to the timeline first.",
    );
    usePlayerStore.getState().setElements([
      {
        id: "a",
        key: "a",
        tag: "audio",
        start: 0,
        duration: 3,
        track: 2,
        authoredTrack: 2,
        voiceLine: "l1",
      },
    ]);
    await settle();
    expect(byTestId(host, "voice-captions-button")?.hasAttribute("disabled")).toBe(false);
    await pressAndSettle(byTestId(host, "voice-captions-button"));
    expect(ops.addCaptions).toHaveBeenCalledTimes(1);
    // An agent turn editing the timeline locks it with the reason.
    setAgentTurnRunning(true);
    await settle();
    expect(byTestId(host, "voice-captions-button")?.hasAttribute("disabled")).toBe(true);
    expect(byTestId(host, "voice-captions-reason")?.textContent).toContain("agent is editing");
  });

  it("saves an edited speaker text through the script with the line's id", async () => {
    const { host, calls } = mountVoice(<VoiceoverPanel projectId="p1" />, { script: SCRIPT });
    await settle();
    const first = host.querySelector('[data-line-id="l2"]')!;
    await pressAndSettle(byTestId(first, "voice-line-speaker"));
    const field = byTestId<HTMLTextAreaElement>(first, "voice-line-speaker-field")!;
    await typeInto(field, "Second, edited");
    await blur(field);
    expect(calls.saveScript).toHaveBeenCalledTimes(1);
    const [, request] = calls.saveScript.mock.calls[0]!;
    expect(request.lines).toEqual([
      expect.objectContaining({ id: "l1", speakerText: `Hello ${TAGGED} there` }),
      expect.objectContaining({ id: "l2", text: "Second line", speakerText: "Second, edited" }),
    ]);
    expect(button(host, "Add line")).not.toBeNull();
  });
});

describe("Voice clip inspector module", () => {
  it("shows the line of the clip with its badge, takes and the music carve", async () => {
    const { host } = mountVoice(<VoiceClipModule lineId="l1" projectId="p1" />, {
      script: SCRIPT,
    });
    await settle();
    expect(byTestId(host, "voice-clip-text-changed")).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="voice-take"]')).toHaveLength(2);
    expect(host.querySelector(`[data-voice-tag="${TAG}"]`)).not.toBeNull();
    expect(byTestId(host, "voice-clip-generate-ask")).not.toBeNull();
    // No timeline writes here and no music: the carve says why it is off.
    expect(byTestId(host, "voice-carve-button")?.hasAttribute("disabled")).toBe(true);
    expect(byTestId(host, "voice-carve-reason")?.textContent).not.toBe("");
  });

  it("says so when the clip's line is not in the script", async () => {
    const { host } = mountVoice(<VoiceClipModule lineId="gone" projectId="p1" />, {
      script: SCRIPT,
    });
    await settle();
    expect(byTestId(host, "voice-clip-missing")).not.toBeNull();
  });
});
