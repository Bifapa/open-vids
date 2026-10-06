import {
  VOICE_DIALECTS,
  checkVoiceScript,
  type SaveVoiceScriptRequest,
  type VoiceCheckRequest,
  type VoiceCheckResult,
  type VoiceDialect,
  type VoiceLineView,
  type VoicePreset,
  type VoiceProviderInfo,
  type VoiceScriptView,
  type VoiceSynthesisProgress,
  type VoiceSynthesisRequest,
  type VoiceSynthesisResult,
  type VoiceTake,
} from "@hyperframes/agent-protocol";
import { VoiceToolError, type VoiceHost } from "../voice/host.js";

/** A saved voice on the Gemini provider. */
export function samplePreset(overrides: Partial<VoicePreset> = {}): VoicePreset {
  return {
    id: "preset-1",
    name: "Warm narrator",
    providerId: "gemini",
    model: "gemini-3.8-flash-tts",
    voice: { id: "Kore", name: "Kore", kind: "prebuilt" },
    style: "warm, unhurried",
    settings: {},
    sample: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function sampleProvider(overrides: Partial<VoiceProviderInfo> = {}): VoiceProviderInfo {
  return {
    id: "gemini",
    connector: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-3.8-flash-tts",
    hasKey: true,
    keyRequired: true,
    configured: true,
    voice: "",
    agentRules: "",
    notes: [],
    ...overrides,
  };
}

/** A take of a line in one file of its own. */
export function sampleTake(lineId: string, overrides: Partial<VoiceTake> = {}): VoiceTake {
  return {
    id: `take-${lineId}`,
    file: `assets/voice/${lineId}-abcd1234.wav`,
    start: 0,
    end: 2.5,
    speakerText: "",
    style: "",
    presetId: "preset-1",
    model: "gemini-3.8-flash-tts",
    voiceId: "Kore",
    requestHash: "a".repeat(64),
    scene: null,
    usdCost: 0.001,
    createdAt: 1_700_000_000_000,
    createdBy: { agent: "audio", turnId: null },
    ...overrides,
  };
}

interface FakeLine {
  id: string;
  text: string;
  speakerText: string;
  style: string;
  takes: VoiceTake[];
  selectedTakeId: string | null;
}

/**
 * In-memory voice host for runtime tests: a project script that saving replaces (lines keep their takes when text and
 * style are unchanged), a check that runs the real dialect checker, a synthesis that makes one take per line. Every
 * call is recorded in `calls`; failures are queued with `failNext`.
 */
export class FakeVoiceHost implements VoiceHost {
  presetList: VoicePreset[] = [samplePreset()];
  providerList: VoiceProviderInfo[] = [sampleProvider()];
  dialect: VoiceDialect = VOICE_DIALECTS["gemini-tts"];
  voice: VoicePreset | null = null;
  lines: FakeLine[] = [];
  /** Cost the check reports per line to generate, and the cost of each synthesized line. */
  usdPerLine: number | null = 0.002;
  secondsPerLine = 2.5;
  readonly calls: Array<{ method: string; args: unknown }> = [];
  /** Errors thrown by the next calls of a method, in order. */
  readonly failures: Record<string, VoiceToolError[]> = {};
  /** Called inside `synthesize` before it answers (to hold or abort a call in tests). */
  onSynthesize:
    | ((request: Omit<VoiceSynthesisRequest, "requestId">, signal: AbortSignal) => Promise<void>)
    | null = null;
  private takeCounter = 0;

  failNext(method: string, error: VoiceToolError): void {
    (this.failures[method] ??= []).push(error);
  }

  callsOf(method: string): unknown[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  private record(method: string, args: unknown): void {
    this.calls.push({ method, args });
    const error = this.failures[method]?.shift();
    if (error) throw error;
  }

  async presets(): Promise<VoicePreset[]> {
    this.record("presets", null);
    return this.presetList;
  }

  async getPreset(id: string): Promise<VoicePreset | null> {
    this.record("getPreset", id);
    return this.presetList.find((preset) => preset.id === id) ?? null;
  }

  async providers(): Promise<VoiceProviderInfo[]> {
    this.record("providers", null);
    return this.providerList;
  }

  async dialects(): Promise<VoiceDialect[]> {
    this.record("dialects", null);
    return Object.values(VOICE_DIALECTS);
  }

  async script(): Promise<VoiceScriptView> {
    this.record("script", null);
    return this.view();
  }

  async saveScript(request: SaveVoiceScriptRequest): Promise<VoiceScriptView> {
    this.record("saveScript", request);
    let generated = 0;
    this.lines = request.lines.map((input) => {
      const id = input.id ?? `line-${++generated}`;
      const speakerText = input.speakerText ?? input.text;
      const style = input.style ?? "";
      const previous = this.lines.find((line) => line.id === id);
      const same = previous?.speakerText === speakerText && previous.style === style;
      return {
        id,
        text: input.text,
        speakerText,
        style,
        takes: previous?.takes ?? [],
        selectedTakeId: same ? (previous?.selectedTakeId ?? null) : null,
      };
    });
    return this.view();
  }

  async setProjectVoice(presetId: string | null): Promise<VoiceScriptView> {
    this.record("setProjectVoice", presetId);
    this.voice =
      presetId === null ? null : (this.presetList.find((p) => p.id === presetId) ?? null);
    return this.view();
  }

  async check(request: VoiceCheckRequest): Promise<VoiceCheckResult> {
    this.record("check", request);
    const scope = this.lines.filter((line) => request.lineIds?.includes(line.id) ?? true);
    const issues = checkVoiceScript(
      this.dialect,
      scope.map((line) => ({ id: line.id, speakerText: line.speakerText, style: line.style })),
    );
    const cached = scope.filter((line) => this.isCurrent(line)).length;
    return {
      ok: !issues.some((issue) => issue.severity === "error"),
      issues,
      estimate: {
        lines: scope.length,
        cachedLines: cached,
        requests: scope.length - cached,
        seconds: (scope.length - cached) * this.secondsPerLine,
        usdCost: this.usdPerLine === null ? null : (scope.length - cached) * this.usdPerLine,
        scene: false,
        charsPerSecond: 15,
      },
      dialect: this.dialect,
    };
  }

  async synthesize(
    request: Omit<VoiceSynthesisRequest, "requestId">,
    signal: AbortSignal,
    onProgress?: (progress: VoiceSynthesisProgress) => void,
  ): Promise<VoiceSynthesisResult> {
    this.record("synthesize", request);
    await this.onSynthesize?.(request, signal);
    signal.throwIfAborted();
    const ids =
      request.lineIds ?? this.lines.filter((line) => !this.isCurrent(line)).map((l) => l.id);
    const lines = ids.map((id, index) => {
      const line = this.lines.find((entry) => entry.id === id);
      if (!line) throw new VoiceToolError("not_found", `no line ${id}`);
      const take = sampleTake(id, {
        id: `take-${++this.takeCounter}`,
        end: this.secondsPerLine,
        speakerText: line.speakerText,
        style: line.style,
        usdCost: this.usdPerLine,
      });
      line.takes = [...line.takes, take];
      line.selectedTakeId = take.id;
      onProgress?.({
        requestId: "fake",
        state: "running",
        done: index + 1,
        total: ids.length,
        lineId: id,
      });
      return { lineId: id, take, cached: false };
    });
    return {
      lines,
      requests: lines.length,
      usdCost: this.usdPerLine === null ? null : lines.length * this.usdPerLine,
      notes: [],
    };
  }

  private isCurrent(line: FakeLine): boolean {
    return line.selectedTakeId !== null;
  }

  private view(): VoiceScriptView {
    return {
      language: null,
      voice: this.voice,
      dialect: this.voice ? this.dialect : null,
      lines: this.lines.map(
        (line): VoiceLineView => ({
          id: line.id,
          text: line.text,
          speakerText: line.speakerText,
          style: line.style,
          presetId: null,
          takes: line.takes,
          selectedTakeId: line.selectedTakeId,
          textChanged: false,
          durationSeconds: line.takes.find((take) => take.id === line.selectedTakeId)
            ? this.secondsPerLine
            : null,
          clipIds: [],
        }),
      ),
    };
  }
}
