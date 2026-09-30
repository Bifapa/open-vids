/**
 * Reading the Story ↔ timeline sync report for the Story workspace: card badges, why Rebuild cannot run, and the
 * plan of a rebuild with the user's choices. Pure. The report is the service's dry run of a default rebuild (every
 * affected chapter, manual edits kept, no locked chapter allowed); `plannedAction` applies the documented
 * meaning of the other choices to it.
 */

import type {
  ManualEditPolicy,
  StoryActionOptions,
  StoryEditAuthor,
  StoryManualEdit,
  StorySyncAction,
  StorySyncChange,
  StorySyncReport,
  StorySyncRole,
  StorySyncSection,
  StorySyncUnit,
} from "@hyperframes/agent-protocol";
import { formatDuration } from "./storyFormat";

export type SyncBadgeKind = "changed" | "moves" | "edited" | "not_built" | "locked";

export interface SyncBadge {
  kind: SyncBadgeKind;
  label: string;
  /** The longer story behind the badge (its tooltip). */
  detail: string;
}

export const SYNC_ROLE_LABELS: Record<StorySyncRole, string> = {
  a_roll: "A-roll",
  b_roll: "B-roll",
  picture: "Picture",
  motion: "Motion",
  sfx: "Sound effect",
  music: "Music",
  captions: "Captions",
};

export const SYNC_ACTION_LABELS: Record<StorySyncAction, string> = {
  keep: "Keep",
  shift: "Move",
  rebuild: "Rebuild",
  add: "Add",
  remove: "Remove",
  keep_edited: "Keep edited",
  keep_locked: "Keep locked",
  skip: "Skip",
};

export const SYNC_CHANGE_LABELS: Record<StorySyncChange, string> = {
  unchanged: "In sync",
  changed: "Changed",
  added: "New",
  removed: "Removed",
};

export const EDIT_AUTHOR_LABELS: Record<StoryEditAuthor, string> = {
  user: "by you",
  ai: "by AI",
  unknown: "author unknown",
};

const EDIT_KIND_LABELS: Record<StoryManualEdit["kind"], string> = {
  modified: "changed",
  removed: "deleted",
  added: "copied",
};

/** `0:12–0:31`, or a dash for a section that is not (or no longer) on the timeline. */
export function formatSpan(span: { start: number; end: number } | null): string {
  return span ? `${formatDuration(span.start)}–${formatDuration(span.end)}` : "—";
}

/** What was done to a clip: `changed start, duration` / `deleted` / `copied`. */
export function describeEdit(edit: StoryManualEdit): string {
  const what = EDIT_KIND_LABELS[edit.kind];
  return edit.kind === "modified" && edit.fields.length > 0
    ? `${what} ${edit.fields.join(", ")}`
    : what;
}

export function sectionOf(
  report: StorySyncReport | null,
  chapter: string,
): StorySyncSection | undefined {
  return report?.sections.find((section) => section.chapter === chapter);
}

export function sectionEdits(section: StorySyncSection): StoryManualEdit[] {
  return section.units.flatMap((unit) => unit.edits);
}

/** "2 by you · 1 by AI". */
export function authorSplit(edits: readonly StoryManualEdit[]): string {
  const counts: Record<StoryEditAuthor, number> = { user: 0, ai: 0, unknown: 0 };
  for (const edit of edits) counts[edit.by] += 1;
  return (["user", "ai", "unknown"] as const)
    .flatMap((by) => (counts[by] > 0 ? [`${counts[by]} ${EDIT_AUTHOR_LABELS[by]}`] : []))
    .join(" · ");
}

/** The report describes built sections (a not-yet-built or untracked story has nothing to compare). */
function tracked(report: StorySyncReport | null): report is StorySyncReport {
  return report !== null && (report.state === "in_sync" || report.state === "out_of_sync");
}

/** A chapter card's badges: its section's status first, then its manual edits. Nothing when in sync. */
export function chapterBadges(report: StorySyncReport | null, chapter: string): SyncBadge[] {
  if (!tracked(report)) return [];
  const section = sectionOf(report, chapter);
  if (!section) return [];
  const badges: SyncBadge[] = [];
  const reasons = section.reasons.join("; ");
  if (report.lockedPending.includes(chapter)) {
    badges.push({
      kind: "locked",
      label: "Locked · pending",
      detail: `Locked, so a rebuild keeps it as built unless you allow it${reasons ? `: ${reasons}` : ""}`,
    });
  } else if (section.change === "added") {
    badges.push({
      kind: "not_built",
      label: "Not built",
      detail: "New since the last build: Rebuild affected adds it to the timeline",
    });
  } else if (section.change === "changed") {
    badges.push({
      kind: "changed",
      label: "Changed since build",
      detail: reasons || "The story changed since this section was built",
    });
  } else if (section.moved) {
    badges.push({
      kind: "moves",
      label: "Moves",
      detail: `A rebuild moves it ${formatSpan(section.current)} → ${formatSpan(section.next)}; its content stays`,
    });
  }
  const edits = sectionEdits(section);
  if (edits.length > 0) {
    badges.push({
      kind: "edited",
      label: `Edited on timeline · ${edits.length}`,
      detail: `Edited on the timeline after the build: ${authorSplit(edits)}`,
    });
  }
  return badges;
}

/** Every unit the report has: the sections', then music beds and captions. */
export function reportUnits(report: StorySyncReport): StorySyncUnit[] {
  return [
    ...report.sections.flatMap((section) => section.units),
    ...report.music,
    ...(report.captions ? [report.captions] : []),
  ];
}

