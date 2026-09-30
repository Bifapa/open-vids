import {
  isChapter,
  storyOrder,
  type StoryGraph,
  type StoryNode,
} from "@hyperframes/agent-protocol";

/** Card sizes the canvas draws (chapters larger than material cards); used to keep new nodes from overlapping. */
export const CHAPTER_SIZE = { width: 280, height: 200 } as const;
export const MATERIAL_SIZE = { width: 220, height: 150 } as const;
const GAP = 40;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const sizeOf = (node: StoryNode) => (isChapter(node) ? CHAPTER_SIZE : MATERIAL_SIZE);

const rectOf = (node: StoryNode): Rect => ({ ...node.position, ...sizeOf(node) });

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width + GAP / 2 &&
  b.x < a.x + a.width + GAP / 2 &&
  a.y < b.y + b.height + GAP / 2 &&
  b.y < a.y + a.height + GAP / 2;

/** Moves `start` along `step` until it clears every occupied rectangle. */
function freeSpot(
  start: { x: number; y: number },
  size: { width: number; height: number },
  occupied: readonly Rect[],
  step: { dx: number; dy: number },
): { x: number; y: number } {
  let { x, y } = start;
  for (let guard = 0; guard < 10_000; guard++) {
    const candidate = { x, y, ...size };
    if (!occupied.some((rect) => overlaps(candidate, rect))) break;
    x += step.dx;
    y += step.dy;
  }
  return { x, y };
}

/**
 * Places the nodes an agent just added (`newIds`); every other node keeps its position. Chapters go in a row in play
 * order to the right of the existing chapters, materials go below the chapter they attach to (the first one in play
 * order), and unattached materials go in a lane under everything. Nothing lands on an existing node.
 */
export function layoutNewNodes(graph: StoryGraph, newIds: ReadonlySet<string>): void {
  const fresh = graph.nodes.filter((node) => newIds.has(node.id));
  if (fresh.length === 0) return;
  const existing = graph.nodes.filter((node) => !newIds.has(node.id));
  const occupied: Rect[] = existing.map(rectOf);

  // Play order among the new chapters: connected ones follow their edges, loose ones the order they were added.
  const newChapters = fresh.filter(isChapter);
  newChapters.forEach((chapter, index) => {
    chapter.position = { x: 1_000_000 + index, y: 0 };
  });
  const order = storyOrder(graph).chapters;

  const existingChapters = existing.filter(isChapter);
  const rowY =
    existingChapters.length > 0 ? Math.min(...existingChapters.map((c) => c.position.y)) : 0;
  let nextX =
    existingChapters.length > 0
      ? Math.max(...existingChapters.map((c) => c.position.x)) + CHAPTER_SIZE.width + GAP
      : 0;
  const newChapterIds = new Set(newChapters.map((chapter) => chapter.id));
  for (const id of order) {
    if (!newChapterIds.has(id)) continue;
    const chapter = newChapters.find((entry) => entry.id === id);
    if (!chapter) continue;
    chapter.position = freeSpot({ x: nextX, y: rowY }, CHAPTER_SIZE, occupied, {
      dx: CHAPTER_SIZE.width + GAP,
      dy: 0,
    });
    occupied.push(rectOf(chapter));
    nextX = chapter.position.x + CHAPTER_SIZE.width + GAP;
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const rank = new Map(order.map((id, index) => [id, index]));
  let lane: { x: number; y: number } | null = null;
  for (const node of fresh) {
    if (isChapter(node)) continue;
    const homes = graph.attachments
      .filter((attachment) => attachment.node === node.id)
      .map((attachment) => byId.get(attachment.chapter))
      .filter((chapter): chapter is StoryNode => chapter !== undefined)
      .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    const home = homes[0];
    let spot: { x: number; y: number };
    if (home) {
      spot = freeSpot(
        {
          x: home.position.x + (CHAPTER_SIZE.width - MATERIAL_SIZE.width) / 2,
          y: home.position.y + CHAPTER_SIZE.height + GAP,
        },
        MATERIAL_SIZE,
        occupied,
        { dx: 0, dy: MATERIAL_SIZE.height + GAP },
      );
    } else {
      const all = occupied;
      lane ??= {
        x: all.length > 0 ? Math.min(...all.map((rect) => rect.x)) : 0,
        y: all.length > 0 ? Math.max(...all.map((rect) => rect.y + rect.height)) + GAP * 2 : 0,
      };
      spot = freeSpot(lane, MATERIAL_SIZE, occupied, { dx: MATERIAL_SIZE.width + GAP, dy: 0 });
    }
    node.position = spot;
    occupied.push(rectOf(node));
  }
}
