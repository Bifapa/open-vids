import type {
  StoryManualEdit,
  StorySyncAction,
  StorySyncReport,
  StorySyncSection,
  StorySyncUnit,
} from "@hyperframes/agent-protocol";
import { clock } from "../analysis/format.js";
import { cell, num } from "./text.js";

// ── Timeline sync ────────────────────────────────────────────────────────────

const SYNC_CHARS = 4_000;
const SYNC_SECTIONS = 12;
const SYNC_UNITS = 3;
const SYNC_EDITS = 8;
const SYNC_UNRELATED = 4;
const SYNC_WARNINGS = 5;

const ACTION_TEXT: Record<StorySyncAction, string> = {
  keep: "stays",
  shift: "moves with its section",
  rebuild: "rebuilt",
  add: "added",
  remove: "removed",
  keep_edited: "kept (holds manual edits)",
  keep_locked: "kept (locked)",
  skip: "skipped (outside the requested chapters)",
};

const span = (range: { start: number; end: number } | null) =>
  range ? `${clock(range.start)}–${clock(range.end)}` : "off the timeline";

const reasonText = (reasons: readonly string[]) => {
  const text = reasons.slice(0, 3).map(cell).join("; ");
  return text ? ` (${text.length > 160 ? `${text.slice(0, 159)}…` : text})` : "";
};

function ids(list: readonly string[]): string {
  if (list.length === 0) return "none";
  return list.length > 12
    ? `${list.slice(0, 12).join(", ")}, … +${list.length - 12}`
    : list.join(", ");
}

/** Titles and labels come from the user; one line of the sync view never gets longer than a few dozen of them. */
function short(text: string): string {
  const one = cell(text);
  return `"${one.length > 60 ? `${one.slice(0, 59)}…` : one}"`;
}

function editText(edit: StoryManualEdit): string {
  const by = edit.by === "user" ? " by the user" : edit.by === "ai" ? " by the AI" : "";
  const fields = edit.fields.length > 0 ? `: ${edit.fields.join(", ")}` : "";
  return `${edit.kind} ${short(edit.label)} (${edit.clip})${by}${fields}`;
}

/** A bounded bullet list of manual edits. */
export function editLines(edits: readonly StoryManualEdit[], limit = SYNC_EDITS): string[] {
  return [
    ...edits.slice(0, limit).map((edit) => `- ${editText(edit)}`),
    ...(edits.length > limit ? [`… ${edits.length - limit} more`] : []),
  ];
}

function reportUnits(report: StorySyncReport): StorySyncUnit[] {
  return [
    ...report.sections.flatMap((section) => section.units),
    ...report.music,
    ...(report.captions ? [report.captions] : []),
  ];
}

const isInteresting = (unit: StorySyncUnit) => unit.change !== "unchanged" || unit.edits.length > 0;

function unitLine(unit: StorySyncUnit, indent: string): string {
  const edited =
    unit.edits.length > 0
      ? `; ${unit.edits.length} manual ${unit.edits.length === 1 ? "edit" : "edits"}`
      : "";
  return `${indent}· ${unit.role.replace("_", "-")} ${unit.node} ${short(unit.title)}: ${unit.change}${reasonText(unit.reasons)} → ${ACTION_TEXT[unit.action]}${edited}`;
}

function sectionLines(section: StorySyncSection): string[] {
  const parts = [section.change === "unchanged" ? "content unchanged" : section.change];
  if (section.moved) parts.push("moves");
  if (section.locked) parts.push("LOCKED");
  const lines = [
    `- ${section.chapter} ${short(section.title)}: ${parts.join(", ")} · ${span(section.current)} → ${span(section.next)}${reasonText(section.reasons)}`,
  ];
  const units = section.units.filter(isInteresting);
  lines.push(...units.slice(0, SYNC_UNITS).map((unit) => unitLine(unit, "  ")));
  if (units.length > SYNC_UNITS) lines.push(`  · … ${units.length - SYNC_UNITS} more units`);
  return lines;
}

/**
 * How the timeline relates to the graph since the last build, as a rebuild would treat it: which sections and units
 * changed or moved, the manual edits to generated clips and who made them, conflicts, locked chapters that stay
 * pending, music/caption units, and the clips no chapter owns. Bounded: the summary comes first and the per-section
 * detail fills what is left of the budget. Null when there is nothing to say.
 */
