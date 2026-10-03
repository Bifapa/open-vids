import { useMemo, useRef, useState, type DragEvent, type ReactNode, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { Paperclip } from "@phosphor-icons/react";
import { isChapter } from "@hyperframes/agent-protocol";
import { hasFileDrag, hasProjectFileDrag } from "../agent/composerAttachments";
import { useFileManagerContextOptional } from "../contexts/FileManagerContext";
import { useTranslation } from "../i18n";
import { useStoryServices } from "./storyContext";
import { dropOnStory, type StoryDropPlace } from "./storyDrop";

export interface StoryDropTarget {
  handlers: {
    onDragEnter: (event: DragEvent) => void;
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
  /** The hint shown over the panel while a droppable drag is above it. */
  overlay: ReactNode;
}

/**
 * Makes the Story panel a drop target: OS files and Media / file tree drags become material nodes (see `dropOnStory`).
 * Every drop on the panel is claimed, so Studio's global handler never also puts the file on the timeline; a drop
 * beside the canvas (toolbar, inspector) lands at the canvas centre. `canvasRef` is the element the graph is drawn in.
 */
export function useStoryDrop(canvasRef: RefObject<HTMLElement | null>): StoryDropTarget {
  const { t } = useTranslation();
  const { store } = useStoryServices();
  const flow = useReactFlow();
  const files = useFileManagerContextOptional();
  const projectFiles = useMemo(() => new Set(files?.fileTree ?? []), [files?.fileTree]);
  // dragenter/dragleave fire for every child the pointer crosses: the overlay lives while the depth is positive.
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  const accepts = (event: DragEvent) =>
    hasFileDrag(event.dataTransfer) || hasProjectFileDrag(event.dataTransfer);

  /** Where the pointer is on the graph, and which chapter card is under it. */
  const placeOf = (event: DragEvent): StoryDropPlace => {
    const graph = store.getState().graph;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!graph || !rect || rect.width === 0) return { point: { x: 0, y: 0 }, chapterId: null };
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    const point = flow.screenToFlowPosition(
      inside
        ? { x: event.clientX, y: event.clientY }
        : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    );
    const chapters = new Set(graph.nodes.filter(isChapter).map((chapter) => chapter.id));
    const chapterId = inside
      ? (flow
          .getIntersectingNodes({ x: point.x, y: point.y, width: 1, height: 1 }, true)
          .find((node) => chapters.has(node.id))?.id ?? null)
      : null;
    return { point, chapterId };
  };

  const handlers: StoryDropTarget["handlers"] = {
    onDragEnter: (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      // A file tree row is dragged with the "move" effect: a drop is only allowed with the effect the source offers.
      event.dataTransfer.dropEffect = event.dataTransfer.effectAllowed === "move" ? "move" : "copy";
    },
    onDragLeave: (event) => {
      if (!accepts(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      const upload = files?.uploadProjectFiles;
      void dropOnStory(store, event.dataTransfer, placeOf(event), {
        upload: upload ? (dropped) => upload(dropped) : () => Promise.resolve([]),
        projectFiles,
      });
    },
  };

  const overlay = over ? (
    <div
      data-testid="story-drop-overlay"
      className="pointer-events-none absolute inset-1 z-40 flex flex-col items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-dashed border-accent bg-accent-soft px-4 text-center text-sm font-medium text-fg"
    >
      <Paperclip size={18} aria-hidden />
      {t("story.drop.hint")}
    </div>
  ) : null;

  return { handlers, overlay };
}
