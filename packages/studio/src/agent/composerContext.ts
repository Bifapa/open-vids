import { create } from "zustand";
import type { EditorContext } from "@hyperframes/agent-protocol";
import { t } from "../i18n";
import { formatTime } from "../player/lib/time";

export type ContextChipKind = "clip" | "range" | "asset" | "element" | "story";

/** One piece of the editor context the next message carries, as the composer shows it. */
export interface ContextChip {
  /** Stable while the same thing stays selected; what a removal is remembered by. */
  key: string;
  kind: ContextChipKind;
  label: string;
  /** Tooltip detail (timecodes, path). */
  detail: string;
}

/** The chip key of a canvas-picked element; what removing its chip is remembered by. */
export const elementKey = (element: NonNullable<EditorContext["selection"]["previewElement"]>) =>
  `element:${element.hfId ?? element.selector ?? element.domId ?? element.label ?? ""}`;

const rangeKey = (range: { start: number; end: number }) => `range:${range.start}-${range.end}`;

/**
 * What of the editor travels with the next message: the selected clips, the in/out or range selection, the
 * previewed asset, the element picked on the canvas, and the selected story node (by title when known).
 */
export function contextChips(
  context: EditorContext,
  storyNodeTitle: (id: string) => string | null = () => null,
): ContextChip[] {
  const { clips, range, assetPath, previewElement } = context.selection;
  const chips: ContextChip[] = clips.map((clip) => ({
    key: `clip:${clip.id}`,
    kind: "clip",
    label: clip.label || clip.tag,
    detail: `${formatTime(clip.start)} – ${formatTime(clip.start + clip.duration)}`,
  }));
  if (range) {
    chips.push({
      key: rangeKey(range),
      kind: "range",
      label: `${formatTime(range.start)}–${formatTime(range.end)}`,
      detail: t("agent.context.timelineRange"),
    });
  }
  if (assetPath) {
    const name = assetPath.slice(assetPath.lastIndexOf("/") + 1) || assetPath;
    chips.push({ key: `asset:${assetPath}`, kind: "asset", label: name, detail: assetPath });
  }
  const pickedClip =
    previewElement?.hfId !== undefined && clips.some((clip) => clip.hfId === previewElement.hfId);
  if (previewElement && !pickedClip) {
    chips.push({
      key: elementKey(previewElement),
      kind: "element",
      label: previewElement.label || previewElement.tagName || t("agent.context.element"),
      detail:
        previewElement.sourceFile ?? previewElement.selector ?? t("agent.context.canvasSelection"),
    });
  }
  const node = context.storyGraph?.selectedNode;
  if (node) {
    chips.push({
      key: `story:${node}`,
      kind: "story",
      label: storyNodeTitle(node) ?? t("agent.context.storyNode"),
      detail: t("agent.context.storySelection"),
    });
  }
  return chips;
}

/** The context the user removed from the next message (by chip key); forgotten once a message goes. */
interface ComposerContextState {
  excluded: ReadonlySet<string>;
  exclude(key: string): void;
  /** Takes the keys back into the next message, as when the user asks about them again. */
  include(keys: readonly string[]): void;
  clear(): void;
}

export const useComposerContextStore = create<ComposerContextState>((set) => ({
  excluded: new Set(),
  exclude: (key) => set((state) => ({ excluded: new Set([...state.excluded, key]) })),
  include: (keys) =>
    set((state) =>
      keys.some((key) => state.excluded.has(key))
        ? { excluded: new Set([...state.excluded].filter((key) => !keys.includes(key))) }
        : state,
    ),
  clear: () => set({ excluded: new Set() }),
}));

/** The context without what the user removed from the composer. */
export function withoutExcluded(
  context: EditorContext,
  excluded: ReadonlySet<string> = useComposerContextStore.getState().excluded,
): EditorContext {
  if (excluded.size === 0) return context;
  const { selection, storyGraph } = context;
  return {
    ...context,
    selection: {
      clips: selection.clips.filter((clip) => !excluded.has(`clip:${clip.id}`)),
      range: selection.range && !excluded.has(rangeKey(selection.range)) ? selection.range : null,
      assetPath:
        selection.assetPath && !excluded.has(`asset:${selection.assetPath}`)
          ? selection.assetPath
          : null,
      previewElement:
        selection.previewElement && !excluded.has(elementKey(selection.previewElement))
          ? selection.previewElement
          : null,
    },
    storyGraph:
      storyGraph?.selectedNode && excluded.has(`story:${storyGraph.selectedNode}`)
        ? { ...storyGraph, selectedNode: null }
        : storyGraph,
  };
}
