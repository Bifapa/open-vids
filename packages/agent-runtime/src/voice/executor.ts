import {
  VOICE_LIMITS,
  dialectForModel,
  isRecord,
  parseSaveVoiceScriptRequest,
  parseVoiceCheckRequest,
  renderVoiceDialect,
  type AgentId,
  type Parsed,
  type SaveVoiceScriptRequest,
  type SpecialistId,
  type VoiceDialect,
  type VoicePreset,
  type VoiceScriptView,
  type VoiceSynthesisResult,
  type VoiceScriptIssue,
} from "@hyperframes/agent-protocol";
import type { HostToolResult, ToolProgress } from "../backend.js";
import { errorMessage } from "../errors.js";
import type { PermissionBroker } from "../permissions.js";
import type { VoiceBroker } from "./broker.js";
import {
  agentRulesOf,
  formatGenerated,
  formatIssues,
  formatVoice,
  formatVoiceError,
  needsGeneration,
} from "./format.js";
import { VoiceToolError, type VoiceHost } from "./host.js";
import { VOICE_TOOL_NAMES, isVoiceToolName, voiceToolsFor, type VoiceToolName } from "./tools.js";

export interface TurnVoiceOptions {
  host: VoiceHost;
  turnId: string;
  /** The turn's abort signal: aborting the turn cancels every running call. */
  turnSignal: AbortSignal;
  /** The specialists on in this chat: they decide who may call what (the Director inherits a disabled Audio's tools). */
  enabled: readonly SpecialistId[];
  /** The cards the tools wait on (voice setup, pilot). Expired at the turn's end. */
  broker: VoiceBroker;
  /** Asks the user to allow the paid generation; without it `generate_voiceover` cannot run. */
  permissions: PermissionBroker | null;
}

const refuse = (text: string): HostToolResult => ({ text, isError: true });

const NO_VOICE =
  "The project has no voice yet, so nothing was generated. Call request_voice_setup first: the user picks the voice in the chat.";
const SETUP_DECLINED =
  "The user did not choose a voice (they declined or the question ended unanswered), so there is no voiceover. Do not generate speech another way; tell the user a voice is needed and that you can continue when they choose one.";
const GENERATION_DENIED =
  "The user did not allow generating the voiceover (they said no, or the question ended unanswered), so nothing was generated or paid. The script is saved. Do not try again in this turn; tell the user the voiceover needs their approval.";
const PILOT_UNANSWERED =
  "The user did not answer about the pilot line before the turn ended, so the rest of the voiceover was not generated. The pilot line is kept. Say so and tell the user they can ask to continue.";

/** `null` and empty strings are how models say "not given": drop them, except the line's text. */
function cleanLine(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) continue;
    if (key !== "text" && typeof entry === "string" && entry.trim() === "") continue;
    out[key] = entry;
  }
  return out;
}

interface SetupArgs {
  language: string | null;
  sampleText: string;
  suggestion: string;
}

function parseSetupArgs(args: unknown): Parsed<SetupArgs> {
  if (!isRecord(args)) return { ok: false, message: "arguments must be a JSON object" };
  const sampleText = typeof args.sampleText === "string" ? args.sampleText.trim() : "";
  if (sampleText.length === 0 || sampleText.length > VOICE_LIMITS.sampleTextChars)
    return {
      ok: false,
      message: `sampleText must be the script's first sentence, 1–${VOICE_LIMITS.sampleTextChars} characters`,
    };
  const language = typeof args.language === "string" ? args.language.trim() : "";
  if (language.length > VOICE_LIMITS.languageChars)
    return {
      ok: false,
      message: `language must be a BCP-47 tag of at most ${VOICE_LIMITS.languageChars} characters`,
    };
  const suggestion = typeof args.suggestion === "string" ? args.suggestion.trim() : "";
  if (suggestion.length > VOICE_LIMITS.suggestionChars)
    return {
      ok: false,
      message: `suggestion must be at most ${VOICE_LIMITS.suggestionChars} characters`,
    };
  return { ok: true, value: { language: language || null, sampleText, suggestion } };
}

interface GenerateArgs {
  script: SaveVoiceScriptRequest;
  lineIds: string[] | undefined;
}

