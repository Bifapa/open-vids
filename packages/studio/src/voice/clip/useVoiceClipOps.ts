import { useCallback, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
import { t } from "../../i18n";
import { usePlayerStore } from "../../player";
import { selectAndRevealTimelineElement } from "../../player/components/timelineDropReveal";
import {
  findTimelineElementInIframe,
  type RecordEditInput,
} from "../../hooks/timelineEditingHelpers";
import { readFileContent } from "../../hooks/timelineTimingSync";
import { timelineEditLockReason } from "../../hooks/timelineEditPermission";
import type {
  TimelineGroupCommitOptions,
  TimelineGroupMoveChange,
} from "../../hooks/useTimelineGroupEditing";
import type { ToastAction } from "../../utils/studioHelpers";
import { describeApplyReport } from "./voiceApplyNotice";
import {
  addVoiceLines,
  applyVoiceTakes,
  carveMusicUnderVoiceover,
  type VoiceAddReport,
  type VoiceApplyReport,
  type VoiceCarveReport,
  type VoiceClipDeps,
} from "./voiceClipOps";
import type { TakeApplication } from "./voiceTakePlan";

/** What the voiceover surfaces ask of the timeline. Each is one undo entry, and refuses while an agent turn runs. */
export interface VoiceClipOps {
  /** Switches the clips of the lines to their selected takes (ripple per the timeline's toggle) and says so. */
  applyTakes(applications: readonly TakeApplication[]): Promise<VoiceApplyReport>;
  /** Places the lines on the timeline from the playhead. */
  addLines(items: readonly TakeApplication[]): Promise<VoiceAddReport>;
  /** Carves every music bed against the voiceover. */
  carveMusic(): Promise<VoiceCarveReport>;
}

export interface UseVoiceClipOpsOptions {
  projectId: string;
  activeCompPath: string | null;
  previewIframeRef: RefObject<HTMLIFrameElement | null>;
  showToast: (message: string, tone?: "error" | "info", action?: ToastAction) => void;
  undo: () => Promise<void>;
  writeProjectFile: (path: string, content: string, expectedContent?: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  reloadPreview: () => void;
  forceReloadSdkSession?: () => void;
  pendingTimelineEditPathRef: MutableRefObject<Set<string>>;
  /** The timeline's atomic multi-clip move: the ripple rides on it, folded into the take change's undo entry. */
  onTimelineGroupMove: (
    changes: TimelineGroupMoveChange[],
    options?: TimelineGroupCommitOptions,
  ) => Promise<void>;
  /** A gesture recording is armed or running: the timeline takes no other edit. */
  recordingActive: boolean;
}

/** Binds the voice clip writes to this Studio's project, preview and history. */
export function useVoiceClipOps(options: UseVoiceClipOpsOptions): VoiceClipOps {
  const latest = useRef(options);
  latest.current = options;

  const depsOf = useCallback((): VoiceClipDeps => {
    const current = latest.current;
    const store = usePlayerStore.getState;
    return {
      projectId: current.projectId,
      activeCompPath: current.activeCompPath,
      elements: () => store().elements,
      rippleEnabled: () => store().rippleEditEnabled,
      playhead: () => store().currentTime,
      readFile: (path) => readFileContent(current.projectId, path),
      writeProjectFile: current.writeProjectFile,
      recordEdit: current.recordEdit,
      pendingEditPaths: current.pendingTimelineEditPathRef.current,
      groupMove: current.onTimelineGroupMove,
      setElements: (elements) => store().setElements(elements),
      refreshPreview: () => {
        current.forceReloadSdkSession?.();
        current.reloadPreview();
      },
      previewDocument: () => current.previewIframeRef.current?.contentDocument ?? null,
      findNode: (element) =>
        findTimelineElementInIframe(
          current.previewIframeRef.current,
          element,
          current.activeCompPath,
        ),
      reveal: selectAndRevealTimelineElement,
      blockedReason: () =>
        timelineEditLockReason() ??
        (current.recordingActive ? t("timeline.toast.recordingBlocked") : null),
    };
  }, []);

  const applyTakes = useCallback(
    async (applications: readonly TakeApplication[]) => {
      const report = await applyVoiceTakes(depsOf(), applications);
      const notice = describeApplyReport(report);
      if (notice) {
        const { showToast, undo } = latest.current;
        showToast(
          notice.message,
          notice.tone,
          notice.undoable ? { label: t("common.undo"), run: () => void undo() } : undefined,
        );
      }
      return report;
    },
    [depsOf],
  );

  const addLines = useCallback(
    async (items: readonly TakeApplication[]) => {
      const report = await addVoiceLines(depsOf(), items);
      const { showToast, undo } = latest.current;
      if (report.failure !== null) showToast(report.failure, "error");
      else if (report.added > 0) {
        showToast(t("voice.toast.linesAdded", { count: report.added }), "info", {
          label: t("common.undo"),
          run: () => void undo(),
        });
      }
      return report;
    },
    [depsOf],
  );

  const carveMusic = useCallback(async () => {
    const report = await carveMusicUnderVoiceover(depsOf());
    const { showToast, undo } = latest.current;
    if (report.kind === "carved") {
      showToast(t("voice.toast.carved", { count: report.beds }), "info", {
        label: t("common.undo"),
        run: () => void undo(),
      });
    } else if (report.kind === "failed") showToast(report.message, "error");
    else showToast(t(`voice.carve.result.${report.kind}`), "info");
    return report;
  }, [depsOf]);

  return useMemo(() => ({ applyTakes, addLines, carveMusic }), [applyTakes, addLines, carveMusic]);
}
