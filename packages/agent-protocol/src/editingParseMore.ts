import {
  COLOR_ADJUST_KEYS,
  EDIT_LIMITS,
  RIPPLE_SCOPES,
  type ColorAdjust,
  type EditOperation,
  type EditOperationName,
} from "./editing.js";
import {
  isField,
  oneOf,
  readNumberIn,
  readString,
  readTime,
  readTrack,
  type Field,
  type OpReader,
} from "./editingRead.js";
import { isRecord } from "./validate.js";

/** The keys of the operations added after the first set. */
export const MORE_OPERATION_KEYS = {
  set_speed: ["clip", "rate", "keepDuration", "ripple", "rippleScope"],
  retime_captions: ["shift", "scale", "from", "to"],
  captions_from_transcript: ["preset", "track", "clips", "maxWords"],
  captions_from_voiceover: ["preset", "track", "lines"],
  mount_composition: ["composition", "start", "track", "duration", "provenance"],
  set_color_grade: ["clip", "preset", "intensity", "adjust", "clear"],
  set_audio_fx: ["clip", "preset", "replace", "clear"],
  set_volume_automation: ["clip", "points", "clear"],
  duck_audio: ["clip", "under", "underTrack", "reduceDb", "attack", "release"],
  set_locked: ["clips", "locked"],
} as const satisfies Partial<Record<EditOperationName, readonly string[]>>;

const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

function readPresetId(value: unknown, field: string): string | Field {
  const read = readString(value, field, 80);
  if (isField(read)) return read;
  return PRESET_ID.test(read)
    ? read
    : { ok: false, message: `${field} must be a preset id (letters, digits, - _ .)` };
}

function readAdjust(value: unknown): ColorAdjust | Field {
  if (!isRecord(value)) return { ok: false, message: "adjust must be an object" };
  const adjust: ColorAdjust = {};
  for (const [key, entry] of Object.entries(value)) {
    const known = COLOR_ADJUST_KEYS.find((candidate) => candidate === key);
    if (!known)
      return {
        ok: false,
        message: `adjust: unknown field "${key}" (${COLOR_ADJUST_KEYS.join(", ")})`,
      };
    const limit = known === "exposure" ? 2 : 1;
    const read = readNumberIn(entry, `adjust.${key}`, -limit, limit);
    if (isField(read)) return read;
    adjust[known] = read;
  }
  return adjust;
}

function readSignedTime(value: unknown, field: string): number | Field {
  return readNumberIn(value, field, -EDIT_LIMITS.maxTime, EDIT_LIMITS.maxTime);
}

const VOICE_LINE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `lines` of `captions_from_voiceover`: 1..200 distinct voice line ids. */
function readVoiceLineIds(value: unknown): string[] | Field {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    return { ok: false, message: "lines must be an array of 1–200 voice line ids" };
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !VOICE_LINE_ID.test(entry)) {
      return {
        ok: false,
        message: "lines must hold voice line ids (1–64 letters, digits, - or _)",
      };
    }
    ids.push(entry);
  }
  return new Set(ids).size === ids.length
    ? ids
    : { ok: false, message: "lines must not repeat a voice line" };
}

