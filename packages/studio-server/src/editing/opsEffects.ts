import type { EditOperation, EditOperationResult } from "@hyperframes/agent-protocol";
import {
  AudioAutomationError,
  HF_AUDIO_AUTOMATION_ATTR,
  VOLUME_TARGET,
  parseAutomation,
  resolveAutomation,
  serializeAutomation,
  type HfAutomation,
  type HfAutomationPoint,
} from "@hyperframes/core/audio-automation";
import {
  AudioFxChainError,
  HF_AUDIO_FX_ATTR,
  parseAudioFxChain,
  serializeAudioFxChain,
  type HfAudioFxChain,
} from "@hyperframes/core/audio-fx";
import {
  HF_AUDIO_FX_PRESET_IDS,
  applyAudioFxPreset,
  getAudioFxPreset,
} from "@hyperframes/core/audio-fx-presets";
import {
  HF_COLOR_GRADING_ATTR,
  HF_COLOR_GRADING_PRESETS,
  hasHfColorGradingAuthoredValues,
  normalizeHfColorGrading,
  serializeHfColorGrading,
} from "@hyperframes/core/color-grading";
import {
  EPS,
  commit,
  fmt,
  loadModel,
  requireClip,
  round3,
  type Batch,
  type EditEnv,
} from "./batch.js";
import { EditFailure } from "./errors.js";
import type { ClipNode } from "./timeline.js";

function setOrRemove(element: Element, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

function requireAudible(clip: ClipNode, what: string): void {
  if (clip.kind !== "video" && clip.kind !== "audio") {
    throw new EditFailure("unsupported", `${what} applies to video and audio, not ${clip.kind}`);
  }
}

/** The clip's FX chain as written, or an empty one; an unreadable chain is refused rather than overwritten. */
function readChain(clip: ClipNode): HfAudioFxChain {
  const raw = clip.element.getAttribute(HF_AUDIO_FX_ATTR);
  if (!raw) return { version: 1, nodes: [] };
  try {
    return parseAudioFxChain(raw);
  } catch (error) {
    if (!(error instanceof AudioFxChainError)) throw error;
    throw new EditFailure(
      "unsupported",
      `Clip "${clip.id}" has an unreadable audio FX chain: ${error.message}`,
    );
  }
}

function readAutomation(clip: ClipNode): HfAutomation {
  const raw = clip.element.getAttribute(HF_AUDIO_AUTOMATION_ATTR);
  if (!raw) return { version: 1, lanes: [] };
  try {
    return parseAutomation(raw);
  } catch (error) {
    if (!(error instanceof AudioAutomationError)) throw error;
    throw new EditFailure(
      "unsupported",
      `Clip "${clip.id}" has unreadable automation: ${error.message}`,
    );
  }
}

/** Writes the lanes bound to the clip's chain (lanes of a removed effect drop out), or removes the attribute. */
function writeAutomation(clip: ClipNode, automation: HfAutomation): void {
  const bound = resolveAutomation(automation, readChain(clip));
  setOrRemove(
    clip.element,
    HF_AUDIO_AUTOMATION_ATTR,
    bound.lanes.length > 0 ? serializeAutomation(bound) : null,
  );
}

/** A colour grade the way Studio's grading panel writes it: the normalised grade, serialised. */
export async function setColorGrade(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "set_color_grade" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const clip = requireClip(model, op.clip, env);
  if (clip.kind !== "video" && clip.kind !== "image") {
    throw new EditFailure(
      "unsupported",
      `Colour grading applies to video and images, not ${clip.kind}`,
    );
  }
  if (op.clear) {
    clip.element.removeAttribute(HF_COLOR_GRADING_ATTR);
    commit(batch, model);
    return { op: op.op, clipId: clip.id, newClipId: null, note: "colour grade removed" };
  }
  if (
    op.preset !== undefined &&
    !HF_COLOR_GRADING_PRESETS.some((preset) => preset.id === op.preset)
  ) {
    const ids = HF_COLOR_GRADING_PRESETS.map((preset) => preset.id).join(", ");
    throw new EditFailure(
      "unknown_preset",
      `No colour grade preset "${op.preset}"; presets: ${ids}`,
    );
  }
  const current = normalizeHfColorGrading(clip.element.getAttribute(HF_COLOR_GRADING_ATTR));
  // A preset replaces the look; otherwise the tonal changes layer over what the clip already has.
  const base = op.preset !== undefined ? { preset: op.preset } : (current ?? {});
  const next = normalizeHfColorGrading({
    ...base,
    ...(op.intensity !== undefined && { intensity: op.intensity }),
    ...(op.adjust !== undefined && {
      adjust: { ...(op.preset === undefined ? current?.adjust : undefined), ...op.adjust },
    }),
  });
  const value =
    next && hasHfColorGradingAuthoredValues(next) ? serializeHfColorGrading(next) : null;
  setOrRemove(clip.element, HF_COLOR_GRADING_ATTR, value);
  commit(batch, model);
  return {
    op: op.op,
    clipId: clip.id,
    newClipId: null,
    ...(value === null && { note: "the resulting grade changes nothing, so none is written" }),
  };
}

/** An audio FX preset appended to (or replacing) the clip's chain, or the chain removed. */
export async function setAudioFx(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "set_audio_fx" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const clip = requireClip(model, op.clip, env);
  requireAudible(clip, "Audio effects");
  if (op.clear) {
    clip.element.removeAttribute(HF_AUDIO_FX_ATTR);
    writeAutomation(clip, readAutomation(clip));
    commit(batch, model);
    return { op: op.op, clipId: clip.id, newClipId: null, note: "audio effects removed" };
  }
  const preset = op.preset === undefined ? undefined : getAudioFxPreset(op.preset);
  if (!preset) {
    throw new EditFailure(
      "unknown_preset",
      `No audio FX preset "${op.preset ?? ""}"; presets: ${HF_AUDIO_FX_PRESET_IDS.join(", ")}`,
    );
  }
  const next = applyAudioFxPreset(readChain(clip), preset, {
    replaceChain: op.replace === true,
  });
  clip.element.setAttribute(HF_AUDIO_FX_ATTR, serializeAudioFxChain(next));
  commit(batch, model);
  return {
    op: op.op,
    clipId: clip.id,
    newClipId: null,
    note: `${preset.label}: ${next.nodes.length} effects in the chain`,
  };
}

/** The volume lane replaced by the given breakpoints (clip-local seconds), or removed. */
export async function setVolumeAutomation(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "set_volume_automation" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const clip = requireClip(model, op.clip, env);
  requireAudible(clip, "Volume automation");
  const others = readAutomation(clip).lanes.filter((lane) => lane.target !== VOLUME_TARGET);
  if (op.clear || op.points === undefined) {
    writeAutomation(clip, { version: 1, lanes: others });
    commit(batch, model);
    return { op: op.op, clipId: clip.id, newClipId: null, note: "volume automation removed" };
  }
  const late = op.points.find((point) => point.t > clip.duration + EPS);
  if (late) {
    throw new EditFailure(
      "out_of_bounds",
      `Point at ${fmt(late.t)}s is past the clip's end (${fmt(clip.duration)}s); t counts from the clip's start`,
    );
  }
  const points: HfAutomationPoint[] = op.points.map((point) => ({
    t: round3(point.t),
    v: point.v,
  }));
  writeAutomation(clip, { version: 1, lanes: [...others, { target: VOLUME_TARGET, points }] });
  commit(batch, model);
  return {
    op: op.op,
    clipId: clip.id,
    newClipId: null,
    note: `${points.length} volume points over ${fmt(clip.duration)} s`,
  };
}

const MIN_RAMP = 0.02;
const DUCK_DEFAULTS = { reduceDb: 12, attack: 0.3, release: 0.6 };
const MAX_LANE_POINTS = 500;

/** Merged `[start, end]` stretches (clip-local seconds) that the ducked clip has to make room for. */
function duckStretches(
  music: ClipNode,
  under: readonly ClipNode[],
  gap: number,
): Array<[number, number]> {
  const spans = under
    .filter((clip) => clip !== music)
    .map((clip): [number, number] => [
      Math.max(0, clip.start - music.start),
      Math.min(music.duration, clip.end - music.start),
    ])
    .filter(([from, to]) => to - from > EPS)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] - last[1] <= gap) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** The volume lane of a (music) clip dipping under the clips that speak over it. */
