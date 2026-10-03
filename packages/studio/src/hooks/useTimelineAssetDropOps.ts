// Asset-drop handlers for the timeline: drop an existing project asset at a
// placement, or upload dragged-in OS files and place them sequentially.
// Extracted verbatim from useTimelineEditing.ts to keep it under the studio
// 600-line cap.
import { useCallback, type MutableRefObject, type RefObject } from "react";
import type { TimelineElement } from "../player";
import type { TimelineDropPlacement } from "../player/components/timelineCallbacks";
import { resolveDropTrack } from "../utils/timelineDropTrackInsert";
import {
  buildTimelineAssetId,
  buildTimelineAssetInsertHtml,
  fitTimelineAssetGeometry,
  getTimelineAssetKind,
  insertTimelineAssetIntoSource,
  resolveTimelineAssetSrc,
} from "@hyperframes/core/editing/timeline-asset";
import {
  buildTimelineFileDropPlacements,
  pickedClipTiming,
  resolveTimelineAssetCompositionSize,
} from "../utils/timelineAssetDrop";
import { mediaClient } from "../media/mediaClient";
import { generateId } from "../utils/generateId";
import { saveProjectFilesWithHistory, type RecordEditInput } from "../utils/studioFileHistory";
import {
  collectHtmlIds,
  resolveDroppedAssetDuration,
  resolveDroppedAssetHasAudio,
} from "../utils/studioHelpers";
import { formatTimelineAttributeNumber } from "./timelineEditingHelpers";
import { readFileContent } from "./timelineTimingSync";
import { t } from "../i18n";
import { commitTimelineCompositionInsertion } from "../utils/timelineCompositionInsert";
import { extendRootDurationInSource } from "../utils/rootDuration";
import { deriveTimelineStoreKeyForDomId } from "../player/lib/timelineElementHelpers";
import { selectAndRevealTimelineElement } from "../player/components/timelineDropReveal";

/** The fragment the user picked of an asset, or null (none, or the server did not answer: the whole file). */
async function fetchPickedRange(projectId: string, assetPath: string) {
  const view = await mediaClient.ranges(projectId).catch(() => null);
  return view?.ranges[assetPath] ?? null;
}

/** The first uploaded file opens the new track (if asked); the rest land on the lane it landed on. */
function fileDropPlacement(
  index: number,
  next: { start: number; track: number },
  dropped: TimelineDropPlacement | undefined,
  landedTrack: number | undefined,
): TimelineDropPlacement {
  return index === 0 ? { ...dropped, ...next } : { ...next, track: landedTrack ?? next.track };
}

function timelineDropTarget(
  sourceFile: string,
  placement: Pick<TimelineElement, "start" | "track">,
): TimelineElement {
  return {
    id: "timeline-drop",
    tag: "div",
    start: placement.start,
    duration: 0,
    track: placement.track,
    sourceFile,
  };
}

interface UseTimelineAssetDropOpsOptions {
  projectIdRef: MutableRefObject<string | null>;
  activeCompPath: string | null;
  timelineElements: TimelineElement[];
  showToast: (message: string, tone?: "error" | "info") => void;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  reloadPreview: () => void;
  uploadProjectFiles: (files: Iterable<File>, dir?: string) => Promise<string[]>;
  isRecordingRef?: RefObject<boolean>;
  forceReloadSdkSession?: () => void;
  observeProjectFileVersion?: (path: string, version: string | null) => void;
  checkEditable?: (targets: readonly TimelineElement[]) => boolean;
}

