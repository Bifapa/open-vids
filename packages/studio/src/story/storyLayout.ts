/**
 * "Tidy up": a readable arrangement of the Story Graph, as in the prototype's auto layout. Chapters sit in one row in
 * play order; each material stacks under the first chapter it is attached to (motion presets above it); materials
 * attached nowhere line up after the last chapter. Pure; positions are canvas-only, so the result is one undoable
 * move.
 */

import { storyOrder, type StoryGraph, type StoryPoint } from "@hyperframes/agent-protocol";

const CHAPTER_WIDTH = 232;
const MATERIAL_WIDTH = 184;
const PITCH = 320;
const GAP = 14;
/** Room between a chapter's bottom edge and its first material (the rail turns in it). */
const BELOW = 60;
const ABOVE = 64;

/** `height(id)` is the card's measured height, or null before React Flow measured it. */
export function tidyLayout(
  graph: StoryGraph,
  height: (id: string) => number | null,
): Map<string, StoryPoint> {
  const positions = new Map<string, StoryPoint>();
  const chapters = storyOrder(graph).chapters;
  const column = new Map(chapters.map((id, index) => [id, index]));
  const chapterHeight = Math.max(202, ...chapters.map((id) => height(id) ?? 0));
  chapters.forEach((id, index) => positions.set(id, { x: index * PITCH, y: 0 }));

  const below = new Map(chapters.map((id) => [id, chapterHeight + BELOW]));
  const above = new Map(chapters.map((id) => [id, -ABOVE]));
  let loose = chapters.length * PITCH;
  for (const node of graph.nodes) {
    if (node.kind === "chapter") continue;
    const cardHeight = height(node.id) ?? (node.kind === "motion" ? 72 : 48);
    const homes = graph.attachments
      .filter((attachment) => attachment.node === node.id)
      .map((attachment) => attachment.chapter)
      .filter((chapter) => column.has(chapter))
      .sort((a, b) => (column.get(a) ?? 0) - (column.get(b) ?? 0));
    const home = homes[0];
    if (home === undefined) {
      positions.set(node.id, { x: loose, y: chapterHeight + BELOW });
      loose += MATERIAL_WIDTH + 24;
      continue;
    }
    const x = (column.get(home) ?? 0) * PITCH + (CHAPTER_WIDTH - MATERIAL_WIDTH) / 2;
    if (node.kind === "motion") {
      const bottom = above.get(home) ?? -ABOVE;
      positions.set(node.id, { x, y: bottom - cardHeight });
      above.set(home, bottom - cardHeight - GAP);
    } else {
      const top = below.get(home) ?? chapterHeight + BELOW;
      positions.set(node.id, { x, y: top });
      below.set(home, top + cardHeight + GAP);
    }
  }
  return positions;
}
