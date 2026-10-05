import {
  ASSET_RANGE_MIN_SECONDS,
  CANVAS_FITS,
  CLIP_FITS,
  EDIT_LIMITS,
  EDIT_OPERATION_NAMES,
  RIPPLE_SCOPES,
  TEXT_PLACEMENTS,
  TEXT_SIZES,
  type ApplyEditsRequest,
  type CaptionCue,
  type EditOperation,
  type EditOperationName,
  type ParsedEdit,
  type SetAssetRangeRequest,
} from "./editing.js";
import {
  PROVENANCE_ID,
  createOpReader,
  invalid,
  isField,
  oneOf,
  readCanvasPixels,
  readFrame,
  readString,
  readTime,
} from "./editingRead.js";
import { MORE_OPERATION_KEYS, readMoreOperation } from "./editingParseMore.js";
import { isRecord } from "./validate.js";

const ALLOWED_KEYS: Record<EditOperationName, readonly string[]> = {
  add_clip: [
    "asset",
    "start",
    "track",
    "duration",
    "mediaStart",
    "volume",
    "muted",
    "fit",
    "frame",
    "fadeIn",
    "fadeOut",
    "provenance",
  ],
  add_sequence: [
    "asset",
    "track",
    "start",
    "ranges",
    "volume",
    "muted",
    "fit",
    "frame",
    "edgeFade",
    "provenance",
  ],
  add_text: ["text", "start", "duration", "track", "placement", "size", "color", "provenance"],
  add_component: ["name", "start", "track", "duration", "provenance"],
  apply_captions: ["preset", "cues", "track"],
  remove_clip: ["clip", "clips", "ripple", "rippleScope"],
  move_clip: ["clip", "start", "track"],
  trim_clip: ["clip", "start", "end"],
  split_clip: ["clip", "at"],
  set_clip: ["clip", "volume", "muted", "fit", "zIndex", "frame", "fadeIn", "fadeOut", "opacity"],
  arrange_track: ["track", "clips", "start", "gap"],
  set_composition: ["duration"],
  set_canvas: ["width", "height", "fit"],
  ...MORE_OPERATION_KEYS,
};

/**
 * Reads the allowed keys of one operation. Every value goes through its reader; the first failure is reported with
 * the field name. Unknown keys are refused so a misspelled option never silently does nothing.
 */