function parseGenerateArgs(args: unknown): Parsed<GenerateArgs> {
  if (!isRecord(args)) return { ok: false, message: "arguments must be a JSON object" };
  if (!Array.isArray(args.lines) || args.lines.length === 0)
    return { ok: false, message: "lines must be a non-empty array of script lines" };
  const script = parseSaveVoiceScriptRequest({ lines: args.lines.map(cleanLine) });
  if (!script.ok) return script;
  if (args.lineIds === undefined || args.lineIds === null)
    return { ok: true, value: { script: script.value, lineIds: undefined } };
  const ids = parseVoiceCheckRequest({ lineIds: args.lineIds });
  if (!ids.ok) return ids;
  const lineIds = ids.value.lineIds?.length ? [...new Set(ids.value.lineIds)] : undefined;
  return { ok: true, value: { script: script.value, lineIds } };
}

/** What the vendor hint for an unknown model of a built-in provider is. */
function vendorHintOf(
  providerId: VoicePreset["providerId"],
): "gemini" | "openai" | "elevenlabs" | null {
  switch (providerId) {
    case "gemini":
      return "gemini";
    case "openai":
      return "openai";
    case "elevenlabs":
      return "elevenlabs";
    case "openrouter":
    case "custom":
      return null;
  }
}

/** The cost of the calls of one generation: unknown only when no call had a known cost. */
function sumCost(results: readonly VoiceSynthesisResult[]): number | null {
  const known = results.flatMap((result) => (result.usdCost === null ? [] : [result.usdCost]));
  return known.length === 0 ? null : known.reduce((sum, cost) => sum + cost, 0);
}

/**
 * The voiceover tools of one turn: `request_voice_setup` (the chat card where the user picks the voice) and
 * `generate_voiceover` (save the script, check it, ask the cost, play the pilot, generate the rest). It writes the
 * project's takes and audio files through the voice service, never a composition, so it takes no write lease; a call
 * still running when the turn ends is cancelled and awaited by {@link shutdown} before the checkpoint closes.
 */
export class TurnVoice {
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly stop = new AbortController();
  private accepting = true;

  constructor(private readonly options: TurnVoiceOptions) {}

  /** The user's answers reach the cards through the broker. */
  get broker(): VoiceBroker {
    return this.options.broker;
  }

  execute(
    caller: AgentId,
    name: string,
    args: unknown,
    callSignal: AbortSignal,
    progress?: ToolProgress,
  ): Promise<HostToolResult> {
    if (!this.accepting)
      return Promise.resolve(refuse("The turn is finishing; voiceover is closed."));
    if (!isVoiceToolName(name)) return Promise.resolve(refuse(`Unknown voice tool ${name}.`));
    const { enabled, turnSignal } = this.options;
    if (!voiceToolsFor(caller, enabled).some((tool) => tool === name))
      return Promise.resolve(refuse(`${name} is not available to you in this turn.`));
    const signal = AbortSignal.any([callSignal, turnSignal, this.stop.signal]);
    const call = this.run(name, args, signal, caller, progress).catch(
      (error: unknown): HostToolResult => {
        if (error instanceof VoiceToolError) return refuse(formatVoiceError(error));
        if (signal.aborted)
          return refuse("The voiceover call was cancelled (the turn was stopped).");
        return refuse(`internal: ${errorMessage(error, "The voiceover call failed")}`);
      },
    );
    this.inflight.add(call);
    void call.finally(() => this.inflight.delete(call));
    return call;
  }

  /** Stops accepting calls, cancels running ones, and waits for every started call to end (writes settle first). */
  async shutdown(): Promise<void> {
    this.accepting = false;
    this.stop.abort();
    await Promise.allSettled([...this.inflight]);
  }

  private run(
    name: VoiceToolName,
    args: unknown,
    signal: AbortSignal,
    caller: AgentId,
    progress: ToolProgress | undefined,
  ): Promise<HostToolResult> {
    return name === VOICE_TOOL_NAMES.setup
      ? this.requestSetup(args, signal, caller)
      : this.generate(args, signal, caller, progress);
  }

  // ── request_voice_setup ────────────────────────────────────────────────────

