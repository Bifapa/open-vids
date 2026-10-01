/**
 * Dropping a Media item on a Story chapter: the same edit the Story canvas makes when the user adds a material node and
 * connects it to a chapter (a material node for the asset, attached to the chapter), as one undo step. Pure — tested.
 */

import {
  isChapter,
  storyOrder,
  type ChapterNode,
  type StoryGraph,
} from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import { addNode, connectNodes, newMaterial, newStoryId } from "../story/storyGraphOps";
import type { MediaItem } from "./mediaLibrary";

const MATERIAL_KIND = { video: "video", image: "picture", audio: "music" } as const;

/** The graph's chapters in play order (the drop tray and "Add to Story" list them this way). */
export function chaptersInOrder(graph: StoryGraph): ChapterNode[] {
  const byId = new Map(graph.nodes.filter(isChapter).map((chapter) => [chapter.id, chapter]));
  return storyOrder(graph).chapters.flatMap((id) => byId.get(id) ?? []);
}

export type StoryDropResult = { ok: true; graph: StoryGraph } | { ok: false; reason: string };

/**
 * Adds a material node for `item` below the chapter and attaches it. With `chapterId` null the node is placed
 * unconnected, to the right of the canvas content.
 */
export function attachMediaToStory(
  graph: StoryGraph,
  item: Pick<MediaItem, "kind" | "path" | "name">,
  chapterId: string | null,
): StoryDropResult {
  if (item.kind === "font") return { ok: false, reason: t("media.story.noFonts") };
  const chapter = chapterId ? graph.nodes.find((node) => node.id === chapterId) : undefined;
  if (chapterId && (!chapter || !isChapter(chapter))) {
    return { ok: false, reason: t("media.story.noChapter") };
  }
  const attachedCount = chapter
    ? graph.attachments.filter((attachment) => attachment.chapter === chapter.id).length
    : 0;
  const rightmost = graph.nodes.reduce((max, node) => Math.max(max, node.position.x), 0);
  const position = chapter
    ? {
        x: chapter.position.x + attachedCount * 40,
        y: chapter.position.y + 220 + attachedCount * 30,
      }
    : { x: rightmost + 320, y: 0 };
  const node = newMaterial(newStoryId(graph, "n"), position, {
    kind: MATERIAL_KIND[item.kind],
    source: item.path,
    title: item.name.replace(/\.[^.]+$/, ""),
  });
  if (!node) return { ok: false, reason: t("media.story.noNode") };
  const added = addNode(graph, node);
  if (!added.ok || !chapter) return added;
  const connected = connectNodes(added.graph, { source: node.id, target: chapter.id });
  return connected.ok ? { ok: true, graph: connected.graph } : connected;
}
