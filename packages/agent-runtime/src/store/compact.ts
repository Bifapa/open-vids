import type { ChatEvent } from "@hyperframes/agent-protocol";
import { isTurnTerminalEvent } from "@hyperframes/agent-protocol";

/**
 * The key a state-like event is merged under, or null for an event that is kept as it is. Events with the same key
 * collapse into one: it stays at the position of the first (so the order in which parts first appeared in a message is
 * unchanged) and carries what the last one said.
 */
function mergeKey(event: ChatEvent): string | null {
  switch (event.type) {
    case "assistant.text.delta":
      return `${event.type}:${event.messageId}:${event.partId}`;
    case "thinking.updated":
      // The closing event stays: the part's end time is that event's own time.
      return event.done ? null : `${event.type}:${event.messageId}:${event.partId}`;
    case "activity.updated":
      return `activity:${event.messageId}:${event.activity.id}`;
    case "permission.updated":
      return `permission:${event.messageId}:${event.permission.id}`;
    case "question.updated":
      return `question:${event.messageId}:${event.question.id}`;
    case "storyOffer.updated":
      return `offer:${event.messageId}:${event.offer.id}`;
    case "usage.updated":
      return `usage:${event.turnId}:${event.runId ?? ""}`;
    case "qa.updated":
      return `qa:${event.turnId}`;
    case "plan.updated":
      return `plan:${event.turnId}`;
    case "agent.updated":
      return `agent:${event.run.id}`;
    default:
      return null;
  }
}

/** One event that stands for several: `latest` is the last of them, text and thinking text is concatenated. */
function mergeInto(first: ChatEvent, next: ChatEvent): ChatEvent {
  if (first.type === "assistant.text.delta" && next.type === "assistant.text.delta") {
    return { ...first, delta: first.delta + next.delta };
  }
  if (first.type === "thinking.updated" && next.type === "thinking.updated") {
    return { ...first, delta: first.delta + next.delta };
  }
  return { ...next, seq: first.seq, ts: first.ts };
}

/**
 * Collapses the events of finished turns into their final form: every run of text deltas of a part becomes one delta,
 * every activity/permission/usage/... update of one entity becomes its last version. Events after the last terminal
 * event of a turn (a turn that may still be running) are not touched. The result folds to the same state as the
 * input; the caller verifies that before replacing a log.
 */
export function compactEvents(events: readonly ChatEvent[]): ChatEvent[] {
  let boundary = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && isTurnTerminalEvent(event)) {
      boundary = index;
      break;
    }
  }
  if (boundary < 0) return [...events];

  const slot = new Map<string, number>();
  const out: ChatEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    const key = index <= boundary ? mergeKey(event) : null;
    if (key === null) {
      out.push(event);
      continue;
    }
    const at = slot.get(key);
    const first = at === undefined ? undefined : out[at];
    if (at === undefined || first === undefined) {
      slot.set(key, out.length);
      out.push(event);
    } else {
      out[at] = mergeInto(first, event);
    }
  }
  return out;
}

/** Deep equality of two plain values (records compared regardless of key order). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    );
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const keysA = Object.keys(a).filter((key) => Reflect.get(a, key) !== undefined);
  const keysB = Object.keys(b).filter((key) => Reflect.get(b, key) !== undefined);
  return (
    keysA.length === keysB.length &&
    keysA.every(
      (key) => Object.hasOwn(b, key) && sameValue(Reflect.get(a, key), Reflect.get(b, key)),
    )
  );
}
