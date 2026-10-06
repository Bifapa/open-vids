import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  VOICE_KINDS,
  VOICE_SCRIPT_PATH,
  VOICE_SCRIPT_SCHEMA,
  isRecord,
  isVoiceProviderId,
  type SaveVoiceScriptRequest,
  type VoiceLine,
  type VoiceLineView,
  type VoicePreset,
  type VoicePresetSample,
  type VoiceScript,
  type VoiceTake,
} from "@hyperframes/agent-protocol";
import { serialized } from "../../analysis/store.js";
import { replaceFileAtomically } from "../../helpers/atomicFile.js";
import { agentIdOf } from "../../research/agents.js";
import { VoiceFailure } from "../errors.js";

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function emptyScript(now: number): VoiceScript {
  return { schema: VOICE_SCRIPT_SCHEMA, language: null, voice: null, lines: [], updatedAt: now };
}

function sampleOf(raw: unknown): VoicePresetSample | null {
  if (!isRecord(raw) || !isRecord(raw.audio)) return null;
  const sampleText = text(raw.text);
  const url = text(raw.audio.url);
  const hash = text(raw.audio.hash);
  const durationSeconds = finite(raw.audio.durationSeconds);
  const createdAt = finite(raw.createdAt);
  const mimeType =
    raw.audio.mimeType === "audio/wav" || raw.audio.mimeType === "audio/mpeg"
      ? raw.audio.mimeType
      : null;
  if (
    sampleText === null ||
    url === null ||
    hash === null ||
    durationSeconds === null ||
    createdAt === null ||
    mimeType === null
  ) {
    return null;
  }
  return { text: sampleText, audio: { url, hash, durationSeconds, mimeType }, createdAt };
}

function settingsOf(raw: unknown): Record<string, number | boolean> {
  const settings: Record<string, number | boolean> = {};
  if (!isRecord(raw)) return settings;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      settings[key] = value;
  }
  return settings;
}

function presetOf(raw: unknown): VoicePreset | null {
  if (!isRecord(raw) || !isRecord(raw.voice)) return null;
  const id = text(raw.id);
  const name = text(raw.name);
  const model = text(raw.model);
  const style = text(raw.style);
  const createdAt = finite(raw.createdAt);
  const updatedAt = finite(raw.updatedAt);
  const voiceId = text(raw.voice.id);
  const voiceName = text(raw.voice.name);
  if (
    id === null ||
    name === null ||
    model === null ||
    style === null ||
    createdAt === null ||
    updatedAt === null ||
    voiceId === null ||
    voiceName === null ||
    !isVoiceProviderId(raw.providerId)
  ) {
    return null;
  }
  const rawKind = raw.voice.kind;
  const voiceKind = VOICE_KINDS.find((kind) => kind === rawKind) ?? "custom";
  const language = text(raw.voice.language);
  const description = text(raw.voice.description);
  return {
    id,
    name,
    providerId: raw.providerId,
    model,
    voice: {
      id: voiceId,
      name: voiceName,
      kind: voiceKind,
      ...(language !== null && { language }),
      ...(description !== null && { description }),
    },
    style,
    settings: settingsOf(raw.settings),
    sample: sampleOf(raw.sample),
    createdAt,
    updatedAt,
  };
}

function takeOf(raw: unknown): VoiceTake | null {
  if (!isRecord(raw) || !isRecord(raw.createdBy)) return null;
  const id = text(raw.id);
  const file = text(raw.file);
  const start = finite(raw.start);
  const end = finite(raw.end);
  const speakerText = text(raw.speakerText);
  const style = text(raw.style);
  const presetId = text(raw.presetId);
  const model = text(raw.model);
  const voiceId = text(raw.voiceId);
  const requestHash = text(raw.requestHash);
  const fingerprint = text(raw.fingerprint);
  const createdAt = finite(raw.createdAt);
  const agent = agentIdOf(raw.createdBy.agent);
  if (
    id === null ||
    file === null ||
    start === null ||
    end === null ||
    end < start ||
    speakerText === null ||
    style === null ||
    presetId === null ||
    model === null ||
    voiceId === null ||
    requestHash === null ||
    createdAt === null ||
    agent === null
  ) {
    return null;
  }
  const words: Array<{ text: string; start: number; end: number }> = [];
  if (Array.isArray(raw.words)) {
    for (const word of raw.words) {
      if (!isRecord(word)) continue;
      const wordText = text(word.text);
      const wordStart = finite(word.start);
      const wordEnd = finite(word.end);
      if (wordText !== null && wordStart !== null && wordEnd !== null)
        words.push({ text: wordText, start: wordStart, end: wordEnd });
    }
  }
  return {
    id,
    file,
    start,
    end,
    speakerText,
    style,
    presetId,
    model,
    voiceId,
    requestHash,
    ...(fingerprint !== null && { fingerprint }),
    scene: text(raw.scene),
    ...(words.length > 0 && { words }),
    usdCost: finite(raw.usdCost),
    createdAt,
    createdBy: { agent, turnId: text(raw.createdBy.turnId) },
  };
}

function lineOf(raw: unknown): VoiceLine | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id);
  const lineText = text(raw.text);
  if (id === null || lineText === null) return null;
  const takes: VoiceTake[] = [];
  if (Array.isArray(raw.takes)) {
    for (const entry of raw.takes) {
      const take = takeOf(entry);
      if (take) takes.push(take);
    }
  }
  const selected = text(raw.selectedTakeId);
  return {
    id,
    text: lineText,
    speakerText: text(raw.speakerText) ?? lineText,
    style: text(raw.style) ?? "",
    presetId: text(raw.presetId),
    takes,
    selectedTakeId:
      selected !== null && takes.some((take) => take.id === selected) ? selected : null,
  };
}