export async function duckAudio(
  env: EditEnv,
  batch: Batch,
  op: Extract<EditOperation, { op: "duck_audio" }>,
): Promise<EditOperationResult> {
  const model = await loadModel(env, batch.html);
  const music = requireClip(model, op.clip, env);
  requireAudible(music, "Ducking");
  const refs = op.under ?? [];
  const under =
    op.underTrack !== undefined
      ? model.clips.filter((clip) => clip.track === op.underTrack && clip !== music)
      : refs.map((ref) => {
          const found = model.clips.find((clip) => clip.id === ref || clip.domId === ref);
          if (!found)
            throw new EditFailure("unknown_clip", `No clip "${ref}" in ${env.compositionPath}`);
          return found;
        });
  if (under.length === 0) {
    throw new EditFailure(
      "unknown_clip",
      `Track ${op.underTrack ?? ""} has no clips to duck under`,
    );
  }
  const attack = Math.max(MIN_RAMP, op.attack ?? DUCK_DEFAULTS.attack);
  const release = Math.max(MIN_RAMP, op.release ?? DUCK_DEFAULTS.release);
  const base = Number.parseFloat(music.element.getAttribute("data-volume") ?? "") || 1;
  const low = round3(base * 10 ** (-(op.reduceDb ?? DUCK_DEFAULTS.reduceDb) / 20));
  const stretches = duckStretches(music, under, attack + release);
  if (stretches.length === 0) {
    throw new EditFailure("out_of_bounds", "None of the clips to duck under plays over this clip");
  }
  const points: HfAutomationPoint[] = [];
  const push = (t: number, v: number) => points.push({ t: round3(t), v: round3(v) });
  for (const [from, to] of stretches) {
    const rampStart = Math.max(0, from - attack);
    if (rampStart < from - EPS) push(rampStart, base);
    push(from, low);
    push(to, low);
    const rampEnd = Math.min(music.duration, to + release);
    if (rampEnd > to + EPS) push(rampEnd, base);
  }
  if (points.length > MAX_LANE_POINTS) {
    throw new EditFailure(
      "out_of_bounds",
      `${stretches.length} speech stretches need ${points.length} points (limit ${MAX_LANE_POINTS}); duck a shorter part of the clip`,
    );
  }
  const others = readAutomation(music).lanes.filter((lane) => lane.target !== VOLUME_TARGET);
  writeAutomation(music, { version: 1, lanes: [...others, { target: VOLUME_TARGET, points }] });
  commit(batch, model);
  return {
    op: op.op,
    clipId: music.id,
    newClipId: null,
    note: `volume ${fmt(base)} → ${fmt(low)} under ${stretches.length} stretches (replaces any earlier volume automation)`,
  };
}
