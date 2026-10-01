/**
 * Commit helpers for the motion-path overlay. Each maps a canvas gesture to a
 * GSAP source mutation routed through the (selection-bound) commit facade, which
 * handles the soft reload, undo snapshot, and save-failure feedback.
 */
import { t } from "../../i18n";
import type { MotionNodeRef } from "./motionPathGeometry";

export type CommitFn = (
  mutation: Record<string, unknown>,
  options: { label: string; softReload?: boolean },
) => Promise<void>;

const NEW_PATH_DURATION = 1.5;

export function commitNode(
  ref: MotionNodeRef,
  x: number,
  y: number,
  animationId: string,
  commit: CommitFn,
): Promise<void> {
  const mutation: Record<string, unknown> =
    ref.type === "keyframe"
      ? { type: "update-keyframe", animationId, percentage: ref.pct, properties: { x, y } }
      : { type: "update-motion-path-point", animationId, pointIndex: ref.index, x, y };
  return commit(mutation, {
    label:
      ref.type === "keyframe"
        ? t("editor.motionPath.moveKeyframe")
        : t("editor.motionPath.moveWaypoint"),
    softReload: true,
  });
}

export function commitAddWaypoint(
  animationId: string,
  index: number,
  x: number,
  y: number,
  commit: CommitFn,
): Promise<void> {
  return commit(
    { type: "add-motion-path-point", animationId, index, x, y },
    { label: t("editor.motionPath.addWaypoint"), softReload: true },
  );
}

export function commitAddKeyframe(
  animationId: string,
  percentage: number,
  x: number,
  y: number,
  commit: CommitFn,
): Promise<void> {
  // percentage is tween-relative (matches MotionNodeRef.keyframe.pct). The parser's
  // addKeyframeToScript inserts a new "P%": { x, y } stop (or merges if one exists
  // at that pct) and converts a flat tween to keyframes form when needed.
  return commit(
    { type: "add-keyframe", animationId, percentage, properties: { x, y } },
    { label: t("editor.motionPath.addKeyframe"), softReload: true },
  );
}

export function commitRemoveWaypoint(
  animationId: string,
  index: number,
  commit: CommitFn,
): Promise<void> {
  return commit(
    { type: "remove-motion-path-point", animationId, index },
    { label: t("editor.motionPath.removeWaypoint"), softReload: true },
  );
}

export function commitCreatePath(
  targetSelector: string,
  position: number,
  x: number,
  y: number,
  commit: CommitFn,
): Promise<void> {
  return commit(
    { type: "add-motion-path", targetSelector, position, duration: NEW_PATH_DURATION, x, y },
    { label: t("editor.motionPath.create"), softReload: true },
  );
}
