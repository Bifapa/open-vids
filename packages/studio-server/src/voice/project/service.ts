import type {
  CancelRequestState,
  SaveVoiceScriptRequest,
  SelectVoiceTakeRequest,
  SetProjectVoiceRequest,
  VoiceCheckRequest,
  VoiceCheckResult,
  VoiceScript,
  VoiceScriptView,
  VoiceSynthesisProgress,
  VoiceSynthesisRequest,
  VoiceSynthesisResult,
} from "@hyperframes/agent-protocol";
import type { ResolvedProject } from "../../types.js";
import type { VoiceEngine } from "../engine.js";
import { VoiceFailure } from "../errors.js";
import { checkScript } from "./check.js";
import { dialectOfPreset } from "./requests.js";
import { VoiceSynthesizer, type TranscribeMedia } from "./synthesize.js";
import { lineView, readScript, replaceLines, selectTake, updateScript } from "./takesStore.js";
import { voiceClipsByLine } from "./voiceClips.js";

export interface ProjectVoiceServiceOptions {
  engine: VoiceEngine;
  transcribe: TranscribeMedia;
  now?: () => number;
  /** Waits `ms` (rejects when the signal aborts); replaced in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** A project's voiceover: its script and takes, the check, and generation through the engine. */
export class ProjectVoiceService {
  private readonly synthesizer: VoiceSynthesizer;
  private readonly swept = new Set<string>();
  private readonly engine: VoiceEngine;
  private readonly now: () => number;

  constructor(options: ProjectVoiceServiceOptions) {
    this.engine = options.engine;
    this.now = options.now ?? Date.now;
    this.synthesizer = new VoiceSynthesizer({
      engine: options.engine,
      transcribe: options.transcribe,
      now: this.now,
      ...(options.sleep && { sleep: options.sleep }),
    });
  }

  /** The first time this process touches a project, the scratch files of a killed earlier run are removed. */
  private touch(project: ResolvedProject): void {
    if (this.swept.has(project.dir)) return;
    this.swept.add(project.dir);
    this.synthesizer.sweep(project.dir);
  }

  private view(project: ResolvedProject, script: VoiceScript): VoiceScriptView {
    const clips = voiceClipsByLine(project.dir);
    return {
      language: script.language,
      voice: script.voice,
      dialect: script.voice ? dialectOfPreset(script.voice).dialect : null,
      lines: script.lines.map((line) => lineView(line, clips.get(line.id) ?? [])),
    };
  }

  script(project: ResolvedProject): VoiceScriptView {
    this.touch(project);
    return this.view(project, readScript(project.dir));
  }

  async saveScript(
    project: ResolvedProject,
    request: SaveVoiceScriptRequest,
  ): Promise<VoiceScriptView> {
    this.touch(project);
    const script = await updateScript(
      project.dir,
      (current) => replaceLines(current, request),
      this.now,
    );
    return this.view(project, script);
  }

  /** The project's voice is a copy of the library preset, so the project keeps working without the library. */
  async setVoice(
    project: ResolvedProject,
    request: SetProjectVoiceRequest,
  ): Promise<VoiceScriptView> {
    this.touch(project);
    const preset = request.presetId === null ? null : await this.engine.preset(request.presetId);
    if (request.presetId !== null && !preset) {
      throw new VoiceFailure("not_found", `No voice preset "${request.presetId}"`);
    }
    const script = await updateScript(
      project.dir,
      (current) => ({ ...current, voice: preset }),
      this.now,
    );
    return this.view(project, script);
  }

  /** Selects an existing take: no paid call. */
  async selectTake(
    project: ResolvedProject,
    lineId: string,
    request: SelectVoiceTakeRequest,
  ): Promise<VoiceScriptView> {
    this.touch(project);
    const script = await updateScript(
      project.dir,
      (current) => selectTake(current, lineId, request.takeId),
      this.now,
    );
    return this.view(project, script);
  }

  check(project: ResolvedProject, request: VoiceCheckRequest): Promise<VoiceCheckResult> {
    this.touch(project);
    return checkScript(this.engine, project.dir, readScript(project.dir), request);
  }

  synthesize(
    project: ResolvedProject,
    request: VoiceSynthesisRequest,
    client?: AbortSignal,
  ): Promise<VoiceSynthesisResult> {
    this.touch(project);
    return this.synthesizer.synthesize(project, request, client);
  }

  progress(project: ResolvedProject, requestId: string): VoiceSynthesisProgress {
    return this.synthesizer.progressOf(project, requestId);
  }

  cancel(project: ResolvedProject, requestId: string): CancelRequestState {
    return this.synthesizer.cancel(project, requestId);
  }
}
