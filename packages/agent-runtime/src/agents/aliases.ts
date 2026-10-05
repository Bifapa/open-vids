import {
  AGENT_DISPLAY_NAMES,
  SPECIALIST_IDS,
  type SpecialistId,
} from "@hyperframes/agent-protocol";

/**
 * Models write a specialist slightly wrong in the `agent` argument of `delegate` and `message_agent`: `_editor`,
 * `Editor`, `delegate_to_editor`, "Motion Designer". This reads all of those as the specialist they name.
 */

/** The shape a model plausibly meant: lower-case snake_case without namespace, wrapper underscores or a one-letter prefix. */
function stripped(value: string): string[] {
  const last = value.trim().split(/[.:/]/).at(-1) ?? "";
  const base = last
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withoutLetterPrefix = base.replace(/^[a-z]_(?=[a-z])/, "");
  return [...new Set([base, withoutLetterPrefix])].filter(Boolean);
}

/** The specialist a model named (`editor`, `_editor`, `Editor`, `delegate_to_editor`), or null. */
export function parseSpecialistName(value: unknown): SpecialistId | null {
  if (typeof value !== "string") return null;
  for (const candidate of stripped(value)) {
    const direct = SPECIALIST_IDS.find((id) => id === candidate);
    if (direct) return direct;
    const named = SPECIALIST_IDS.find(
      (id) =>
        candidate === `delegate_to_${id}` ||
        candidate === `ask_${id}` ||
        candidate === `${id}_agent` ||
        candidate === AGENT_DISPLAY_NAMES[id].toLowerCase().replace(/\s+/g, "_"),
    );
    if (named) return named;
  }
  return null;
}
