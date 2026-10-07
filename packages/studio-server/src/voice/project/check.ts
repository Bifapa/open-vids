import {
  checkVoiceScript,
  type VoiceCheckResult,
  type VoiceEstimate,
  type VoiceLine,
  type VoicePreset,
  type VoiceScript,
  type VoiceScriptIssue,
} from "@hyperframes/agent-protocol";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VoiceFailure } from "../errors.js";
import type { VoiceEngine } from "../engine.js";
import {
  DEFAULT_CHARS_PER_SECOND,
  charsPerSecondOf,
  dialectOfPreset,
  plannedLine,
  planRequests,
  type PlannedLine,
  type RequestPlan,
} from "./requests.js";
import { selectedTake, takeIsStale } from "./takesStore.js";

/** The lines a request names (unknown ids refused), or every line of the script. */
export function selectLines(
  script: VoiceScript,
  lineIds: readonly string[] | undefined,
): VoiceLine[] {
  if (lineIds === undefined) return script.lines;
  const picked: VoiceLine[] = [];
  const wanted = new Set(lineIds);
  for (const id of wanted) {
    if (!script.lines.some((line) => line.id === id)) {
      throw new VoiceFailure("not_found", `No voice line "${id}"`);
    }
  }
  // Script order, whatever the order of the request.
  for (const line of script.lines) if (wanted.has(line.id)) picked.push(line);
  return picked;
}

/**
 * Whether the line's selected take is what generating the line again would give: its fingerprint (voice, model,
 * effective style, settings, language, the line's text) is the line's now, and its audio is still in the project.
 */
export function hasCurrentTake(
  projectDir: string,
  line: VoiceLine,
  preset: Pick<VoicePreset, "id">,
  fingerprint: string,
): boolean {
  const take = selectedTake(line);
  return (
    take !== null &&
    !takeIsStale(line, take) &&
    take.presetId === preset.id &&
    take.fingerprint === fingerprint &&
    existsSync(join(projectDir, take.file))
  );
}

/** The voice each line is read in: the request's preset, the line's own, else the project's. */
export async function planLines(
  engine: VoiceEngine,
  script: VoiceScript,
  lines: readonly VoiceLine[],
  presetId: string | undefined,
): Promise<PlannedLine[]> {
  const library = new Map<string, VoicePreset>();
  const fromLibrary = async (id: string, why: string): Promise<VoicePreset> => {
    const known = library.get(id);
    if (known) return known;
    const preset = await engine.preset(id);
    if (!preset) throw new VoiceFailure("not_found", `${why}: no voice preset "${id}"`);
    library.set(id, preset);
    return preset;
  };
  const planned: PlannedLine[] = [];
  for (const line of lines) {
    const index = script.lines.findIndex((entry) => entry.id === line.id);
    let preset: VoicePreset | null;
    if (presetId !== undefined) preset = await fromLibrary(presetId, "The request names a voice");
    else if (line.presetId !== null)
      preset = await fromLibrary(line.presetId, `Line "${line.id}" has its own voice`);
    else preset = script.voice;
    if (!preset) {
      throw new VoiceFailure(
        "not_configured",
        "The project has no voice yet: choose one first (request_voice_setup in a chat, or Settings › Voice)",
      );
    }
    const base = plannedLine(line, index, preset);
    // The hash of this line alone (no neighbours, no scene): what makes a take of it out of date when it changes.
    const [single] = planRequests([base], [], { scene: false, language: script.language });
    if (!single) throw new Error("a line planned no request");
    planned.push({ ...base, fingerprint: engine.peek(single.input).hash });
  }
  return planned;
}

/** The delivery text a request carries: the line's own, else the preset's (a model without a style takes none). */
export function effectiveStyle(entry: Pick<PlannedLine, "line" | "preset" | "dialect">): string {
  const own = entry.line.style.trim();
  if (own.length > 0) return own;
  return entry.dialect.style === "none" ? "" : entry.preset.style.trim();
}