/** A material card's badge: one of the units built for it changed since the build. */
export function materialBadge(report: StorySyncReport | null, node: string): SyncBadge | null {
  if (!tracked(report)) return null;
  const changed = reportUnits(report).filter(
    (unit) => unit.node === node && unit.role !== "a_roll" && unit.change !== "unchanged",
  );
  if (changed.length === 0) return null;
  const reasons = [...new Set(changed.flatMap((unit) => unit.reasons))].join("; ");
  return {
    kind: "changed",
    label: "Changed since build",
    detail: reasons || "The story changed since this material was built",
  };
}

/** Chapters a rebuild touches: regenerated, added or removed, then only moved. */
export function rebuildTargets(report: StorySyncReport | null): string[] {
  return report ? [...new Set([...report.affected, ...report.moved])] : [];
}

/** Why Rebuild affected cannot run from the report, or null when it can. */
export function syncBlocker(report: StorySyncReport | null): string | null {
  if (!report || report.state === "not_built") return "Not built yet";
  if (report.state === "untracked") return "Built before sync tracking — use Build Story";
  if (report.state === "in_sync") return "In sync with the timeline";
  return null;
}

/** The user's choices for a rebuild; `chapters` null = every affected section. */
export interface RebuildChoice {
  chapters: readonly string[] | null;
  manualEdits: ManualEditPolicy;
  allowLocked: readonly string[];
}

function actionFor(change: StorySyncChange): StorySyncAction {
  if (change === "added") return "add";
  if (change === "removed") return "remove";
  return "rebuild";
}

/**
 * What the rebuild does with a unit under `choice`: an allowed locked chapter is regenerated (its edits kept under
 * `keep`), `replace` regenerates edited units, and a section outside `chapters` is not regenerated — though a
 * chapter that left the story is still removed ("order and removals always apply").
 */
export function plannedAction(
  unit: StorySyncUnit,
  section: StorySyncSection | null,
  choice: RebuildChoice,
): StorySyncAction {
  let action = unit.action;
  if (action === "keep_locked" && section && choice.allowLocked.includes(section.chapter)) {
    action =
      unit.change === "unchanged"
        ? "keep"
        : unit.edits.length > 0
          ? "keep_edited"
          : actionFor(unit.change);
  }
  if (action === "keep_edited" && choice.manualEdits === "replace") action = actionFor(unit.change);
  const outside =
    section !== null &&
    choice.chapters !== null &&
    !choice.chapters.includes(section.chapter) &&
    section.change !== "removed";
  if (outside && action !== "keep" && action !== "shift") return "skip";
  return action;
}

/** Sections the dialog lists: every section with something to say, or the chosen ones plus what always applies. */
export function plannedSections(
  report: StorySyncReport,
  chapters: readonly string[] | null,
): { chosen: StorySyncSection[]; alsoApplies: StorySyncSection[] } {
  const relevant = report.sections.filter(
    (section) =>
      section.change !== "unchanged" || section.moved || sectionEdits(section).length > 0,
  );
  if (!chapters) return { chosen: relevant, alsoApplies: [] };
  return {
    chosen: report.sections.filter((section) => chapters.includes(section.chapter)),
    alsoApplies: relevant.filter(
      (section) =>
        !chapters.includes(section.chapter) && (section.change === "removed" || section.moved),
    ),
  };
}

/** Locked chapters with changes the chosen rebuild could regenerate if the user allows them. */
export function lockedChoices(
  report: StorySyncReport,
  chapters: readonly string[] | null,
): string[] {
  return report.lockedPending.filter((chapter) => !chapters || chapters.includes(chapter));
}

export interface EditInSection {
  edit: StoryManualEdit;
  /** Section title, or the unit's title for music and captions. */
  where: string;
}

/** The units in scope a rebuild must change although they hold manual edits (under the default `keep`). */
export function conflictingEdits(report: StorySyncReport, choice: RebuildChoice): EditInSection[] {
  const keep: RebuildChoice = { ...choice, manualEdits: "keep" };
  const found: EditInSection[] = [];
  for (const section of report.sections) {
    for (const unit of section.units) {
      if (plannedAction(unit, section, keep) === "keep_edited") {
        found.push(...unit.edits.map((edit) => ({ edit, where: section.title })));
      }
    }
  }
  for (const unit of [...report.music, ...(report.captions ? [report.captions] : [])]) {
    if (plannedAction(unit, null, keep) === "keep_edited") {
      found.push(...unit.edits.map((edit) => ({ edit, where: unit.title })));
    }
  }
  return found;
}

/** Every manual edit to generated material, with where it is: what a full build replaces. */
export function allEdits(report: StorySyncReport): EditInSection[] {
  return [
    ...report.sections.flatMap((section) =>
      sectionEdits(section).map((edit) => ({ edit, where: section.title })),
    ),
    ...[...report.music, ...(report.captions ? [report.captions] : [])].flatMap((unit) =>
      unit.edits.map((edit) => ({ edit, where: unit.title })),
    ),
  ];
}

/** Locked chapters whose built section a full build keeps unless the user allows it. */
export function lockedBuiltSections(report: StorySyncReport): StorySyncSection[] {
  return report.sections.filter(
    (section) =>
      section.locked &&
      (section.current !== null || report.lockedPending.includes(section.chapter)),
  );
}

/** A full build replaces manual edits or meets locked built sections: the user confirms it first. */
export function fullBuildNeedsConfirm(report: StorySyncReport | null): boolean {
  if (!report || report.state === "not_built") return false;
  return report.manualEdits > 0 || lockedBuiltSections(report).length > 0;
}

export function rebuildOptions(choice: RebuildChoice): StoryActionOptions {
  return {
    manualEdits: choice.manualEdits,
    ...(choice.allowLocked.length > 0 && { allowLocked: [...choice.allowLocked] }),
    ...(choice.chapters && { chapters: [...choice.chapters] }),
  };
}
