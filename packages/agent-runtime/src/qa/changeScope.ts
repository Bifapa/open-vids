import type { QaScopeReason, TimelineClip, TimelineSnapshot } from "@hyperframes/agent-protocol";

/** A retiming of at most this many clips is a small change. */
export const SMALL_CHANGE_CLIPS = 2;

/** What a set of edits did to the timeline, between two snapshots of it. */
export interface ChangeSummary {
  /** Clips added, removed or changed. */
  changed: number;
  /** Every changed clip is an audio clip, or changed only in level (volume, muted, locked, audio effects). */
  audioOnly: boolean;
  /** Existing clips whose start or duration changed, and nothing else that shows in the picture. */
  retimed: number;
  /** A clip was added, removed, got other content, or changed in what the picture shows (not just when it plays). */
  pictureChanged: boolean;
}

/** When a clip plays: the only thing a retiming changes. */
const timing = (clip: TimelineClip): string => JSON.stringify([clip.start, clip.duration]);

/** What the picture of a clip shows besides when it plays: layering, which source frames, opacity, grade, speed. */
const picture = (clip: TimelineClip): string =>
  JSON.stringify([
    clip.track,
    clip.zIndex,
    clip.mediaStart,
    clip.opacity,
    clip.colorGrade,
    clip.playbackRate,
    clip.automation,
  ]);

/** Level and lock state: changes nothing Vision can see. */
const level = (clip: TimelineClip): string =>
  JSON.stringify([clip.volume, clip.muted, clip.locked, clip.audioFx]);

const content = (clip: TimelineClip): string =>
  JSON.stringify([clip.kind, clip.src, clip.label, clip.compositionSrc]);

/**
 * What changed in the timeline from `before` to `after`, by clip id; null when the two cannot be compared clip by
 * clip (a different composition or canvas). A change outside the clips (captions, styles, graphics files) is invisible
 * here: it shows as zero changed clips, which the callers treat as "unknown, check everything".
 */
export function summarizeChange(
  before: TimelineSnapshot,
  after: TimelineSnapshot,
): ChangeSummary | null {
  const a = before.composition;
  const b = after.composition;
  if (a.path !== b.path || a.width !== b.width || a.height !== b.height) return null;
  const old = new Map(before.clips.map((clip) => [clip.id, clip]));
  const current = new Map(after.clips.map((clip) => [clip.id, clip]));
  let changed = 0;
  let audioOnly = true;
  let retimed = 0;
  let pictureChanged = false;
  for (const clip of after.clips) {
    const was = old.get(clip.id);
    if (!was) {
      changed += 1;
      pictureChanged = true;
      if (clip.kind !== "audio") audioOnly = false;
      continue;
    }
    if (content(was) !== content(clip)) {
      changed += 1;
      pictureChanged = true;
      if (clip.kind !== "audio" || was.kind !== "audio") audioOnly = false;
    } else if (picture(was) !== picture(clip)) {
      changed += 1;
      pictureChanged = true;
      if (clip.kind !== "audio") audioOnly = false;
    } else if (timing(was) !== timing(clip)) {
      changed += 1;
      retimed += 1;
      if (clip.kind !== "audio") audioOnly = false;
    } else if (level(was) !== level(clip)) {
      changed += 1;
    }
  }
  for (const clip of before.clips) {
    if (current.has(clip.id)) continue;
    changed += 1;
    pictureChanged = true;
    if (clip.kind !== "audio") audioOnly = false;
  }
  return { changed, audioOnly: changed > 0 && audioOnly, retimed, pictureChanged };
}

/**
 * The cheap-path rule: when the visual review can be skipped because the change cannot have damaged the picture
 * Vision judges. Only audio changed (`audio_only`: Vision cannot hear), or a few existing clips were only retimed
 * (`small_change`: the deterministic checks — flashes, gaps, black and frozen picture, cuts in words, layout — cover
 * what a retiming can break). Anything else, or a change nobody can size, gets the full review.
 */
export function visionSkipReason(change: ChangeSummary | null): QaScopeReason | null {
  if (change === null || change.changed === 0) return null;
  if (change.audioOnly) return "audio_only";
  if (!change.pictureChanged && change.retimed > 0 && change.retimed <= SMALL_CHANGE_CLIPS)
    return "small_change";
  return null;
}
