import type { TimelineElement } from "../store/playerStore";
import { getTimelineEditCapabilities } from "./timelineEditing";
import { round3, TRACK_GAP_EPSILON_S } from "./timelineGaps";

/**
 * Ripple for a clip whose LENGTH changed by something other than a drag (a voiceover take of another length): the
 * clips after it on the same track move by the difference, so the gap it opens closes and the overlap it would
 * make never happens. The decision is pure: the caller persists the moves itself, in the same undo entry as the
 * length change (the way a delete folds its ripple in, `resolveMainTrackDeleteRippleShifts`).
 */

const keyOf = (element: TimelineElement) => element.key ?? element.id;

export interface DurationChange {
  /** The clip as the timeline holds it now. */
  element: TimelineElement;
  /** Its length after the change, seconds. */
  duration: number;
}

export type DurationRipple =
  /** Nothing moves: ripple is off, no clip follows, or no length changed. */
  | { kind: "none" }
  /**
   * A clip that would have to move is locked. The whole ripple is refused (never a partial compaction, like the
   * track-gap menu and the delete ripple); the length change itself is the caller's to apply or refuse.
   */
  | { kind: "locked"; lockedKeys: string[] }
  | {
      kind: "shift";
      /** The new start of every clip that moves, the changed clips pushed by an earlier change included. */
      starts: Map<string, number>;
      /** Clips that moved without a length change of their own: the "Shifted N clips" of the notice. */
      shiftedKeys: string[];
    };

function laneOf(element: TimelineElement): string {
  return `${element.sourceFile ?? ""}\0${element.track}`;
}

/**
 * The starts after `changes` on every track they touch. A clip is "later" when it starts at or after the changed
 * clip's old end; it moves by the sum of the length differences of the changed clips before it, so two
 * back-to-back lines that both grow push the third by both.
 */
export function resolveDurationRipple(
  elements: readonly TimelineElement[],
  changes: readonly DurationChange[],
  rippleEnabled: boolean,
): DurationRipple {
  if (!rippleEnabled) return { kind: "none" };
  const deltas = changes
    .map(({ element, duration }) => ({ element, delta: round3(duration - element.duration) }))
    .filter(({ delta }) => Math.abs(delta) > TRACK_GAP_EPSILON_S);
  if (deltas.length === 0) return { kind: "none" };

  const changedKeys = new Set(changes.map(({ element }) => keyOf(element)));
  const lanes = new Set(deltas.map(({ element }) => laneOf(element)));
  const starts = new Map<string, number>();
  const shiftedKeys: string[] = [];
  const lockedKeys: string[] = [];

  for (const element of elements) {
    if (!lanes.has(laneOf(element))) continue;
    const offset = deltas
      .filter(
        ({ element: changed }) =>
          keyOf(changed) !== keyOf(element) &&
          laneOf(changed) === laneOf(element) &&
          changed.start + changed.duration <= element.start + TRACK_GAP_EPSILON_S,
      )
      .reduce((sum, { delta }) => sum + delta, 0);
    if (offset === 0) continue;
    const start = round3(Math.max(0, element.start + offset));
    if (Math.abs(start - element.start) <= TRACK_GAP_EPSILON_S) continue;
    if (!getTimelineEditCapabilities(element).canMove) {
      lockedKeys.push(keyOf(element));
      continue;
    }
    starts.set(keyOf(element), start);
    if (!changedKeys.has(keyOf(element))) shiftedKeys.push(keyOf(element));
  }

  if (lockedKeys.length > 0) return { kind: "locked", lockedKeys };
  if (starts.size === 0) return { kind: "none" };
  return { kind: "shift", starts, shiftedKeys };
}
