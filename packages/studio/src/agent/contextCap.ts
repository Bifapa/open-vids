import type { EditorContext } from "@hyperframes/agent-protocol";

/** The timeline clips a message carries out of the clips the timeline has, when the editor context was capped. */
export interface ContextCap {
  sent: number;
  total: number;
}

/**
 * Null while the whole timeline travels with the message; otherwise how many of its clips do. The context lists at
 * most `LIMITS.contextElements` timeline clips while `elementCount` stays the true total, so the composer says so
 * instead of letting the agent work from a list the user thinks is complete.
 */
export function contextCap(context: EditorContext): ContextCap | null {
  const { elementCount, elements } = context.timeline;
  return elementCount > elements.length ? { sent: elements.length, total: elementCount } : null;
}
