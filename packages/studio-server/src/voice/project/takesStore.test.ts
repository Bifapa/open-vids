// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VOICE_SCRIPT_PATH, type VoiceLine, type VoiceTake } from "@hyperframes/agent-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceFailure } from "../errors.js";
import { createVoiceFixture, type VoiceFixture } from "./testSupport.js";
import { lineView, readScript, replaceLines, selectTake, updateScript } from "./takesStore.js";

let fixture: VoiceFixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function dir(): string {
  fixture ??= createVoiceFixture();
  return fixture.project.dir;
}

function take(id: string, overrides: Partial<VoiceTake> = {}): VoiceTake {
  return {
    id,
    file: "assets/voice/x-12345678.wav",
    start: 0,
    end: 2,
    speakerText: "Hello",
    style: "",
    presetId: "preset-1",
    model: "gemini-3.8-flash-tts",
    voiceId: "Kore",
    requestHash: "a".repeat(64),
    scene: null,
    usdCost: 0.01,
    createdAt: 5,
    createdBy: { agent: "director", turnId: "t1" },
    ...overrides,
  };
}

describe("takes store", () => {
  it("reads a missing file as an empty script", () => {
    expect(readScript(dir()).lines).toEqual([]);
  });

  it("writes atomically: the file is complete JSON and no temp file stays", async () => {
    const projectDir = dir();
    await updateScript(projectDir, (script) =>
      replaceLines(script, { lines: [{ text: "Hello there." }] }),
    );
    const folder = join(projectDir, ".hyperframes/voice");
    expect(readdirSync(folder)).toEqual(["takes.json"]);
    const stored = JSON.parse(readFileSync(join(projectDir, VOICE_SCRIPT_PATH), "utf-8"));
    expect(stored.schema).toBe("openvids.voice-takes/1");
    expect(stored.lines).toHaveLength(1);
  });

  it("reads a damaged file as empty and keeps it aside on the next write", async () => {
    const projectDir = dir();
    mkdirSync(join(projectDir, ".hyperframes/voice"), { recursive: true });
    writeFileSync(join(projectDir, VOICE_SCRIPT_PATH), "{ not json");
    expect(readScript(projectDir).lines).toEqual([]);
    await updateScript(projectDir, (script) => replaceLines(script, { lines: [{ text: "Hi." }] }));
    expect(readFileSync(join(projectDir, `${VOICE_SCRIPT_PATH}.bak`), "utf-8")).toBe("{ not json");
    expect(readScript(projectDir).lines).toHaveLength(1);
  });

  it("drops stored lines and takes that are not usable instead of failing", async () => {
    const projectDir = dir();
    mkdirSync(join(projectDir, ".hyperframes/voice"), { recursive: true });
    writeFileSync(
      join(projectDir, VOICE_SCRIPT_PATH),
      JSON.stringify({
        schema: "openvids.voice-takes/1",
        language: "en",
        voice: null,
        updatedAt: 1,
        lines: [
          { id: "a", text: "Kept", takes: [take("t1"), { id: "broken" }], selectedTakeId: "t1" },
          { text: "no id" },
          "nonsense",
        ],
      }),
    );
    const script = readScript(projectDir);
    expect(script.lines).toHaveLength(1);
    expect(script.lines[0]?.takes.map((entry) => entry.id)).toEqual(["t1"]);
    expect(script.lines[0]?.speakerText).toBe("Kept");
  });

  it("keeps the takes of lines whose id survives, and defaults speakerText to text", async () => {
    const projectDir = dir();
    const first = await updateScript(projectDir, (script) =>
      replaceLines(script, {
        language: "en",
        lines: [
          { id: "intro", text: "Welcome." },
          { id: "outro", text: "Goodbye.", speakerText: "Goodbye, <short pause> friend." },
        ],
      }),
    );
    expect(first.lines[0]?.speakerText).toBe("Welcome.");
    await updateScript(projectDir, (script) => ({
      ...script,
      lines: script.lines.map((line) =>
        line.id === "intro" ? { ...line, takes: [take("t1")], selectedTakeId: "t1" } : line,
      ),
    }));
    const second = await updateScript(projectDir, (script) =>
      replaceLines(script, {
        lines: [{ id: "intro", text: "Welcome back." }, { text: "A new line." }],
      }),
    );
    expect(second.language).toBe("en");
    expect(second.lines.map((line) => line.id).slice(0, 1)).toEqual(["intro"]);
    expect(second.lines[0]?.takes.map((entry) => entry.id)).toEqual(["t1"]);
    expect(second.lines[0]?.selectedTakeId).toBe("t1");
    expect(second.lines[1]?.id).not.toBe("outro");
    expect(second.lines[1]?.takes).toEqual([]);
    expect(second.lines).toHaveLength(2);
  });

  it("refuses a duplicate line id", () => {
    expect(() =>
      replaceLines(readScript(dir()), {
        lines: [
          { id: "a", text: "One." },
          { id: "a", text: "Two." },
        ],
      }),
    ).toThrow(VoiceFailure);
  });

  it("selects an existing take and refuses unknown ones", async () => {
    const projectDir = dir();
    await updateScript(projectDir, () => ({
      ...readScript(projectDir),
      lines: [
        {
          id: "a",
          text: "Hello",
          speakerText: "Hello",
          style: "",
          presetId: null,
          takes: [take("t1"), take("t2")],
          selectedTakeId: "t1",
        },
      ],
    }));
    const chosen = selectTake(readScript(projectDir), "a", "t2");
    expect(chosen.lines[0]?.selectedTakeId).toBe("t2");
    expect(() => selectTake(readScript(projectDir), "a", "nope")).toThrow(/no take/);
    expect(() => selectTake(readScript(projectDir), "zzz", "t1")).toThrow(/No voice line/);
    expect(existsSync(join(projectDir, VOICE_SCRIPT_PATH))).toBe(true);
  });

  it("derives textChanged, duration and clip ids when a line is read", () => {
    const line: VoiceLine = {
      id: "a",
      text: "Hello",
      speakerText: "Hello again",
      style: "",
      presetId: null,
      takes: [take("t1", { speakerText: "Hello", start: 1, end: 3.5 })],
      selectedTakeId: "t1",
    };
    expect(lineView(line, ["hf-1"])).toMatchObject({
      textChanged: true,
      durationSeconds: 2.5,
      clipIds: ["hf-1"],
    });
    expect(lineView({ ...line, speakerText: "Hello" }, []).textChanged).toBe(false);
    expect(lineView({ ...line, takes: [], selectedTakeId: null }, []).durationSeconds).toBeNull();
  });
});