  private async requestSetup(
    args: unknown,
    signal: AbortSignal,
    caller: AgentId,
  ): Promise<HostToolResult> {
    const parsed = parseSetupArgs(args);
    if (!parsed.ok) return refuse(parsed.message);
    const { host, broker, enabled } = this.options;
    const setup = await broker.askSetup({ agent: caller, ...parsed.value }, signal);
    if (setup.state !== "answered" || setup.presetId === undefined) return refuse(SETUP_DECLINED);

    let view = await host.setProjectVoice(setup.presetId, signal);
    const preset = view.voice;
    if (!preset)
      return refuse(
        "Studio did not set the chosen voice on the project. Tell the user and ask them to choose again.",
      );
    // The script's language filters the catalog and reaches providers that take one; the lines stay as they are.
    if (parsed.value.language !== null && view.language !== parsed.value.language) {
      view = await host.saveScript(
        {
          language: parsed.value.language,
          lines: view.lines.map(({ id, text, speakerText, style }) => ({
            id,
            text,
            speakerText,
            style,
          })),
        },
        signal,
      );
    }
    const providers = await host.providers(signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return null;
    });
    const provider = providers?.find((entry) => entry.id === preset.providerId);
    const dialect = view.dialect ?? (await this.dialectOf(preset, signal));
    const generates = voiceToolsFor(caller, enabled).some(
      (tool) => tool === VOICE_TOOL_NAMES.generate,
    );
    const rules = providers ? agentRulesOf(preset, providers) : "";
    const parts = [
      `The user chose the voice ${formatVoice(preset, provider)}. It is now the project's voice.`,
      dialect
        ? renderVoiceDialect(dialect, rules)
        : "The voice dialect could not be read; generate_voiceover checks the script against it before anything is paid and returns what to fix.",
      ...(providers === null
        ? ["The user's own rules for this provider could not be read; they apply when generating."]
        : []),
      generates
        ? "Next: write the script in this dialect and call generate_voiceover with its lines."
        : "Next: write the script in this dialect and hand it to Audio with delegate: the task carries every line (text, speakerText, style), the dialect rules above and where the narration goes. Audio calls generate_voiceover.",
    ];
    return { text: parts.join("\n") };
  }

  /** The dialect of a voice when Studio did not send it with the script: found by the model's family. */
  private async dialectOf(preset: VoicePreset, signal: AbortSignal): Promise<VoiceDialect | null> {
    const match = dialectForModel(preset.model, vendorHintOf(preset.providerId));
    const dialects = await this.options.host.dialects(signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return [];
    });
    return dialects.find((dialect) => dialect.id === match.dialect) ?? null;
  }

  // ── generate_voiceover ─────────────────────────────────────────────────────

  private async generate(
    args: unknown,
    signal: AbortSignal,
    caller: AgentId,
    progress: ToolProgress | undefined,
  ): Promise<HostToolResult> {
    const parsed = parseGenerateArgs(args);
    if (!parsed.ok) return refuse(parsed.message);
    const { host, permissions, turnId } = this.options;
    if (!permissions)
      return refuse(
        "This runtime cannot ask the user to allow a paid generation, so no voiceover can be generated.",
      );

    // 1. The script is saved first, so what the user hears and what the project holds are the same text.
    const saved = await host.saveScript(parsed.value.script, signal);
    if (!saved.voice) return refuse(NO_VOICE);
    const unknown = (parsed.value.lineIds ?? []).filter(
      (id) => !saved.lines.some((line) => line.id === id),
    );
    if (unknown.length > 0)
      return refuse(
        `lineIds names lines that are not in the script: ${unknown.join(", ")}. The script's line ids: ${saved.lines.map((line) => line.id).join(", ")}.`,
      );
    const scope = parsed.value.lineIds ?? saved.lines.map((line) => line.id);
    const wanted =
      parsed.value.lineIds ?? saved.lines.filter(needsGeneration).map((line) => line.id);
    if (wanted.length === 0)
      return {
        text: `Every line already has a current take; nothing was generated.\n${formatGenerated({
          view: saved,
          scope,
          generated: 0,
          reused: scope.length,
          usdCost: 0,
          warnings: [],
          notes: [],
        })}`,
      };

    // 2. The dialect check: errors go back to the agent verbatim, nothing is paid.
    const check = await host.check({ lineIds: wanted }, signal);
    if (!check.ok)
      return refuse(await this.checkFailure(saved, check.dialect, check.issues, signal));
    const warnings = check.issues.filter((issue) => issue.severity === "warning");

    // 3. The user allows the cost once per turn (a repeat call in the turn is answered by the earlier decision).
    const paid = check.estimate.lines - check.estimate.cachedLines;
    if (paid > 0) {
      const answer = await permissions.ask(
        {
          kind: "voice_generation",
          action: "render",
          site: null,
          agent: caller,
          voice: {
            provider: saved.voice.providerId,
            model: saved.voice.model,
            lines: paid,
            seconds: Math.round(check.estimate.seconds),
            usdCost: check.estimate.usdCost,
          },
        },
        signal,
      );
      if (answer.state !== "allowed_once" && answer.state !== "enabled")
        return refuse(GENERATION_DENIED);
    }

    // 4. The pilot: the first line alone, played in the chat before the rest is paid.
    const [pilotId, ...rest] = wanted;
    if (pilotId === undefined) return refuse("Nothing to generate.");
    const results: VoiceSynthesisResult[] = [];
    const pilotResult = await host.synthesize(
      { lineIds: [pilotId], agent: caller, turnId },
      signal,
    );
    results.push(pilotResult);
    const pilot = pilotResult.lines.find((line) => line.lineId === pilotId);
    if (!pilot)
      return refuse(
        `Studio did not return a take for the pilot line ${pilotId}. Nothing else was generated.`,
      );
    const pilotLine = saved.lines.find((line) => line.id === pilotId);
    const remainingUsdCost = await this.remainingCost(rest, signal);
    const verdict = await this.options.broker.askPilot(
      {
        agent: caller,
        lineId: pilotId,
        text: pilotLine?.speakerText ?? "",
        file: pilot.take.file,
        start: pilot.take.start,
        end: pilot.take.end,
        remainingLines: rest.length,
        remainingUsdCost,
      },
      signal,
    );
    if (verdict.state === "changes")
      return {
        text: `The user listened to the pilot line ${pilotId} and wants it different: ${verdict.feedback ?? "(no note)"}\nNothing else was generated; the pilot take is kept. Change the script (speakerText, style or wording of the lines this affects) and call generate_voiceover again with the full lines: lines whose text and style did not change keep their takes.`,
      };
    if (verdict.state !== "approved") return refuse(PILOT_UNANSWERED);

    // 5. The rest, in this same call.
    if (rest.length > 0) {
      try {
        const total = wanted.length;
        results.push(
          await host.synthesize({ lineIds: rest, agent: caller, turnId }, signal, (update) =>
            progress?.(Math.min(99, ((1 + update.done) / total) * 100)),
          ),
        );
      } catch (error) {
        if (!(error instanceof VoiceToolError)) throw error;
        return refuse(
          `The pilot line ${pilotId} was generated and kept, but generating the remaining lines failed.\n${formatVoiceError(error)}`,
        );
      }
    }
    return { text: await this.summary(wanted, scope, results, warnings, signal) };
  }

  /** The text of a failed check: the issues, and the dialect's rules so the fix can be made without asking. */
  private async checkFailure(
    saved: VoiceScriptView,
    dialect: VoiceDialect,
    issues: readonly VoiceScriptIssue[],
    signal: AbortSignal,
  ): Promise<string> {
    const providers = await this.options.host.providers(signal).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return [];
    });
    const rules = saved.voice ? agentRulesOf(saved.voice, providers) : "";
    return [
      "The script does not fit the voice's dialect; the script was saved but NOTHING was generated or paid. Fix every error below and call generate_voiceover again:",
      formatIssues(issues),
      renderVoiceDialect(dialect, rules),
    ].join("\n");
  }

  /** What the lines after the pilot will cost, from a fresh estimate; null when the server cannot say. */
  private async remainingCost(
    rest: readonly string[],
    signal: AbortSignal,
  ): Promise<number | null> {
    if (rest.length === 0) return 0;
    try {
      return (await this.options.host.check({ lineIds: [...rest] }, signal)).estimate.usdCost;
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    }
  }

  private async summary(
    wanted: readonly string[],
    scope: readonly string[],
    results: readonly VoiceSynthesisResult[],
    warnings: readonly VoiceScriptIssue[],
    signal: AbortSignal,
  ): Promise<string> {
    const view = await this.options.host.script(signal);
    const takes = results.flatMap((result) => result.lines);
    return formatGenerated({
      view,
      scope,
      generated: takes.filter((line) => !line.cached).length,
      reused: takes.filter((line) => line.cached).length + (scope.length - wanted.length),
      usdCost: sumCost(results),
      warnings,
      notes: results.flatMap((result) => result.notes),
    });
  }
}
