import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  PROVENANCE_SCHEMA,
  VOICE_ASSET_DIR,
  type AgentId,
  type AssetProvenance,
  type CancelRequestState,
  type VoiceScript,
  type VoiceSynthesisLineResult,
  type VoiceSynthesisProgress,
  type VoiceSynthesisRequest,
  type VoiceSynthesisResult,
  type VoiceTake,
} from "@hyperframes/agent-protocol";
import { readLedger, withLedgerLock, writeLedger } from "../../research/provenance.js";
import { RequestRegistry, type RequestGuard } from "../../research/requestRegistry.js";
import { isResearchFailure } from "../../research/errors.js";
import type { ResolvedProject, SpeechTranscription } from "../../types.js";
import type { VoiceEngine } from "../engine.js";
import { VoiceFailure } from "../errors.js";
import type { EngineAudio } from "../types.js";
import { splitScene, type TimedWord } from "./align.js";
import { dialectIssues, selectWork } from "./check.js";
import { planRequests, type PlannedLine, type RequestPlan } from "./requests.js";
import { readScript, selectedTake, updateScript } from "./takesStore.js";

export type TranscribeMedia = (options: {
  inputPath: string;
  language?: string;
  signal: AbortSignal;
}) => Promise<SpeechTranscription | { unavailable: string }>;

export interface SynthesizerOptions {
  engine: VoiceEngine;
  /** Speech recognition for splitting scenes; `null`/failing makes every scene fall back to one request per line. */
  transcribe: TranscribeMedia;
  now?: () => number;
}

/** The scratch directory of in-progress work; never under `assets/`. */
export const VOICE_TMP_DIR = ".hyperframes/voice/tmp";

const KEPT_PROGRESS = 256;

/** An audio file staged in the scratch directory, with the lines it serves. */
interface Artifact {
  tmp: string;
  hash: string;
  ext: "wav" | "mp3";
  mimeType: EngineAudio["mimeType"];
  /** Cost of the request that produced it (null: unknown). */
  usdCost: number | null;
  cached: boolean;
  lines: PlannedLine[];
}

interface Piece {
  artifact: Artifact;
  line: PlannedLine;
  start: number;
  end: number;
  words: TimedWord[] | undefined;
}

interface Run {
  project: ResolvedProject;
  request: VoiceSynthesisRequest;
  guard: RequestGuard;
  script: VoiceScript;
  scratch: string;
  artifacts: Artifact[];
  pieces: Piece[];
  notes: string[];
  requests: number;
  usdCost: number | null;
  sequence: number;
  progress: VoiceSynthesisProgress;
}

/** The research registry speaks research errors: `cancelled` and `invalid_request` are the same words here. */
function asVoiceFailure(error: unknown): unknown {
  if (isResearchFailure(error)) {
    const { code, message } = error.error;
    if (code === "cancelled" || code === "invalid_request") return new VoiceFailure(code, message);
  }
  return error;
}

const slugOf = (value: string): string =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "voice";

export class VoiceSynthesizer {
  private readonly registry = new RequestRegistry();
  private readonly progress = new Map<string, VoiceSynthesisProgress>();
  private readonly now: () => number;

  constructor(private readonly options: SynthesizerOptions) {
    this.now = options.now ?? Date.now;
  }

  private key(project: ResolvedProject, requestId: string): string {
    return `${project.dir}\0${requestId}`;
  }

  /** `GET /voice/requests/:requestId` */
  progressOf(project: ResolvedProject, requestId: string): VoiceSynthesisProgress {
    const known = this.progress.get(this.key(project, requestId));
    if (!known) throw new VoiceFailure("not_found", `No voice request "${requestId}"`);
    return { ...known };
  }

  /** `POST /voice/requests/:requestId/cancel`: `cancelled` means nothing more will be written. */
  cancel(project: ResolvedProject, requestId: string): CancelRequestState {
    return this.registry.cancel(project.dir, requestId);
  }

  /** Removes the scratch files an earlier process left (a kill mid-generation); never touches `assets/`. */
  sweep(projectDir: string): void {
    rmSync(join(projectDir, VOICE_TMP_DIR), { recursive: true, force: true });
  }

