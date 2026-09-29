import { useCallback, useEffect, useMemo, useRef } from "react";
import { LIMITS, type EditorClipSummary, type EditorContext } from "@hyperframes/agent-protocol";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import { getPersistedRenderSettings } from "../components/renders/renderSettings";
import { useDomEditSelectionContextOptional } from "../contexts/DomEditContext";
import { useStudioShellContextOptional } from "../contexts/StudioContext";
import { usePlayerStore, type TimelineElement } from "../player";
import { useAssetPreviewStore } from "../utils/assetPreviewStore";

/** Where the agent panel gets a snapshot of the editor; read at send/steer time, never continuously. */
export interface EditorContextSource {
  capture(): EditorContext;
}

/** The slice of a DOM selection the context reports; a full `DomEditSelection` satisfies it. */
export type PreviewSelectionLike = Pick<
  DomEditSelection,
  "id" | "hfId" | "selector" | "label" | "tagName" | "sourceFile"
>;

/** Everything `buildEditorContext` reads, gathered by the caller so the mapping stays pure. */
export interface EditorContextInput {
  now: number;
  projectId: string;
  projectTitle?: string;
  activeCompPath: string | null;
  compositionDimensions: { width: number; height: number } | null;
  elements: readonly TimelineElement[];
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  selectedElementId: string | null;
  selectedElementIds: ReadonlySet<string>;
  assetPath: string | null;
  previewSelection: PreviewSelectionLike | null;
  inPoint: number | null;
  outPoint: number | null;
  rangeSelection: { t0: number; t1: number } | null;
  renderSettings: { format?: string; fps?: number; quality?: string } | null;
}

const MAX_TIMELINE_ELEMENTS = LIMITS.contextElements;
const MAX_SELECTED_CLIPS = LIMITS.contextSelectedClips;

const finite = (value: number): number => (Number.isFinite(value) ? round(value) : 0);
const round = (value: number): number => Math.round(value * 1000) / 1000;

/** The id the timeline selects by: the scope-qualified key, else the bare id. */
const clipKey = (element: TimelineElement): string => element.key ?? element.id;

function toClip(element: TimelineElement): EditorClipSummary {
  const clip: EditorClipSummary = {
    id: clipKey(element),
    tag: element.tag,
    start: finite(element.start),
    duration: finite(element.duration),
    track: Number.isFinite(element.track) ? element.track : 0,
  };
  if (element.label) clip.label = element.label;
  if (element.hfId) clip.hfId = element.hfId;
  if (element.domId) clip.domId = element.domId;
  if (element.sourceFile) clip.sourceFile = element.sourceFile;
  if (element.src) clip.src = element.src;
  return clip;
}

function selectedElements(input: EditorContextInput): TimelineElement[] {
  const wanted = new Set(input.selectedElementIds);
  if (input.selectedElementId) wanted.add(input.selectedElementId);
  if (wanted.size === 0) return [];
  return input.elements.filter((element) => wanted.has(clipKey(element)));
}

function selectionRange(input: EditorContextInput): { start: number; end: number } | null {
  const { inPoint, outPoint, rangeSelection } = input;
  if (rangeSelection) {
    return { start: finite(rangeSelection.t0), end: finite(rangeSelection.t1) };
  }
  if (inPoint !== null || outPoint !== null) {
    const start = finite(inPoint ?? 0);
    const end = finite(outPoint ?? input.duration);
    return end >= start ? { start, end } : null;
  }
  return null;
}

function previewElement(
  selection: PreviewSelectionLike | null,
): EditorContext["selection"]["previewElement"] {
  if (!selection) return null;
  const element: NonNullable<EditorContext["selection"]["previewElement"]> = {};
  if (selection.id) element.domId = selection.id;
  if (selection.hfId) element.hfId = selection.hfId;
  if (selection.selector) element.selector = selection.selector;
  if (selection.label) element.label = selection.label;
  if (selection.tagName) element.tagName = selection.tagName;
  if (selection.sourceFile) element.sourceFile = selection.sourceFile;
  return Object.keys(element).length > 0 ? element : null;
}

/**
 * Maps live Studio state to the protocol's `EditorContext`. Pure: the timeline is capped at
 * {@link MAX_TIMELINE_ELEMENTS} with `elementCount` still the true total, and anything Studio
 * cannot know is null or absent rather than guessed.
 */
export function buildEditorContext(input: EditorContextInput): EditorContext {
  const composition = input.activeCompPath
    ? {
        path: input.activeCompPath,
        ...(input.compositionDimensions
          ? { width: input.compositionDimensions.width, height: input.compositionDimensions.height }
          : {}),
        ...(Number.isFinite(input.duration) && input.duration > 0
          ? { duration: finite(input.duration) }
          : {}),
      }
    : null;

  return {
    schemaVersion: 1,
    capturedAt: input.now,
    project: { id: input.projectId, ...(input.projectTitle ? { title: input.projectTitle } : {}) },
    activeComposition: composition,
    timeline: {
      duration: finite(input.duration),
      elementCount: input.elements.length,
      elements: input.elements.slice(0, MAX_TIMELINE_ELEMENTS).map(toClip),
    },
    playhead: { time: finite(input.currentTime), playing: input.isPlaying },
    selection: {
      clips: selectedElements(input).slice(0, MAX_SELECTED_CLIPS).map(toClip),
      assetPath: input.assetPath,
      previewElement: previewElement(input.previewSelection),
      range: selectionRange(input),
    },
    renderSettings: input.renderSettings,
    storyGraph: null,
  };
}

/**
 * The live editor as an `EditorContextSource`. Contexts change with renders; the player and
 * asset stores are read when `capture()` runs, so the snapshot is exactly the moment of sending.
 */
export function useEditorContextSource(projectId?: string): EditorContextSource {
  const shell = useStudioShellContextOptional();
  const domSelection = useDomEditSelectionContextOptional();
  const live = useRef({ shell, domSelection, projectId });
  useEffect(() => {
    live.current = { shell, domSelection, projectId };
  });

  const capture = useCallback((): EditorContext => {
    const { shell: shellNow, domSelection: domNow, projectId: explicitId } = live.current;
    const player = usePlayerStore.getState();
    const preview = useAssetPreviewStore.getState();
    const id = explicitId ?? shellNow?.projectId ?? "";
    return buildEditorContext({
      now: Date.now(),
      projectId: id,
      activeCompPath: shellNow?.activeCompPath ?? null,
      compositionDimensions: shellNow?.compositionDimensions ?? null,
      elements: player.elements,
      duration: player.duration,
      currentTime: player.currentTime,
      isPlaying: player.isPlaying,
      selectedElementId: player.selectedElementId,
      selectedElementIds: player.selectedElementIds,
      assetPath: preview.previewProjectId === id ? preview.previewAsset : null,
      previewSelection: domNow?.domEditSelection ?? null,
      inPoint: player.inPoint,
      outPoint: player.outPoint,
      rangeSelection: player.rangeSelection,
      renderSettings: getPersistedRenderSettings(),
    });
  }, []);

  return useMemo(() => ({ capture }), [capture]);
}