function readOperation(raw: unknown, index: number): ParsedEdit<EditOperation> {
  const at = `operations[${index}]`;
  if (!isRecord(raw)) return invalid(`${at} must be an object`, index);
  const name = oneOf(raw.op, EDIT_OPERATION_NAMES, `${at}.op`);
  if (isField(name)) return invalid(name.ok ? `${at}.op is invalid` : name.message, index);

  const unknownKey = Object.keys(raw).find(
    (key) => key !== "op" && !ALLOWED_KEYS[name].includes(key),
  );
  if (unknownKey) return invalid(`${at}: unknown field "${unknownKey}" for ${name}`, index);

  const reader = createOpReader(raw);
  const { failures, need, maybe, bool, clipRef, time, optTime, track, optTrack, volume } = reader;
  const provenance = reader.provenance;
  const fit = () => maybe("fit", (value) => oneOf(value, CLIP_FITS, "fit"));
  const rippleScope = () =>
    maybe("rippleScope", (value) => oneOf(value, RIPPLE_SCOPES, "rippleScope"));

  let op: EditOperation | null = null;
  switch (name) {
    case "add_clip": {
      const asset = need(readString(raw.asset, "asset", EDIT_LIMITS.pathChars));
      const start = time("start");
      const onTrack = track();
      const duration = optTime("duration", true);
      const mediaStart = optTime("mediaStart");
      const vol = volume();
      const muted = bool("muted");
      const fitting = fit();
      const frame = maybe("frame", readFrame);
      const fadeIn = optTime("fadeIn");
      const fadeOut = optTime("fadeOut");
      const stamp = provenance();
      if (asset !== undefined && start !== undefined && onTrack !== undefined)
        op = {
          op: name,
          asset,
          start,
          track: onTrack,
          ...(duration !== undefined && { duration }),
          ...(mediaStart !== undefined && { mediaStart }),
          ...(vol !== undefined && { volume: vol }),
          ...(muted !== undefined && { muted }),
          ...(fitting !== undefined && { fit: fitting }),
          ...(frame !== undefined && { frame }),
          ...(fadeIn !== undefined && { fadeIn }),
          ...(fadeOut !== undefined && { fadeOut }),
          ...(stamp !== undefined && { provenance: stamp }),
        };
      break;
    }
    case "add_sequence": {
      const asset = need(readString(raw.asset, "asset", EDIT_LIMITS.pathChars));
      const onTrack = track();
      const start = optTime("start");
      const vol = volume();
      const muted = bool("muted");
      const fitting = fit();
      const frame = maybe("frame", readFrame);
      const stamp = provenance();
      const edgeFade = maybe("edgeFade", (value) =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= EDIT_LIMITS.maxEdgeFade
          ? value
          : { ok: false, message: `edgeFade must be between 0 and ${EDIT_LIMITS.maxEdgeFade}` },
      );
      const ranges: Array<{ from: number; to: number }> = [];
      if (!Array.isArray(raw.ranges) || raw.ranges.length === 0) {
        failures.push("ranges must be a non-empty array of {from, to}");
      } else if (raw.ranges.length > EDIT_LIMITS.sequenceRanges) {
        failures.push(`ranges exceeds ${EDIT_LIMITS.sequenceRanges} entries`);
      } else {
        for (const [rangeIndex, range] of raw.ranges.entries()) {
          const label = `ranges[${rangeIndex}]`;
          if (!isRecord(range)) {
            failures.push(`${label} must be an object {from, to}`);
            break;
          }
          const extra = Object.keys(range).find((key) => key !== "from" && key !== "to");
          if (extra) {
            failures.push(`${label}: unknown field "${extra}"`);
            break;
          }
          const from = need(readTime(range.from, `${label}.from`));
          const to = need(readTime(range.to, `${label}.to`, true));
          if (from === undefined || to === undefined) break;
          if (to <= from) {
            failures.push(`${label}.to must be after its from`);
            break;
          }
          ranges.push({ from, to });
        }
      }
      if (asset !== undefined && onTrack !== undefined && failures.length === 0)
        op = {
          op: name,
          asset,
          track: onTrack,
          ranges,
          ...(start !== undefined && { start }),
          ...(vol !== undefined && { volume: vol }),
          ...(muted !== undefined && { muted }),
          ...(fitting !== undefined && { fit: fitting }),
          ...(frame !== undefined && { frame }),
          ...(edgeFade !== undefined && { edgeFade }),
          ...(stamp !== undefined && { provenance: stamp }),
        };
      break;
    }
    case "add_text": {
      const text = need(readString(raw.text, "text", EDIT_LIMITS.textChars));
      const start = time("start");
      const duration = time("duration", true);
      const onTrack = track();
      const placement = maybe("placement", (value) => oneOf(value, TEXT_PLACEMENTS, "placement"));
      const size = maybe("size", (value) => oneOf(value, TEXT_SIZES, "size"));
      const stamp = provenance();
      const color = maybe("color", (value) => {
        const read = readString(value, "color", 40);
        if (isField(read)) return read;
        return /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]{3,20}$/.test(read)
          ? read
          : { ok: false, message: "color must be a hex color or a CSS color name" };
      });
      if (
        text !== undefined &&
        start !== undefined &&
        duration !== undefined &&
        onTrack !== undefined
      )
        op = {
          op: name,
          text,
          start,
          duration,
          track: onTrack,
          ...(placement !== undefined && { placement }),
          ...(size !== undefined && { size }),
          ...(color !== undefined && { color }),
          ...(stamp !== undefined && { provenance: stamp }),
        };
      break;
    }
    case "add_component": {
      const component = need(readString(raw.name, "name", EDIT_LIMITS.idChars));
      const start = time("start");
      const onTrack = track();
      const duration = optTime("duration", true);
      const stamp = provenance();
      if (component !== undefined && start !== undefined && onTrack !== undefined)
        op = {
          op: name,
          name: component,
          start,
          track: onTrack,
          ...(duration !== undefined && { duration }),
          ...(stamp !== undefined && { provenance: stamp }),
        };
      break;
    }
    case "apply_captions": {
      const preset = need(readString(raw.preset, "preset", EDIT_LIMITS.idChars));
      const onTrack = optTrack();
      const cues: CaptionCue[] = [];
      if (!Array.isArray(raw.cues) || raw.cues.length === 0) {
        failures.push("cues must be a non-empty array");
      } else if (raw.cues.length > EDIT_LIMITS.captionCues) {
        failures.push(`cues exceeds ${EDIT_LIMITS.captionCues} entries`);
      } else {
        raw.cues.forEach((cue, cueIndex) => {
          const label = `cues[${cueIndex}]`;
          if (!isRecord(cue)) {
            failures.push(`${label} must be an object`);
            return;
          }
          const text = need(readString(cue.text, `${label}.text`, EDIT_LIMITS.textChars));
          const start = need(readTime(cue.start, `${label}.start`));
          const end = need(readTime(cue.end, `${label}.end`, true));
          if (text === undefined || start === undefined || end === undefined) return;
          if (end <= start) failures.push(`${label}.end must be after its start`);
          else cues.push({ text, start, end });
        });
      }
      if (preset !== undefined && failures.length === 0)
        op = { op: name, preset, cues, ...(onTrack !== undefined && { track: onTrack }) };
      break;
    }
    case "remove_clip": {
      const ripple = bool("ripple");
      const scope = rippleScope();
      if ((raw.clip === undefined) === (raw.clips === undefined)) {
        failures.push("remove_clip needs exactly one of clip or clips");
      }
      const clips =
        raw.clips === undefined ? undefined : reader.clipList("clips", EDIT_LIMITS.removeClips);
      const clip = raw.clip === undefined ? undefined : clipRef();
      if (scope !== undefined && ripple !== true) failures.push("rippleScope needs ripple: true");
      if (failures.length === 0 && (clip !== undefined || clips !== undefined))
        op = {
          op: name,
          ...(clip !== undefined && { clip }),
          ...(clips !== undefined && { clips }),
          ...(ripple !== undefined && { ripple }),
          ...(scope !== undefined && { rippleScope: scope }),
        };
      break;
    }
    case "move_clip": {
      const clip = clipRef();
      const start = optTime("start");
      const onTrack = optTrack();
      if (raw.start === undefined && raw.track === undefined)
        failures.push("move_clip needs start and/or track");
      if (clip !== undefined)
        op = {
          op: name,
          clip,
          ...(start !== undefined && { start }),
          ...(onTrack !== undefined && { track: onTrack }),
        };
      break;
    }
    case "trim_clip": {
      const clip = clipRef();
      const start = optTime("start");
      const end = optTime("end", true);
      if (raw.start === undefined && raw.end === undefined)
        failures.push("trim_clip needs start and/or end");
      if (start !== undefined && end !== undefined && end <= start)
        failures.push("end must be after start");
      if (clip !== undefined)
        op = {
          op: name,
          clip,
          ...(start !== undefined && { start }),
          ...(end !== undefined && { end }),
        };
      break;
    }
    case "split_clip": {
      const clip = clipRef();
      const at = time("at", true);
      if (clip !== undefined && at !== undefined) op = { op: name, clip, at };
      break;
    }
    case "set_clip": {
      const clip = clipRef();
      const vol = volume();
      const muted = bool("muted");
      const fitting = fit();
      const frame = maybe("frame", readFrame);
      const fadeIn = optTime("fadeIn");
      const fadeOut = optTime("fadeOut");
      const opacity = maybe("opacity", (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
          ? value
          : { ok: false, message: "opacity must be a number from 0 to 1" },
      );
      const zIndex = maybe("zIndex", (value) =>
        typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= 100_000
          ? value
          : { ok: false, message: "zIndex must be an integer" },
      );
      if (Object.keys(raw).length <= 2) failures.push("set_clip needs at least one property");
      if (clip !== undefined)
        op = {
          op: name,
          clip,
          ...(vol !== undefined && { volume: vol }),
          ...(muted !== undefined && { muted }),
          ...(fitting !== undefined && { fit: fitting }),
          ...(zIndex !== undefined && { zIndex }),
          ...(frame !== undefined && { frame }),
          ...(fadeIn !== undefined && { fadeIn }),
          ...(fadeOut !== undefined && { fadeOut }),
          ...(opacity !== undefined && { opacity }),
        };
      break;
    }
    case "arrange_track": {
      const onTrack = track();
      const start = optTime("start");
      const gap = optTime("gap");
      const clips = reader.clipList("clips", EDIT_LIMITS.arrangeClips);
      if (onTrack !== undefined && clips !== undefined && failures.length === 0)
        op = {
          op: name,
          track: onTrack,
          clips,
          ...(start !== undefined && { start }),
          ...(gap !== undefined && { gap }),
        };
      break;
    }
    case "set_composition": {
      const duration = time("duration", true);
      if (duration !== undefined) op = { op: name, duration };
      break;
    }
    case "set_canvas": {
      const width = need(readCanvasPixels(raw.width, "width"));
      const height = need(readCanvasPixels(raw.height, "height"));
      const fitting = maybe("fit", (value) => oneOf(value, CANVAS_FITS, "fit"));
      if (width !== undefined && height !== undefined)
        op = { op: name, width, height, ...(fitting !== undefined && { fit: fitting }) };
      break;
    }
    default:
      op = readMoreOperation(name, reader);
  }
  if (failures.length > 0) return invalid(`${at} (${name}): ${failures.join("; ")}`, index);
  if (!op) return invalid(`${at} (${name}) is invalid`, index);
  return { ok: true, value: op };
}