  async synthesize(
    project: ResolvedProject,
    request: VoiceSynthesisRequest,
    client?: AbortSignal,
  ): Promise<VoiceSynthesisResult> {
    let guard: RequestGuard;
    try {
      guard = this.registry.begin(project.dir, request.requestId, client);
    } catch (error) {
      throw asVoiceFailure(error);
    }
    const progress: VoiceSynthesisProgress = {
      requestId: request.requestId,
      state: "running",
      done: 0,
      total: 0,
      lineId: null,
    };
    this.remember(this.key(project, request.requestId), progress);
    const run: Run = {
      project,
      request,
      guard,
      script: readScript(project.dir),
      scratch: join(project.dir, VOICE_TMP_DIR, randomUUID().slice(0, 12)),
      artifacts: [],
      pieces: [],
      notes: [],
      requests: 0,
      usdCost: 0,
      sequence: 0,
      progress,
    };
    try {
      const result = await this.run(run);
      progress.state = "done";
      progress.lineId = null;
      return result;
    } catch (error) {
      const failure = asVoiceFailure(guard.normalize(error));
      progress.state =
        failure instanceof VoiceFailure && failure.code === "cancelled" ? "cancelled" : "failed";
      progress.lineId = null;
      throw failure;
    } finally {
      this.registry.end(guard);
      rmSync(run.scratch, { recursive: true, force: true });
    }
  }

  private remember(key: string, progress: VoiceSynthesisProgress): void {
    this.progress.set(key, progress);
    // Oldest first; a running request is never dropped.
    for (const [oldKey, entry] of this.progress) {
      if (this.progress.size <= KEPT_PROGRESS) break;
      if (entry.state !== "running") this.progress.delete(oldKey);
    }
  }

  private async run(run: Run): Promise<VoiceSynthesisResult> {
    const { engine } = this.options;
    const { project, request, guard } = run;
    const selection = await selectWork(engine, project.dir, run.script, request);

    // Dialect errors stop here, before any request is made or paid.
    const issues = dialectIssues(selection.planned);
    if (issues.some((issue) => issue.severity === "error")) {
      throw new VoiceFailure(
        "dialect_violation",
        "The script breaks the voice model's rules; fix it before generating",
        undefined,
        undefined,
        issues,
      );
    }
    for (const entry of selection.pending) {
      if (!engine.provider(entry.preset.providerId).configured) {
        throw new VoiceFailure(
          "not_configured",
          `${engine.provider(entry.preset.providerId).name} is not set up: add its key in Settings › Voice`,
        );
      }
    }

    const requests = planRequests(selection.pending, run.script.lines, {
      ...(request.scene !== undefined && { scene: request.scene }),
      language: run.script.language,
    });
    run.progress.total = selection.pending.length;

    let failure: unknown = null;
    try {
      for (const plan of requests) await this.generate(run, plan);
    } catch (error) {
      // A cancel discards the lot; any other failure keeps what was generated (the cache has it paid for) and
      // reports the failure after the commit, so a retry only generates the lines still missing.
      guard.assertLive();
      failure = guard.normalize(error);
    }
    if (failure !== null && run.pieces.length === 0) throw failure;
    if (run.pieces.length === 0) {
      // Every line already has its take: nothing is written.
      const lines = selection.current.flatMap((entry) => {
        const take = selectedTake(entry.line);
        return take ? [{ lineId: entry.line.id, take, cached: true }] : [];
      });
      return { lines, requests: 0, usdCost: 0, notes: run.notes };
    }

    const lines = await this.commit(run, selection.current);
    if (failure !== null) throw failure;
    return { lines, requests: run.requests, usdCost: run.usdCost, notes: run.notes };
  }

  /** One provider request, and for a scene the split of its audio into the lines. */
  private async generate(run: Run, plan: RequestPlan): Promise<void> {
    const { engine } = this.options;
    run.guard.assertLive();
    run.progress.lineId = plan.lines[0]?.line.id ?? null;
    const audio = await engine.synthesize({ ...plan.input, signal: run.guard.signal });
    run.guard.assertLive();
    if (!audio.cached) run.requests += 1;
    run.usdCost =
      run.usdCost === null || (!audio.cached && audio.usdCost === null)
        ? null
        : run.usdCost + (audio.cached ? 0 : (audio.usdCost ?? 0));
    const artifact = this.stage(run, audio, plan.lines);

    if (!plan.scene) {
      const only = plan.lines[0];
      if (only) {
        run.pieces.push({
          artifact,
          line: only,
          start: 0,
          end: audio.durationSeconds,
          words: undefined,
        });
        run.progress.done += 1;
      }
      return;
    }

    const split = await this.split(run, plan, artifact, audio.durationSeconds);
    if (split.ok) {
      for (const range of split.lines) {
        const line = plan.lines.find((entry) => entry.line.id === range.id);
        if (line)
          run.pieces.push({
            artifact,
            line,
            start: range.start,
            end: range.end,
            words: range.words,
          });
      }
      run.progress.done += plan.lines.length;
      return;
    }
    run.notes.push(
      `The scene of ${plan.lines.length} lines starting at "${plan.lines[0]?.line.id}" was generated one request per line: ${split.reason}.`,
    );
    run.artifacts.splice(run.artifacts.indexOf(artifact), 1);
    rmSync(artifact.tmp, { force: true });
    const singles = planRequests(plan.lines, run.script.lines, {
      scene: false,
      language: run.script.language,
    });
    for (const single of singles) await this.generate(run, single);
  }