export function useTimelineAssetDropOps({
  projectIdRef,
  activeCompPath,
  timelineElements,
  showToast,
  writeProjectFile,
  recordEdit,
  reloadPreview,
  uploadProjectFiles,
  isRecordingRef,
  forceReloadSdkSession,
  observeProjectFileVersion,
  checkEditable,
}: UseTimelineAssetDropOpsOptions) {
  const dropAssetAt = useCallback(
    async (
      assetPath: string,
      placement: TimelineDropPlacement,
      durationOverride?: number,
    ): Promise<number | undefined> => {
      if (isRecordingRef?.current) {
        showToast(t("timeline.toast.recordingBlocked"), "error");
        return undefined;
      }
      const targetPath = activeCompPath || "index.html";
      if (checkEditable && !checkEditable([timelineDropTarget(targetPath, placement)])) {
        return undefined;
      }
      const pid = projectIdRef.current;
      if (!pid) throw new Error(t("app.save.noActiveProject"));

      const kind = getTimelineAssetKind(assetPath);
      if (!kind) {
        showToast(t("timeline.toast.dropKindUnsupported"));
        return undefined;
      }

      try {
        const normalizedStart = Number(formatTimelineAttributeNumber(placement.start));
        // An asset the user picked a fragment of lands as that fragment: its media from the pick's in point, as
        // long as the pick. (An upload placed by file drop is new and has no pick: its duration is given.)
        const picked =
          kind !== "image" && durationOverride === undefined
            ? await fetchPickedRange(pid, assetPath)
            : null;
        const pickedTiming = picked ? pickedClipTiming(picked) : null;
        const duration =
          pickedTiming?.duration ??
          (Number.isFinite(durationOverride) && durationOverride != null && durationOverride > 0
            ? durationOverride
            : await resolveDroppedAssetDuration(pid, assetPath, kind));
        const normalizedDuration = Number(formatTimelineAttributeNumber(duration));
        const mediaStart = pickedTiming?.mediaStart;
        // A video with an audio stream lands audible; the mixer only hears a
        // <video> marked data-has-audio, and a muted drop was losing the sound.
        const hasAudio = await resolveDroppedAssetHasAudio(pid, assetPath, kind);
        const resolvedAssetSrc = resolveTimelineAssetSrc(targetPath, assetPath);

        const resolvedTargetPath = targetPath || "index.html";
        const relevantElements = timelineElements.filter(
          (te) => (te.sourceFile || activeCompPath || "index.html") === resolvedTargetPath,
        );
        const newElementZIndex = Math.max(1, relevantElements.length + 1);

        let newId = "";
        let track = 0;
        const insertAsset = (originalContent: string) => {
          newId = buildTimelineAssetId(assetPath, collectHtmlIds(originalContent));
          const resolved = resolveDropTrack({
            source: originalContent,
            // insertRow counts the rows the timeline shows, so plan against those.
            elements: relevantElements,
            placement,
            dropped: {
              id: newId,
              tag: kind === "image" ? "img" : kind,
              start: normalizedStart,
              duration: normalizedDuration,
            },
          });
          track = resolved.track;
          return extendRootDurationInSource(
            insertTimelineAssetIntoSource(
              resolved.source,
              buildTimelineAssetInsertHtml({
                id: newId,
                hfId: `hf-${generateId()}`,
                assetPath: resolvedAssetSrc,
                kind,
                start: normalizedStart,
                duration: normalizedDuration,
                track,
                mediaStart,
                zIndex: newElementZIndex,
                hasAudio,
                geometry: fitTimelineAssetGeometry(
                  null,
                  resolveTimelineAssetCompositionSize(originalContent),
                ),
              }),
            ),
            normalizedStart + normalizedDuration,
          );
        };

        await saveProjectFilesWithHistory({
          projectId: pid,
          label: t("timeline.history.addAsset"),
          files: { [targetPath]: insertAsset },
          readFile: (path) => readFileContent(pid, path),
          writeFile: writeProjectFile,
          recordEdit,
        });

        selectAndRevealTimelineElement(deriveTimelineStoreKeyForDomId(newId, targetPath));
        forceReloadSdkSession?.();
        reloadPreview();
        return track;
      } catch (error) {
        const message = error instanceof Error ? error.message : t("timeline.toast.dropFailed");
        showToast(message);
        return undefined;
      }
    },
    [
      projectIdRef,
      activeCompPath,
      recordEdit,
      showToast,
      timelineElements,
      writeProjectFile,
      reloadPreview,
      isRecordingRef,
      forceReloadSdkSession,
      checkEditable,
    ],
  );

  const handleTimelineAssetDrop = useCallback(
    async (assetPath: string, placement: TimelineDropPlacement, durationOverride?: number) => {
      await dropAssetAt(assetPath, placement, durationOverride);
    },
    [dropAssetAt],
  );

  const handleTimelineFileDrop = useCallback(
    async (files: File[], placement?: TimelineDropPlacement) => {
      if (isRecordingRef?.current) {
        showToast(t("timeline.toast.recordingBlocked"), "error");
        return;
      }
      const targetPath = activeCompPath || "index.html";
      const initialPlacement = placement ?? { start: 0, track: 0 };
      if (checkEditable && !checkEditable([timelineDropTarget(targetPath, initialPlacement)])) {
        return;
      }
      const pid = projectIdRef.current;
      if (!pid) return;
      const uploaded = await uploadProjectFiles(files);
      if (uploaded.length === 0) return;
      const durations: number[] = [];
      for (const assetPath of uploaded) {
        const kind = getTimelineAssetKind(assetPath);
        const duration = kind ? await resolveDroppedAssetDuration(pid, assetPath, kind) : 0;
        durations.push(Number(formatTimelineAttributeNumber(duration)));
      }
      const placements = buildTimelineFileDropPlacements(
        placement ?? { start: 0, track: 0 },
        durations,
      );
      let landedTrack: number | undefined;
      for (const [index, assetPath] of uploaded.entries()) {
        const next = placements[index] ?? placements[0];
        const track = await dropAssetAt(
          assetPath,
          fileDropPlacement(index, next, placement, landedTrack),
          durations[index],
        );
        if (index === 0) landedTrack = track;
      }
    },
    [
      activeCompPath,
      checkEditable,
      dropAssetAt,
      projectIdRef,
      uploadProjectFiles,
      isRecordingRef,
      showToast,
    ],
  );

  const handleTimelineCompositionDrop = useCallback(
    async (sourcePath: string, placement: Pick<TimelineElement, "start" | "track">) => {
      if (isRecordingRef?.current) {
        showToast(t("timeline.toast.recordingBlocked"), "error");
        return;
      }
      const targetPath = activeCompPath || "index.html";
      if (checkEditable && !checkEditable([timelineDropTarget(targetPath, placement)])) {
        return;
      }
      const pid = projectIdRef.current;
      if (!pid) throw new Error(t("app.save.noActiveProject"));
      try {
        await commitTimelineCompositionInsertion({
          projectId: pid,
          targetPath,
          sourcePath,
          start: placement.start,
          track: placement.track,
          writeFile: writeProjectFile,
          recordEdit,
          observeVersion: observeProjectFileVersion,
          selectHost: selectAndRevealTimelineElement,
          resync: forceReloadSdkSession,
          refresh: reloadPreview,
        });
        showToast(t("timeline.toast.compositionAdded"), "info");
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : t("app.save.addCompositionFailed"),
          "error",
        );
      }
    },
    [
      activeCompPath,
      checkEditable,
      forceReloadSdkSession,
      isRecordingRef,
      observeProjectFileVersion,
      projectIdRef,
      recordEdit,
      reloadPreview,
      showToast,
      writeProjectFile,
    ],
  );

  return { handleTimelineAssetDrop, handleTimelineFileDrop, handleTimelineCompositionDrop };
}
