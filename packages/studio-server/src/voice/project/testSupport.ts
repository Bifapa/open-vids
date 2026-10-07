import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  VoiceModelInfo,
  VoicePreset,
  VoiceProviderId,
  VoiceProviderInfo,
} from "@hyperframes/agent-protocol";
import type { ResolvedProject, SpeechTranscription } from "../../types.js";
import type { VoiceEngine } from "../engine.js";
import type { EngineAudio, EngineSynthesisInput } from "../types.js";
import type { TimedWord } from "./align.js";
import { ProjectVoiceService } from "./service.js";
import type { TranscribeMedia } from "./synthesize.js";

export function makePreset(overrides: Partial<VoicePreset> = {}): VoicePreset {
  return {
    id: "preset-1",
    name: "Narrator",
    providerId: "gemini",
    model: "gemini-3.8-flash-tts",
    voice: { id: "Kore", name: "Kore", kind: "prebuilt" },
    style: "",
    settings: {},
    sample: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const PROVIDER_NAMES: Record<VoiceProviderId, string> = {
  gemini: "Google Gemini",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  elevenlabs: "ElevenLabs",
  custom: "Custom server",
};

const CONNECTORS: Record<VoiceProviderId, VoiceProviderInfo["connector"]> = {
  gemini: "gemini",
  openai: "openai_compatible",
  openrouter: "openai_compatible",
  elevenlabs: "elevenlabs",
  custom: "openai_compatible",
};

type Request = Omit<EngineSynthesisInput, "signal">;

/** An engine that "synthesizes" placeholder bytes into a temp cache and counts what it was asked. */
export class FakeEngine implements VoiceEngine {
  readonly calls: Request[] = [];
  readonly presets = new Map<string, VoicePreset>();
  readonly configured = new Set<VoiceProviderId>(["gemini", "openai", "elevenlabs"]);
  private readonly cache = new Map<string, EngineAudio>();
  /** Awaited inside every synthesis: a test holds a request open to cancel it. */
  gate: Promise<void> | null = null;
  /** Slow enough that every word of the fake recognizer's transcript (0.4 s each) fits in the file. */
  charsPerSecond = 4;
  /** Every synthesis after this many calls fails with `failure`. */
  failAfter: number | null = null;
  failure: Error = new Error("provider down");
  /** A provider that reads the same request into the same bytes every time (a local TTS server). */
  deterministic = false;
  /** The next syntheses fail with these, one each, before any other rule applies. */
  readonly queuedFailures: Error[] = [];
  private written = 0;

  /** The cache lost its entries (cleared, or the project was opened on another machine). */
  forgetCache(): void {
    this.cache.clear();
  }

  constructor(private readonly cacheDir: string) {
    mkdirSync(cacheDir, { recursive: true });
  }

  private hashOf(input: Request): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          provider: input.preset.providerId,
          model: input.preset.model,
          voice: input.preset.voice.id,
          settings: input.preset.settings,
          language: input.language ?? "",
          style: input.style ?? input.preset.style,
          text: input.text,
          previousText: input.previousText ?? "",
          nextText: input.nextText ?? "",
        }),
      )
      .digest("hex");
  }

  async synthesize(input: EngineSynthesisInput): Promise<EngineAudio> {
    if (this.gate) await this.gate;
    input.signal.throwIfAborted();
    const queued = this.queuedFailures.shift();
    if (queued) throw queued;
    if (this.failAfter !== null && this.calls.length >= this.failAfter) throw this.failure;
    const request: Request = {
      preset: input.preset,
      text: input.text,
      ...(input.style !== undefined && { style: input.style }),
      ...(input.previousText !== undefined && { previousText: input.previousText }),
      ...(input.nextText !== undefined && { nextText: input.nextText }),
      ...(input.language !== undefined && { language: input.language }),
      ...(input.fresh === true && { fresh: true }),
    };
    this.calls.push(request);
    const hash = this.hashOf(request);
    const known = request.fresh === true ? undefined : this.cache.get(hash);
    if (known) return { ...known, cached: true };
    const path = join(this.cacheDir, `${hash}.wav`);
    this.written += 1;
    // Like a real model: the same request does not give the same bytes twice (unless `deterministic`).
    writeFileSync(
      path,
      `RIFF fake audio ${hash}${this.deterministic ? "" : ` take ${this.written}`}`,
    );
    const audio: EngineAudio = {
      path,
      hash,
      mimeType: "audio/wav",
      durationSeconds: input.text.length / this.charsPerSecond,
      cached: false,
      usdCost: input.text.length * 0.00001,
    };
    this.cache.set(hash, audio);
    return audio;
  }

  peek(input: Request): { hash: string; audio: EngineAudio | null } {
    const hash = this.hashOf(input);
    const known = this.cache.get(hash);
    return { hash, audio: known ? { ...known, cached: true } : null };
  }

  provider(id: VoiceProviderId): VoiceProviderInfo {
    const configured = this.configured.has(id);
    return {
      id,
      connector: CONNECTORS[id],
      name: PROVIDER_NAMES[id],
      baseUrl: "https://example.test",
      model: "default",
      hasKey: configured,
      keyRequired: id !== "custom",
      configured,
      voice: "",
      agentRules: "",
      notes: [],
    };
  }

  async preset(id: string): Promise<VoicePreset | null> {
    return this.presets.get(id) ?? null;
  }

  estimateCost(
    _providerId: VoiceProviderId,
    _model: string,
    usage: { chars: number; seconds: number },
  ): number | null {
    return usage.chars * 0.00001;
  }

  audioPath(hash: string): string | null {
    return this.cache.get(hash)?.path ?? null;
  }

  async models(): Promise<VoiceModelInfo[]> {
    return [];
  }
}

/** Recognised words of a text read at a steady pace; a line break costs an extra pause. */
export function wordsOf(text: string, wordSeconds = 0.4, pauseSeconds = 0.6): TimedWord[] {
  const words: TimedWord[] = [];
  let at = 0.2;
  for (const [index, line] of text.split("\n").entries()) {
    if (index > 0) at += pauseSeconds;
    for (const word of line.split(/\s+/).filter((entry) => entry.length > 0)) {
      words.push({
        text: word,
        start: Math.round(at * 1000) / 1000,
        end: Math.round((at + wordSeconds) * 1000) / 1000,
      });
      at += wordSeconds;
    }
  }
  return words;
}

export interface VoiceFixture {
  root: string;
  project: ResolvedProject;
  engine: FakeEngine;
  service: ProjectVoiceService;
  preset: VoicePreset;
  cleanup(): void;
}

export function createVoiceFixture(
  options: {
    preset?: Partial<VoicePreset>;
    transcribe?: TranscribeMedia;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
): VoiceFixture {
  const root = mkdtempSync(join(tmpdir(), "openvids-voice-project-"));
  const dir = join(root, "project");
  mkdirSync(dir, { recursive: true });
  const project: ResolvedProject = { id: "demo", dir };
  const engine = new FakeEngine(join(root, "cache"));
  const preset = makePreset(options.preset);
  engine.presets.set(preset.id, preset);
  // The scene text is the engine's last request: the fake recognizer "hears" exactly that.
  const transcribe: TranscribeMedia =
    options.transcribe ??
    (async (): Promise<SpeechTranscription> => {
      const last = engine.calls[engine.calls.length - 1];
      return { words: wordsOf(last?.text ?? ""), language: "en", producer: "fake" };
    });
  const service = new ProjectVoiceService({
    engine,
    transcribe,
    ...(options.sleep && { sleep: options.sleep }),
  });
  return {
    root,
    project,
    engine,
    service,
    preset,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
