import {
  PROJECT_PARTS,
  type ExternalProjectEntry,
  type ProjectPart,
  type ProjectPartsSummary,
} from "@hyperframes/agent-protocol";

/** Projects one `#` popup lists (a scrolling list; there is no "show more"). */
export const PROJECT_MENU_LIMIT = 100;

const NOT_A_WORD = /[^\p{L}\p{M}\p{N}]+/gu;
const EDGE_DASHES = /^-+|-+$/g;

/**
 * The prompt token of a project name: lower case, every run of characters that are not letters or digits (in any
 * script) turned into one `-`. "My Promo!" is `my-promo`, "Мой проект" is `мой-проект`. A name with no letter at
 * all (an emoji, punctuation) is `project`.
 */
export function projectSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFC")
    .replace(NOT_A_WORD, "-")
    .replace(EDGE_DASHES, "");
  return slug === "" ? "project" : slug;
}

/**
 * One slug per project, unique among them: a second "Promo" becomes `promo-2`, a third `promo-3`. The projects are
 * taken in key order (not list order), so a project keeps its slug as the list reorders by what was opened last.
 */
export function projectSlugs(
  projects: readonly Pick<ExternalProjectEntry, "key" | "name">[],
): Map<string, string> {
  const slugs = new Map<string, string>();
  const taken = new Set<string>();
  const byKey = [...projects].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const project of byKey) {
    const base = projectSlug(project.name);
    let slug = base;
    for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${base}-${suffix}`;
    taken.add(slug);
    slugs.set(project.key, slug);
  }
  return slugs;
}

/**
 * The projects a `#` query points at: name or slug prefix first, then name or slug contains; the most recently
 * opened first within each (an empty query lists every project). A query nothing matches gives an empty list, and
 * the popup then stays closed: `#ff0000` and `#1` are colours and numbers, not a missing project.
 */
export function matchMentionProjects(
  projects: readonly ExternalProjectEntry[],
  slugs: ReadonlyMap<string, string>,
  query: string,
  limit = PROJECT_MENU_LIMIT,
): ExternalProjectEntry[] {
  const needle = query.toLowerCase().normalize("NFC");
  const ranked: { project: ExternalProjectEntry; rank: number; index: number }[] = [];
  for (const [index, project] of projects.entries()) {
    const name = project.name.toLowerCase().normalize("NFC");
    const slug = slugs.get(project.key) ?? projectSlug(project.name);
    let rank: number;
    if (needle === "" || name.startsWith(needle) || slug.startsWith(needle)) rank = 0;
    else if (name.includes(needle) || slug.includes(needle)) rank = 1;
    else continue;
    ranked.push({ project, rank, index });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      (b.project.openedAt ?? -Infinity) - (a.project.openedAt ?? -Infinity) ||
      a.index - b.index,
  );
  return ranked.slice(0, Math.max(0, limit)).map((item) => item.project);
}

/** One row of the parts checklist. `count` is null for the "all" row; a part with nothing in it is disabled. */
export interface PartRow {
  part: ProjectPart;
  count: number | null;
  disabled: boolean;
}

/** The parts of the checklist in the order it shows them: "all" first, then the parts the summary counts. */
const COUNTED_PARTS = PROJECT_PARTS.filter(
  (part): part is Exclude<ProjectPart, "all"> => part !== "all",
);

export function projectPartRows(summary: ProjectPartsSummary): PartRow[] {
  const rows: PartRow[] = COUNTED_PARTS.map((part) => {
    const count = summary.counts[part];
    return { part, count, disabled: count === 0 };
  });
  return [{ part: "all", count: null, disabled: rows.every((row) => row.disabled) }, ...rows];
}

/**
 * The checklist after `part` was toggled. "All" ticks and clears everything at once; with "All" ticked the other
 * rows show ticked too, and touching one of them unticks it alone and leaves the rest ticked. A row with nothing
 * in it cannot be toggled.
 */
export function toggleProjectPart(
  selected: ReadonlySet<ProjectPart>,
  part: ProjectPart,
  rows: readonly PartRow[],
): Set<ProjectPart> {
  const row = rows.find((candidate) => candidate.part === part);
  if (!row || row.disabled) return new Set(selected);
  if (part === "all") return selected.has("all") ? new Set() : new Set<ProjectPart>(["all"]);
  const next = selected.has("all")
    ? new Set(rows.filter((other) => other.part !== "all" && !other.disabled).map((o) => o.part))
    : new Set(selected);
  if (!next.delete(part)) next.add(part);
  return next;
}

/** Whether a row shows ticked: its own tick, or "All" standing for every part that has something in it. */
export function isPartChecked(selected: ReadonlySet<ProjectPart>, row: PartRow): boolean {
  if (selected.has(row.part)) return true;
  return selected.has("all") && row.part !== "all" && !row.disabled;
}

/** What the chip names: `["all"]` when "All" is ticked, else the ticked parts in the checklist's own order. */
export function chosenParts(selected: ReadonlySet<ProjectPart>): ProjectPart[] {
  if (selected.has("all")) return ["all"];
  return PROJECT_PARTS.filter((part) => selected.has(part));
}
