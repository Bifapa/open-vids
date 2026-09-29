import {
  scalePositionsInScript,
  shiftPositionsInScript,
  splitAnimationsInScript,
  syncPositionHoldsBeforeKeyframes,
} from "@hyperframes/parsers/gsap-writer-acorn";
import { extractGsapScriptBlock } from "../helpers/gsapScript.js";

/**
 * Keeps a composition's GSAP tweens in step with the clip they animate, the way Studio does after a move, a
 * resize and a razor cut: the same acorn writer functions its `/gsap-mutations` route runs, followed by the
 * same hold re-sync. A clip without a DOM id has no selector a tween could target, so callers skip those.
 * Compositions with no GSAP script come back unchanged.
 */
function rewriteScript(html: string, rewrite: (script: string) => string): string {
  const block = extractGsapScriptBlock(html);
  if (!block) return html;
  const rewritten = rewrite(block.scriptText);
  if (rewritten === block.scriptText) return html;
  return block.replaceScript(syncPositionHoldsBeforeKeyframes(rewritten));
}

export function shiftClipTweens(html: string, domId: string, delta: number): string {
  if (!Number.isFinite(delta) || delta === 0) return html;
  return rewriteScript(html, (script) => shiftPositionsInScript(script, `#${domId}`, delta));
}

export function scaleClipTweens(
  html: string,
  domId: string,
  from: { start: number; duration: number },
  to: { start: number; duration: number },
): string {
  if (from.duration <= 0 || to.duration <= 0) return html;
  if (from.start === to.start && from.duration === to.duration) return html;
  return rewriteScript(html, (script) =>
    scalePositionsInScript(script, `#${domId}`, from.start, from.duration, to.start, to.duration),
  );
}

export function splitClipTweens(
  html: string,
  split: {
    originalId: string;
    newId: string;
    splitTime: number;
    elementStart: number;
    elementDuration: number;
  },
): string {
  return rewriteScript(html, (script) => splitAnimationsInScript(script, split).script);
}