/** The script a stored value describes, or null when it is not one (damaged JSON, another schema). */
export function scriptOf(raw: unknown): VoiceScript | null {
  if (!isRecord(raw) || raw.schema !== VOICE_SCRIPT_SCHEMA || !Array.isArray(raw.lines))
    return null;
  const lines: VoiceLine[] = [];
  const seen = new Set<string>();
  for (const entry of raw.lines) {
    const line = lineOf(entry);
    if (!line || seen.has(line.id)) continue;
    seen.add(line.id);
    lines.push(line);
  }
  return {
    schema: VOICE_SCRIPT_SCHEMA,
    language: text(raw.language),
    voice: presetOf(raw.voice),
    lines,
    updatedAt: finite(raw.updatedAt) ?? 0,
  };
}

interface Loaded {
  script: VoiceScript;
  /** A file exists but could not be read as a script. */
  damaged: boolean;
}

function load(projectDir: string): Loaded {
  const file = join(projectDir, VOICE_SCRIPT_PATH);
  if (!existsSync(file)) return { script: emptyScript(0), damaged: false };
  try {
    const script = scriptOf(JSON.parse(readFileSync(file, "utf-8")));
    if (script) return { script, damaged: false };
  } catch {
    // Damaged JSON: read as an empty script below.
  }
  return { script: emptyScript(0), damaged: true };
}

/** The project's script. A missing or damaged file is an empty script (a damaged one is kept aside on the next write). */
export function readScript(projectDir: string): VoiceScript {
  return load(projectDir).script;
}

function writeScript(projectDir: string, script: VoiceScript, damaged: boolean): void {
  const file = join(projectDir, VOICE_SCRIPT_PATH);
  mkdirSync(dirname(file), { recursive: true });
  if (damaged) {
    try {
      copyFileSync(file, `${file}.bak`);
    } catch {
      // Best effort: the damaged file is replaced either way.
    }
  }
  replaceFileAtomically(file, `${JSON.stringify(script, null, 2)}\n`, 0o644);
}

/**
 * A read-modify-write of the script, one at a time per project. `change` runs synchronously between the read and the
 * (atomic) write, so a caller that must not await between its commit check and its first write can do both in it.
 * It returns the replacement, or nothing after editing the given script in place.
 */
export function updateScript(
  projectDir: string,
  change: (script: VoiceScript) => VoiceScript | void,
  now: () => number = Date.now,
): Promise<VoiceScript> {
  return serialized(`voice-takes\0${resolve(projectDir)}`, async () => {
    const loaded = load(projectDir);
    const next = change(loaded.script) ?? loaded.script;
    const stamped: VoiceScript = { ...next, updatedAt: now() };
    writeScript(projectDir, stamped, loaded.damaged);
    return stamped;
  });
}

/**
 * `PUT /voice/script`: the lines are replaced; a line whose id survives keeps its takes, selection and own voice. The
 * speaker text defaults to the source text.
 */
export function replaceLines(script: VoiceScript, request: SaveVoiceScriptRequest): VoiceScript {
  const previous = new Map(script.lines.map((line) => [line.id, line]));
  const used = new Set<string>();
  const lines: VoiceLine[] = [];
  for (const input of request.lines) {
    if (input.id !== undefined && used.has(input.id)) {
      throw new VoiceFailure("invalid_request", `line id ${input.id} is used twice`);
    }
    let id = input.id;
    if (id === undefined) {
      do id = `line-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      while (used.has(id) || previous.has(id));
    }
    used.add(id);
    const kept = previous.get(id);
    lines.push({
      id,
      text: input.text,
      speakerText: input.speakerText ?? input.text,
      style: input.style ?? "",
      presetId: kept?.presetId ?? null,
      takes: kept?.takes ?? [],
      selectedTakeId: kept?.selectedTakeId ?? null,
    });
  }
  return {
    ...script,
    language: request.language === undefined ? script.language : request.language,
    lines,
  };
}

/** `PUT /voice/lines/:lineId/take`: selects one of the line's takes. */
export function selectTake(script: VoiceScript, lineId: string, takeId: string): VoiceScript {
  const line = script.lines.find((entry) => entry.id === lineId);
  if (!line) throw new VoiceFailure("not_found", `No voice line "${lineId}"`);
  if (!line.takes.some((take) => take.id === takeId)) {
    throw new VoiceFailure("not_found", `Line "${lineId}" has no take "${takeId}"`);
  }
  return {
    ...script,
    lines: script.lines.map((entry) =>
      entry.id === lineId ? { ...entry, selectedTakeId: takeId } : entry,
    ),
  };
}

export function selectedTake(line: VoiceLine): VoiceTake | null {
  return line.takes.find((take) => take.id === line.selectedTakeId) ?? null;
}

/** The selected take was made from other speaker text or style than the line has now. */
export function takeIsStale(line: VoiceLine, take: VoiceTake): boolean {
  return take.speakerText !== line.speakerText || take.style !== line.style;
}

/** A line as the UI reads it: the stored line plus what is derived (`clipIds` come from the timeline). */
export function lineView(line: VoiceLine, clipIds: readonly string[]): VoiceLineView {
  const take = selectedTake(line);
  return {
    ...line,
    textChanged: take !== null && takeIsStale(line, take),
    durationSeconds: take === null ? null : Math.round((take.end - take.start) * 1000) / 1000,
    clipIds: [...clipIds],
  };
}