/** The newer operations; `reader` carries the raw object and collects failures. Undefined when a field failed. */
export function readMoreOperation(name: EditOperationName, reader: OpReader): EditOperation | null {
  const { raw, failures, need, maybe, bool, clipRef, time, optTime, track, optTrack, provenance } =
    reader;
  switch (name) {
    case "set_speed": {
      const clip = clipRef();
      const rate = need(readNumberIn(raw.rate, "rate", EDIT_LIMITS.minRate, EDIT_LIMITS.maxRate));
      const keepDuration = bool("keepDuration");
      const ripple = bool("ripple");
      const scope = maybe("rippleScope", (value) => oneOf(value, RIPPLE_SCOPES, "rippleScope"));
      if (scope !== undefined && ripple !== true) failures.push("rippleScope needs ripple: true");
      if (keepDuration === true && ripple === true)
        failures.push("ripple has nothing to close when keepDuration is true");
      if (clip === undefined || rate === undefined) return null;
      return {
        op: name,
        clip,
        rate,
        ...(keepDuration !== undefined && { keepDuration }),
        ...(ripple !== undefined && { ripple }),
        ...(scope !== undefined && { rippleScope: scope }),
      };
    }
    case "retime_captions": {
      const shift = maybe("shift", (value) => readSignedTime(value, "shift"));
      const scale = maybe("scale", (value) => readNumberIn(value, "scale", 0.1, 10));
      const from = optTime("from");
      const to = optTime("to", true);
      if (shift === undefined && scale === undefined)
        failures.push("retime_captions needs shift and/or scale");
      if (from !== undefined && to !== undefined && to <= from)
        failures.push("to must be after from");
      return failures.length > 0
        ? null
        : {
            op: name,
            ...(shift !== undefined && { shift }),
            ...(scale !== undefined && { scale }),
            ...(from !== undefined && { from }),
            ...(to !== undefined && { to }),
          };
    }
    case "captions_from_transcript": {
      const preset = need(readString(raw.preset, "preset", EDIT_LIMITS.idChars));
      const onTrack = optTrack();
      const maxWords = maybe("maxWords", (value) =>
        typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12
          ? value
          : { ok: false, message: "maxWords must be a whole number from 1 to 12" },
      );
      const clips = raw.clips === undefined ? undefined : reader.clipList("clips", 200);
      if (preset === undefined || failures.length > 0) return null;
      return {
        op: name,
        preset,
        ...(onTrack !== undefined && { track: onTrack }),
        ...(clips !== undefined && { clips }),
        ...(maxWords !== undefined && { maxWords }),
      };
    }
    case "captions_from_voiceover": {
      const preset = maybe("preset", (value) => readString(value, "preset", EDIT_LIMITS.idChars));
      const onTrack = optTrack();
      const lines = maybe("lines", readVoiceLineIds);
      if (failures.length > 0) return null;
      return {
        op: name,
        ...(preset !== undefined && { preset }),
        ...(onTrack !== undefined && { track: onTrack }),
        ...(lines !== undefined && { lines }),
      };
    }
    case "mount_composition": {
      const composition = need(readString(raw.composition, "composition", EDIT_LIMITS.pathChars));
      const start = time("start");
      const onTrack = track();
      const duration = optTime("duration", true);
      const stamp = provenance();
      if (composition === undefined || start === undefined || onTrack === undefined) return null;
      return {
        op: name,
        composition,
        start,
        track: onTrack,
        ...(duration !== undefined && { duration }),
        ...(stamp !== undefined && { provenance: stamp }),
      };
    }
    case "set_color_grade": {
      const clip = clipRef();
      const clear = bool("clear");
      const preset = maybe("preset", (value) => readPresetId(value, "preset"));
      const intensity = maybe("intensity", (value) => readNumberIn(value, "intensity", 0, 1));
      const adjust = maybe("adjust", readAdjust);
      if (clear === true && (preset !== undefined || intensity !== undefined || adjust))
        failures.push("clear cannot be combined with preset, intensity or adjust");
      if (clear !== true && preset === undefined && intensity === undefined && adjust === undefined)
        failures.push("set_color_grade needs preset, intensity, adjust or clear");
      if (clip === undefined || failures.length > 0) return null;
      return {
        op: name,
        clip,
        ...(preset !== undefined && { preset }),
        ...(intensity !== undefined && { intensity }),
        ...(adjust !== undefined && { adjust }),
        ...(clear !== undefined && { clear }),
      };
    }
    case "set_audio_fx": {
      const clip = clipRef();
      const clear = bool("clear");
      const replace = bool("replace");
      const preset = maybe("preset", (value) => readPresetId(value, "preset"));
      if ((clear === true) === (preset !== undefined))
        failures.push("set_audio_fx needs exactly one of preset or clear: true");
      if (clear === true && replace !== undefined) failures.push("replace applies to a preset");
      if (clip === undefined || failures.length > 0) return null;
      return {
        op: name,
        clip,
        ...(preset !== undefined && { preset }),
        ...(replace !== undefined && { replace }),
        ...(clear !== undefined && { clear }),
      };
    }
    case "set_volume_automation": {
      const clip = clipRef();
      const clear = bool("clear");
      const points: Array<{ t: number; v: number }> = [];
      if (raw.points !== undefined) {
        if (
          !Array.isArray(raw.points) ||
          raw.points.length === 0 ||
          raw.points.length > EDIT_LIMITS.automationPoints
        ) {
          failures.push(`points must be an array of 1–${EDIT_LIMITS.automationPoints} {t, v}`);
        } else {
          for (const [index, point] of raw.points.entries()) {
            const label = `points[${index}]`;
            if (!isRecord(point) || Object.keys(point).some((key) => key !== "t" && key !== "v")) {
              failures.push(`${label} must be {t, v}`);
              break;
            }
            const t = need(readTime(point.t, `${label}.t`));
            const v = need(readNumberIn(point.v, `${label}.v`, 0, EDIT_LIMITS.maxVolume));
            if (t === undefined || v === undefined) break;
            points.push({ t, v });
          }
        }
      }
      if ((clear === true) === (raw.points !== undefined))
        failures.push("set_volume_automation needs exactly one of points or clear: true");
      if (clip === undefined || failures.length > 0) return null;
      return {
        op: name,
        clip,
        ...(raw.points !== undefined && { points }),
        ...(clear !== undefined && { clear }),
      };
    }
    case "duck_audio": {
      const clip = clipRef();
      const under =
        raw.under === undefined ? undefined : reader.clipList("under", EDIT_LIMITS.duckClips);
      const underTrack = maybe("underTrack", (value) => readTrack(value, "underTrack"));
      const reduceDb = maybe("reduceDb", (value) =>
        readNumberIn(value, "reduceDb", 1, EDIT_LIMITS.maxDuckDb),
      );
      const attack = maybe("attack", (value) => readNumberIn(value, "attack", 0, 10));
      const release = maybe("release", (value) => readNumberIn(value, "release", 0, 10));
      if ((under === undefined) === (underTrack === undefined))
        failures.push("duck_audio needs exactly one of under or underTrack");
      if (clip === undefined || failures.length > 0) return null;
      return {
        op: name,
        clip,
        ...(under !== undefined && { under }),
        ...(underTrack !== undefined && { underTrack }),
        ...(reduceDb !== undefined && { reduceDb }),
        ...(attack !== undefined && { attack }),
        ...(release !== undefined && { release }),
      };
    }
    case "set_locked": {
      const clips = reader.clipList("clips", EDIT_LIMITS.lockClips);
      if (typeof raw.locked !== "boolean") failures.push("locked must be true or false");
      if (clips === undefined || typeof raw.locked !== "boolean" || failures.length > 0)
        return null;
      return { op: name, clips, locked: raw.locked };
    }
    default:
      return null;
  }
}