export function syncSection(sync: StorySyncReport | null): string | null {
  if (!sync) return null;
  if (sync.state === "not_built")
    return "Timeline sync: the story is not on the timeline yet (build_story creates it).";
  if (sync.state === "untracked")
    return "Timeline sync: the timeline holds story clips built before synchronization existed; a rebuild cannot tell what changed — only the full build_story takes them over.";
  const edits = reportUnits(sync).flatMap((unit) => unit.edits);
  const bySplit = [
    `${edits.filter((edit) => edit.by === "user").length} by the user`,
    `${edits.filter((edit) => edit.by === "ai").length} by the AI`,
    ...(edits.some((edit) => edit.by === "unknown")
      ? [`${edits.filter((edit) => edit.by === "unknown").length} unattributed`]
      : []),
  ];
  const lines: string[] = [];
  if (sync.state === "in_sync") {
    lines.push(
      "Timeline sync: in sync — every built section matches the graph, there is nothing to rebuild.",
    );
  } else {
    lines.push(
      `Timeline sync: OUT OF SYNC — a rebuild would regenerate, add or remove ${sync.affected.length} ${sync.affected.length === 1 ? "section" : "sections"} (${ids(sync.affected)}) and move ${sync.moved.length} (${ids(sync.moved)}); length ${clock(sync.duration.current)} → ${clock(sync.duration.next)}.`,
    );
    if (sync.lockedPending.length > 0)
      lines.push(
        `Locked chapters with changes (rebuilt only when the user allows it in the Story workspace; they still move as a whole): ${ids(sync.lockedPending)}`,
      );
  }
  if (sync.manualEdits > 0) {
    lines.push(
      `Manual edits to generated clips: ${sync.manualEdits} (${bySplit.join(", ")})${sync.conflicts > 0 ? `; ${sync.conflicts} ${sync.conflicts === 1 ? "unit" : "units"} a rebuild must change hold edits — kept unless the user chose to replace them` : ""}:`,
      ...editLines(edits),
    );
  }
  if (sync.unrelated.length > 0) {
    const moving = sync.unrelated.filter((clip) => clip.shift !== 0);
    lines.push(
      `Unrelated clips (no chapter owns them; a rebuild never removes them): ${sync.unrelated.length}${
        moving.length > 0
          ? `; moving with their section: ${moving
              .slice(0, SYNC_UNRELATED)
              .map(
                (clip) => `${short(clip.label)} ${clip.shift > 0 ? "+" : ""}${num(clip.shift)} s`,
              )
              .join(", ")}${moving.length > SYNC_UNRELATED ? ", …" : ""}`
          : ""
      }`,
    );
  }
  lines.push(...sync.warnings.slice(0, SYNC_WARNINGS).map((warning) => `Sync warning: ${warning}`));
  if (sync.state === "out_of_sync") {
    const sideUnits = [...sync.music, ...(sync.captions ? [sync.captions] : [])].filter(
      (unit) => unit.change !== "unchanged",
    );
    if (sideUnits.length > 0)
      lines.push(
        "Music and captions that change:",
        ...sideUnits.slice(0, SYNC_UNITS).map((unit) => unitLine(unit, "  ")),
      );
    const shown = sync.sections.filter(
      (section) =>
        section.change !== "unchanged" ||
        section.moved ||
        sync.lockedPending.includes(section.chapter),
    );
    let budget = SYNC_CHARS - lines.join("\n").length - 60;
    let listed = 0;
    const details: string[] = [];
    for (const section of shown) {
      const block = sectionLines(section);
      const size = block.join("\n").length + 1;
      if (size > budget || listed >= SYNC_SECTIONS) break;
      details.push(...block);
      budget -= size;
      listed += 1;
    }
    if (shown.length > listed) details.push(`- … ${shown.length - listed} more sections`);
    if (details.length > 0) lines.push("Sections:", ...details);
  }
  const text = lines.join("\n");
  return text.length <= SYNC_CHARS
    ? text
    : `${text.slice(0, SYNC_CHARS - 40)}\n… more changes than shown`;
}