/** Validates an editing batch at the boundary; the service still checks clips, assets and presets against the project. */
export function parseApplyEditsRequest(body: unknown): ParsedEdit<ApplyEditsRequest> {
  if (!isRecord(body)) return invalid("body must be a JSON object");
  const known = ["composition", "baseVersion", "operations", "turnId", "requestId", "dryRun"];
  const unknownKey = Object.keys(body).find((key) => !known.includes(key));
  if (unknownKey) return invalid(`unknown field "${unknownKey}"`);
  let composition: string | undefined;
  if (body.composition !== undefined) {
    const read = readString(body.composition, "composition", EDIT_LIMITS.pathChars);
    if (isField(read)) return invalid(read.ok ? "composition is invalid" : read.message);
    composition = read;
  }
  let baseVersion: string | undefined;
  if (body.baseVersion !== undefined) {
    const read = readString(body.baseVersion, "baseVersion", 200);
    if (isField(read)) return invalid(read.ok ? "baseVersion is invalid" : read.message);
    baseVersion = read;
  }
  let turnId: string | undefined;
  if (body.turnId !== undefined) {
    if (typeof body.turnId !== "string" || !PROVENANCE_ID.test(body.turnId))
      return invalid("turnId must be an id (letters, digits, _ . : -)");
    turnId = body.turnId;
  }
  let requestId: string | undefined;
  if (body.requestId !== undefined) {
    if (typeof body.requestId !== "string" || !PROVENANCE_ID.test(body.requestId))
      return invalid("requestId must be an id (letters, digits, _ . : -)");
    requestId = body.requestId;
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean")
    return invalid("dryRun must be true or false");
  const dryRun = body.dryRun;
  if (!Array.isArray(body.operations) || body.operations.length === 0)
    return invalid("operations must be a non-empty array");
  if (body.operations.length > EDIT_LIMITS.operations)
    return invalid(`operations exceeds ${EDIT_LIMITS.operations} entries`);
  const operations: EditOperation[] = [];
  for (const [index, raw] of body.operations.entries()) {
    const parsed = readOperation(raw, index);
    if (!parsed.ok) return parsed;
    operations.push(parsed.value);
  }
  return {
    ok: true,
    value: {
      ...(composition !== undefined && { composition }),
      ...(baseVersion !== undefined && { baseVersion }),
      ...(turnId !== undefined && { turnId }),
      ...(requestId !== undefined && { requestId }),
      ...(dryRun !== undefined && { dryRun }),
      operations,
    },
  };
}

/** Validates `PUT /editing/ranges`; the service still checks the asset's kind and length against the project. */
export function parseSetAssetRangeRequest(body: unknown): ParsedEdit<SetAssetRangeRequest> {
  if (!isRecord(body)) return invalid("body must be a JSON object");
  const unknownKey = Object.keys(body).find((key) => key !== "path" && key !== "range");
  if (unknownKey) return invalid(`unknown field "${unknownKey}"`);
  const path = readString(body.path, "path", EDIT_LIMITS.pathChars);
  if (isField(path)) return invalid(path.ok ? "path is invalid" : path.message);
  if (body.range === null) return { ok: true, value: { path, range: null } };
  if (!isRecord(body.range)) return invalid("range must be {start, end} or null");
  const { start, end } = body.range;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end > EDIT_LIMITS.maxTime
  ) {
    return invalid(
      `range.start and range.end must be seconds between 0 and ${EDIT_LIMITS.maxTime}`,
    );
  }
  // The same float slack as isAssetRange: 10.1 - 10 is 0.0999…96, and a minimum-length pick is valid.
  if (end - start < ASSET_RANGE_MIN_SECONDS - 1e-6) {
    return invalid(`range must be at least ${ASSET_RANGE_MIN_SECONDS}s long (end after start)`);
  }
  return { ok: true, value: { path, range: { start, end } } };
}