  private async split(run: Run, plan: RequestPlan, artifact: Artifact, durationSeconds: number) {
    let words: TimedWord[];
    try {
      const language = run.script.language?.split("-")[0];
      const heard = await this.options.transcribe({
        inputPath: artifact.tmp,
        ...(language && { language }),
        signal: run.guard.signal,
      });
      if ("unavailable" in heard) {
        return {
          ok: false as const,
          reason: `speech recognition is unavailable (${heard.unavailable})`,
        };
      }
      words = heard.words;
    } catch (error) {
      run.guard.assertLive();
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false as const, reason: `speech recognition failed (${message})` };
    }
    run.guard.assertLive();
    return splitScene(
      plan.lines.map((entry) => ({ id: entry.line.id, spoken: entry.spoken })),
      words,
      durationSeconds,
    );
  }

  /** Copies the engine's cache file into the scratch directory: the cache is not on the project's volume. */
  private stage(run: Run, audio: EngineAudio, lines: PlannedLine[]): Artifact {
    const ext = audio.mimeType === "audio/mpeg" ? "mp3" : "wav";
    mkdirSync(run.scratch, { recursive: true });
    run.sequence += 1;
    const tmp = join(run.scratch, `${run.sequence}-${audio.hash.slice(0, 8)}.${ext}`);
    copyFileSync(audio.path, tmp);
    const artifact: Artifact = {
      tmp,
      hash: audio.hash,
      ext,
      mimeType: audio.mimeType,
      usdCost: audio.cached ? 0 : audio.usdCost,
      cached: audio.cached,
      lines,
    };
    run.artifacts.push(artifact);
    return artifact;
  }

  /**
   * The single commit point: the files move into `assets/voice/`, the provenance is recorded and `takes.json` is
   * written, with no `await` between the cancel check and the first write. A cancel before it leaves nothing.
   */
  private async commit(run: Run, reused: PlannedLine[]): Promise<VoiceSynthesisLineResult[]> {
    const { project, guard, request } = run;
    const results = new Map<string, VoiceSynthesisLineResult>();
    const now = this.now();
    const by: { agent: AgentId | "user"; turnId: string | null } = {
      agent: request.agent ?? "user",
      turnId: request.turnId ?? null,
    };
    await guard.race(
      withLedgerLock(project.dir, () =>
        updateScript(
          project.dir,
          (script) => {
            guard.commit();
            const placed = this.place(run, by, now);
            const lines = script.lines.map((line) => {
              const mine = run.pieces.filter((piece) => piece.line.line.id === line.id);
              if (mine.length === 0) return line;
              let next = line;
              for (const piece of mine) {
                const rel = placed.get(piece.artifact);
                if (rel === undefined) continue;
                const { take, existing } = this.takeOf(piece, rel, next, by, now);
                next = {
                  ...next,
                  takes: existing ? next.takes : [...next.takes, take],
                  selectedTakeId: take.id,
                };
                results.set(line.id, {
                  lineId: line.id,
                  take,
                  cached: existing || piece.artifact.cached,
                });
              }
              return next;
            });
            for (const entry of reused) {
              const line = lines.find((candidate) => candidate.id === entry.line.id);
              const take = line ? selectedTake(line) : null;
              if (take) results.set(entry.line.id, { lineId: entry.line.id, take, cached: true });
            }
            return { ...script, lines };
          },
          this.now,
        ),
      ),
    );
    // Script order, not the order the requests finished in.
    return run.script.lines.flatMap((line) => results.get(line.id) ?? []);
  }

  /** Moves the staged files into the project and records them; returns each artifact's project path. */
  private place(
    run: Run,
    by: { agent: AgentId | "user"; turnId: string | null },
    now: number,
  ): Map<Artifact, string> {
    const { engine } = this.options;
    const dir = run.project.dir;
    const placed = new Map<Artifact, string>();
    const ledger = readLedger(dir);
    const records = [...ledger.records];
    mkdirSync(join(dir, VOICE_ASSET_DIR), { recursive: true });
    for (const artifact of run.artifacts) {
      const first = run.pieces.find((piece) => piece.artifact === artifact)?.line;
      if (!first) {
        rmSync(artifact.tmp, { force: true });
        continue;
      }
      const bytes = readFileSync(artifact.tmp);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      // The name comes from the request hash: a file already there with these bytes is the same sound. TTS output
      // is not deterministic, so when the cache entry was lost and the provider answered again, the new audio gets
      // a name from its own content: takes and clips that point at the old file keep playing the old ranges.
      const slug = slugOf(first.spoken || first.line.text);
      const sameBytes = (path: string) =>
        statSync(path).size === bytes.length && readFileSync(path).equals(bytes);
      let rel = `${VOICE_ASSET_DIR}/${slug}-${artifact.hash.slice(0, 8)}.${artifact.ext}`;
      for (let digits = 8; existsSync(join(dir, rel)) && !sameBytes(join(dir, rel)); digits += 4) {
        rel = `${VOICE_ASSET_DIR}/${slug}-${sha256.slice(0, digits)}.${artifact.ext}`;
      }
      const dest = join(dir, rel);
      if (existsSync(dest)) rmSync(artifact.tmp, { force: true });
      else renameSync(artifact.tmp, dest);
      placed.set(artifact, rel);

      const { preset } = first;
      const provider = engine.provider(preset.providerId);
      const source = { id: `voice:${preset.providerId}`, name: provider.name, trusted: true };
      const others = artifact.lines.length - 1;
      const record: AssetProvenance = {
        id: `prov-${createHash("sha256").update(`${sha256}\0${source.id}`).digest("hex").slice(0, 12)}`,
        asset: rel,
        mediaKind: "audio",
        title: `${first.line.text.trim().slice(0, 150) || "Voiceover"}${others > 0 ? ` (+${others} lines)` : ""}`,
        originalUrl: source.id,
        pageUrl: null,
        source,
        author: null,
        authorUrl: null,
        license: "Generated speech",
        // No existing license id names "synthesized by a service under its terms": `other` is the honest one. The
        // status is `clear` because the user made the file with their own account; the basis says whose terms rule.
        licenseId: "other",
        licenseUrl: null,
        licenseConfidence: "medium",
        licenseStatus: "clear",
        licenseBasis: `Synthesized by ${provider.name} from the user's own text with the user's own account; its use is governed by the provider's terms of service.`,
        attribution: `Voiceover generated with ${provider.name} (${preset.model}), voice ${preset.voice.name}`,
        retrievedAt: now,
        retrievedBy: { agent: by.agent, turnId: by.turnId, model: preset.model },
        policyMode: "trusted",
        sha256,
        originalSha256: sha256,
        bytes: bytes.length,
        contentType: artifact.mimeType,
        converted: null,
        storyNode: null,
        need: null,
      };
      const at = records.findIndex((entry) => entry.asset === rel);
      if (at >= 0) records[at] = record;
      else records.push(record);
    }
    writeLedger(dir, { schema: PROVENANCE_SCHEMA, records });
    return placed;
  }

  /** The take of a piece, or the line's existing take when it is the same sound (a repeated request). */
  private takeOf(
    piece: Piece,
    file: string,
    line: { takes: VoiceTake[] },
    by: { agent: AgentId | "user"; turnId: string | null },
    now: number,
  ): { take: VoiceTake; existing: boolean } {
    const { preset } = piece.line;
    const style = piece.line.line.style;
    const speakerText = piece.line.line.speakerText;
    const same = line.takes.find(
      (take) =>
        take.file === file &&
        take.requestHash === piece.artifact.hash &&
        take.fingerprint === piece.line.fingerprint &&
        take.speakerText === speakerText &&
        take.style === style &&
        Math.abs(take.start - piece.start) < 0.005 &&
        Math.abs(take.end - piece.end) < 0.005,
    );
    if (same) return { take: same, existing: true };
    const share =
      piece.artifact.usdCost === null
        ? null
        : piece.artifact.usdCost *
          (piece.line.line.speakerText.length /
            Math.max(
              1,
              piece.artifact.lines.reduce((sum, entry) => sum + entry.line.speakerText.length, 0),
            ));
    return {
      existing: false,
      take: {
        id: `take-${randomUUID().replace(/-/g, "").slice(0, 10)}`,
        file,
        start: piece.start,
        end: piece.end,
        speakerText,
        style,
        presetId: preset.id,
        model: preset.model,
        voiceId: preset.voice.id,
        requestHash: piece.artifact.hash,
        fingerprint: piece.line.fingerprint,
        scene: piece.artifact.lines.length > 1 ? `scene-${piece.artifact.hash.slice(0, 8)}` : null,
        ...(piece.words && piece.words.length > 0 && { words: piece.words }),
        usdCost: share === null ? null : Math.round(share * 1e6) / 1e6,
        createdAt: now,
        createdBy: by,
      },
    };
  }
}