/** Dialect problems of the lines, each dialect-and-model group checked against its own rules. */
export function dialectIssues(planned: readonly PlannedLine[]): VoiceScriptIssue[] {
  const groups = new Map<string, PlannedLine[]>();
  for (const entry of planned) {
    const key = `${entry.dialect.id}\0${entry.preset.model}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const issues: VoiceScriptIssue[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    issues.push(
      ...checkVoiceScript(
        first.dialect,
        group.map((entry) => ({
          id: entry.line.id,
          speakerText: entry.line.speakerText,
          style: effectiveStyle(entry),
        })),
        { approximate: first.approximate, model: first.preset.model },
      ),
    );
  }
  return issues;
}

export interface Selection {
  planned: PlannedLine[];
  /** Lines that still need a request: no current take. */
  pending: PlannedLine[];
  /** Lines whose selected take is what a new request would give. */
  current: PlannedLine[];
}

export async function selectWork(
  engine: VoiceEngine,
  projectDir: string,
  script: VoiceScript,
  request: { lineIds?: readonly string[]; presetId?: string; force?: boolean },
): Promise<Selection> {
  const planned = await planLines(
    engine,
    script,
    selectLines(script, request.lineIds),
    request.presetId,
  );
  const current: PlannedLine[] = [];
  const pending: PlannedLine[] = [];
  for (const entry of planned) {
    const reuse =
      request.force !== true &&
      hasCurrentTake(projectDir, entry.line, entry.preset, entry.fingerprint);
    (reuse ? current : pending).push(entry);
  }
  return { planned, pending, current };
}

/** What the requests would cost: the lines served by the cache or a current take are free. */
export async function estimateOf(
  engine: VoiceEngine,
  selection: Selection,
  requests: readonly RequestPlan[],
  options: { force?: boolean } = {},
): Promise<VoiceEstimate> {
  let cachedLines = selection.current.length;
  let paidRequests = 0;
  let seconds = 0;
  let usdCost: number | null = 0;
  // OpenRouter's prices come from its model listing; without it (offline) the cost is simply unknown.
  if (requests.some((request) => request.input.preset.providerId === "openrouter")) {
    await engine.models("openrouter").catch(() => []);
  }
  for (const request of requests) {
    // A forced regeneration bypasses the cache, so it is always paid.
    if (options.force !== true && engine.peek(request.input).audio !== null) {
      cachedLines += request.lines.length;
      continue;
    }
    paidRequests += 1;
    seconds += request.seconds;
    const cost = engine.estimateCost(request.input.preset.providerId, request.input.preset.model, {
      chars: request.chars,
      seconds: request.seconds,
    });
    usdCost = usdCost === null || cost === null ? null : usdCost + cost;
  }
  const first = selection.planned[0];
  return {
    lines: selection.planned.length,
    cachedLines,
    requests: paidRequests,
    seconds: Math.round(seconds * 10) / 10,
    usdCost: usdCost === null ? null : Math.round(usdCost * 1e6) / 1e6,
    scene: requests.some((request) => request.scene),
    charsPerSecond: first ? charsPerSecondOf(first.preset) : DEFAULT_CHARS_PER_SECOND,
  };
}

/** `POST /voice/check`: the dialect check and the estimate of generating the lines now. Nothing is paid or written. */
export async function checkScript(
  engine: VoiceEngine,
  projectDir: string,
  script: VoiceScript,
  request: { lineIds?: string[]; presetId?: string; force?: boolean },
): Promise<VoiceCheckResult> {
  const selection = await selectWork(engine, projectDir, script, request);
  const issues = dialectIssues(selection.planned);
  const requests = planRequests(selection.pending, script.lines, {
    language: script.language,
    ...(request.force === true && { fresh: true }),
  });
  let dialect = selection.planned[0]?.dialect;
  if (!dialect) {
    // Nothing selected: the voice the lines would be read in still names the dialect the agent writes in.
    const preset =
      request.presetId === undefined ? script.voice : await engine.preset(request.presetId);
    if (!preset) {
      throw new VoiceFailure("not_configured", "The project has no voice yet: choose one first");
    }
    dialect = dialectOfPreset(preset).dialect;
  }
  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
    estimate: await estimateOf(engine, selection, requests, { force: request.force === true }),
    dialect,
  };
}
