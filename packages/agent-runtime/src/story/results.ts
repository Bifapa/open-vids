import {
  isChapter,
  type StoryBuildResult,
  type StoryEditResponse,
  type StoryRebuildResult,
  type StoryView,
} from "@hyperframes/agent-protocol";
import { clock } from "../analysis/format.js";
import { StoryToolError } from "./host.js";
import { editLines } from "./syncText.js";
import { cap, duration, num, quoted } from "./text.js";

/** What the model sees for an applied batch: the operations' results and the story's new shape. */
export function formatStoryEdit(response: StoryEditResponse): string {
  const rows = response.results.map(
    (result, index) => `${index + 1}. ${result.op}${result.id ? ` → ${result.id}` : ""}`,
  );
  const { view } = response;
  const graph = view.graph;
  const summary = graph
    ? `Story now: ${graph.nodes.filter(isChapter).length} chapters, ${graph.nodes.length - graph.nodes.filter(isChapter).length} materials, ${graph.attachments.length} attachments, version ${view.version ?? "unsaved"}. Play order: ${view.order.chapters.join(" → ") || "none"}.`
    : "The story is still empty.";
  return cap(
    [
      `Applied ${response.results.length} ${response.results.length === 1 ? "operation" : "operations"}. The Story canvas updates by itself and the change belongs to this turn's checkpoint.`,
      ...rows.slice(0, 60),
      ...(rows.length > 60 ? [`… ${rows.length - 60} more`] : []),
      summary,
    ].join("\n"),
  );
}

export function formatStoryBuild(result: StoryBuildResult): string {
  const lines = [
    result.dryRun
      ? `Dry run (nothing was written): the story would build ${duration(result.duration)} on ${result.composition}.`
      : `Built the story on ${result.composition}: ${duration(result.duration)}, timeline version ${result.timelineVersion}. The Studio timeline and preview update by themselves.`,
    "Chapters on the timeline:",
    ...result.chapters.map(
      (chapter) =>
        `- ${chapter.node} ${quoted(chapter.title)} ${clock(chapter.start)}–${clock(chapter.end)} (estimated ${num(chapter.estimatedDuration)} s, ${chapter.clips} ${chapter.clips === 1 ? "clip" : "clips"})`,
    ),
  ];
  if (result.materials.length > 0) {
    const perChapter = new Map<string, number>();
    for (const material of result.materials)
      perChapter.set(material.chapter, (perChapter.get(material.chapter) ?? 0) + 1);
    lines.push(
      `Material placed: ${result.materials.length} (${[...perChapter].map(([chapter, n]) => `${chapter} ${n}`).join(", ")}).`,
    );
  }
  lines.push(
    `Replaced ${result.removedClips} earlier ${result.removedClips === 1 ? "clip" : "clips"}; kept ${result.keptClips} ${result.keptClips === 1 ? "clip" : "clips"} (manual additions and cutaways on other tracks, locked sections).`,
  );
  if (result.replacedEdits.length > 0)
    lines.push(
      `Manual edits to generated clips that the build replaced (${result.replacedEdits.length}):`,
      ...editLines(result.replacedEdits),
    );
  if (result.keptLocked.length > 0)
    lines.push(
      `Locked chapters whose built section was kept as it was: ${chapterList(
        result.keptLocked,
        titlesOf(
          result.view,
          result.chapters.map((chapter) => [chapter.node, chapter.title]),
        ),
      )} (only the user can allow rebuilding them).`,
    );
  if (result.captions)
    lines.push(`Captions: ${result.captions.cues} cues in the ${result.captions.preset} preset.`);
  if (result.warnings.length > 0)
    lines.push("Warnings:", ...result.warnings.slice(0, 40).map((warning) => `- ${warning}`));
  if (!result.dryRun) lines.push("Verify the result with inspect_timeline.");
  return cap(lines.join("\n"));
}

/** Chapter titles by id: the graph's, then the ones a result names for chapters that left it. */
function titlesOf(view: StoryView, named: Array<[string, string]> = []): Map<string, string> {
  const titles = new Map(named);
  for (const node of view.graph?.nodes ?? []) titles.set(node.id, node.title);
  return titles;
}

function chapterList(list: readonly string[], titles: ReadonlyMap<string, string>): string {
  if (list.length === 0) return "none";
  return list
    .map((id) => {
      const title = titles.get(id);
      return title ? `${id} ${quoted(title)}` : id;
    })
    .join(", ");
}

/** What the model sees for a rebuild: which chapters were rebuilt/removed/moved, the manual edits kept or replaced. */
export function formatStoryRebuild(result: StoryRebuildResult): string {
  const titles = titlesOf(
    result.view,
    result.report.sections.map((section) => [section.chapter, section.title]),
  );
  const length = duration(result.duration);
  const heldBack = !result.changed && result.report.state === "out_of_sync";
  const lines = [
    result.changed
      ? result.dryRun
        ? `Dry run (nothing was written): the rebuild would change ${result.composition}; it would be ${length} long.`
        : `Rebuilt the affected sections on ${result.composition}: ${length}, timeline version ${result.timelineVersion}. The Studio timeline and preview update by themselves.`
      : heldBack
        ? `Nothing was written: the story still differs from the timeline on ${result.composition} (${length}), but every remaining change is held back — manual edits kept, locked chapters the user has not allowed, or chapters outside this rebuild's scope (listed below). The user decides in the Story workspace.`
        : `Already in sync: the timeline on ${result.composition} matches the story (${length}); nothing to rebuild and nothing was written.`,
  ];
  if (result.changed) {
    const dry = result.dryRun;
    lines.push(
      `${dry ? "Would be rebuilt" : "Rebuilt"} (regenerated or built for the first time): ${chapterList(result.rebuilt, titles)}`,
      `${dry ? "Would be removed" : "Removed"} (taken off the timeline): ${chapterList(result.removed, titles)}`,
      `${dry ? "Would move" : "Moved"} (content untouched): ${chapterList(result.moved, titles)}`,
    );
  }
  if (heldBack) {
    const skipped = result.report.sections
      .filter((section) => section.units.some((unit) => unit.action === "skip"))
      .map((section) => section.chapter);
    if (skipped.length > 0)
      lines.push(`Changed but outside this rebuild's scope: ${chapterList(skipped, titles)}`);
  }
  if (result.keptEdits.length > 0)
    lines.push(
      `Manual edits kept although the story changed that unit (${result.keptEdits.length}):`,
      ...editLines(result.keptEdits),
    );
  if (result.replacedEdits.length > 0)
    lines.push(
      `Manual edits ${result.dryRun ? "that would be replaced" : "replaced by the rebuild"} (${result.replacedEdits.length}):`,
      ...editLines(result.replacedEdits),
    );
  if (result.keptLocked.length > 0)
    lines.push(
      `Locked chapters with changes that were not rebuilt (the user has to allow them in the Story workspace): ${chapterList(result.keptLocked, titles)}`,
    );
  if (result.warnings.length > 0)
    lines.push("Warnings:", ...result.warnings.slice(0, 40).map((warning) => `- ${warning}`));
  if (result.changed && !result.dryRun) lines.push("Verify the result with inspect_timeline.");
  return cap(lines.join("\n"));
}

/** What the model sees for a refused call: a stable code, the failing operation of a batch, the message. */
export function formatStoryError(error: StoryToolError): string {
  const where = error.opIndex !== undefined ? ` (operations[${error.opIndex}])` : "";
  return `${error.code}${where}: ${error.message}`;
}
