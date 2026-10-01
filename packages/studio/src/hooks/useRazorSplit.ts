import { useCallback, useRef } from "react";
import type { TimelineElement } from "../player";
import { usePlayerStore } from "../player";
import { getTimelineElementLabel } from "../utils/studioHelpers";
import { canSplitElementAt, selectSplittableElements } from "../utils/timelineElementSplit";
import { buildAtomicCutIntents, runAtomicCutTransaction } from "../utils/razorSplitTransaction";
import type { RecordEditInput } from "./timelineEditingHelpers";
import { formatNumber, t } from "../i18n";

/** `1.50` for the split time: two fixed decimals, no thousands grouping, the language's own separator. */
function formatSplitTime(seconds: number): string {
  return formatNumber(seconds, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
}

interface UseRazorSplitOptions {
  projectId: string | null;
  activeCompPath: string | null;
  showToast: (message: string, tone?: "error" | "info") => void;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  observeProjectFileVersion?: (path: string, version: string | null) => void;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  reloadPreview: () => void;
  forceReloadSdkSession?: () => void;
  isRecordingRef?: React.RefObject<boolean>;
}

export function useRazorSplit({
  projectId,
  activeCompPath,
  showToast,
  writeProjectFile,
  observeProjectFileVersion,
  recordEdit,
  reloadPreview,
  forceReloadSdkSession,
  isRecordingRef,
}: UseRazorSplitOptions) {
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const synchronize = useCallback(() => {
    let failure: unknown;
    try {
      forceReloadSdkSession?.();
    } catch (error) {
      failure = error;
    }
    try {
      reloadPreview();
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }, [forceReloadSdkSession, reloadPreview]);

  const runCut = useCallback(
    async (elements: readonly TimelineElement[], splitTime: number, mode: "single" | "all") => {
      const pid = projectIdRef.current;
      if (!pid || elements.length === 0) return;
      const intents = buildAtomicCutIntents(elements, splitTime, activeCompPath);
      const requestedCount = intents.reduce((count, file) => count + file.targets.length, 0);
      const time = formatSplitTime(splitTime);
      const label =
        mode === "single"
          ? t("timeline.history.splitClip")
          : t("timeline.history.splitClips", { count: requestedCount, time });

      const result = await runAtomicCutTransaction({
        projectId: pid,
        intents,
        label,
        writeProjectFile,
        recordEdit,
        observeProjectFileVersion,
        synchronize,
      });
      if (result.syncFailed) {
        showToast(t("timeline.toast.cutSyncFailed"), "error");
      }
      if (result.skippedSelectors.length > 0) {
        showToast(
          t("timeline.toast.cutSelectorsSkipped", {
            selectors: result.skippedSelectors.join(", "),
          }),
          "info",
        );
      }
      return result;
    },
    [
      activeCompPath,
      observeProjectFileVersion,
      recordEdit,
      showToast,
      synchronize,
      writeProjectFile,
    ],
  );

  const handleRazorSplit = useCallback(
    async (element: TimelineElement, splitTime: number) => {
      if (isRecordingRef?.current) {
        showToast(t("timeline.toast.recordingBlocked"), "error");
        return;
      }
      if (!canSplitElementAt(element, splitTime)) return;
      try {
        const result = await runCut([element], splitTime, "single");
        if (!result) return;
        if (result.syncFailed) return;
        showToast(
          t("timeline.toast.splitDone", {
            label: getTimelineElementLabel(element),
            time: formatSplitTime(splitTime),
          }),
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : t("timeline.toast.splitFailed");
        showToast(message, "error");
      }
    },
    [isRecordingRef, runCut, showToast],
  );

  const handleRazorSplitAll = useCallback(
    async (splitTime: number) => {
      if (isRecordingRef?.current) {
        showToast(t("timeline.toast.recordingBlocked"), "error");
        return;
      }
      const splittable = selectSplittableElements(usePlayerStore.getState().elements, splitTime);
      if (splittable.length === 0) return;
      try {
        const result = await runCut(splittable, splitTime, "all");
        if (!result) return;
        if (result.syncFailed) return;
        showToast(
          t("timeline.toast.splitAllDone", {
            count: result.splitCount,
            time: formatSplitTime(splitTime),
          }),
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : t("timeline.toast.splitAllFailed");
        showToast(message, "error");
      }
    },
    [isRecordingRef, runCut, showToast],
  );

  return { handleRazorSplit, handleRazorSplitAll };
}
