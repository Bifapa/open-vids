import { useCallback } from "react";
import type { TimelineElement } from "../player";
import { isAgentTurnRunning } from "../agent/agentTurnLock";
import { t } from "../i18n";

/** A host's verdict on one element: editable, or blocked with a reason to show. */
export type TimelineEditPermission = true | { blocked: true; reason: string };

export type CanEditTimelineElement = (element: TimelineElement) => TimelineEditPermission;

/** What an effect save did: landed, refused before writing, or failed while writing. */
export type TimelineEditOutcome =
  | { status: "saved" }
  | { status: "refused" | "failed"; reason: string };

/** The project to save into, or why the save stops before it writes. */
export function projectForTimelineSave(
  isRecording: boolean | undefined,
  projectId: string | null,
  showToast: (message: string, tone?: "error" | "info") => void,
): string | TimelineEditOutcome {
  if (isRecording) {
    showToast(t("timeline.toast.recordingBlocked"), "error");
    return { status: "refused", reason: t("timeline.toast.recordingBlocked") };
  }
  return projectId ?? failedTimelineSave(t("timeline.toast.noProject"), showToast);
}

export function failedTimelineSave(
  reason: string,
  showToast: (message: string, tone?: "error" | "info") => void,
): TimelineEditOutcome {
  showToast(reason);
  return { status: "failed", reason };
}

function timelineEditRefusal(
  canEdit: CanEditTimelineElement | undefined,
  targets: readonly TimelineElement[],
): string | null {
  for (const element of targets) {
    const verdict = canEdit?.(element) ?? true;
    if (verdict !== true) return verdict.reason;
  }
  return null;
}

/**
 * The reason every hand timeline edit is refused right now, or null while edits are allowed: an agent turn is
 * running for this project (through its render-QA correction passes), so the file it is rewriting must not be
 * edited by hand at the same time. The agent's own writes never pass through here — they are server-side and
 * arrive as live reloads.
 */
export function timelineEditLockReason(): string | null {
  return isAgentTurnRunning() ? t("timeline.toast.agentEditing") : null;
}

/**
 * The lock half of the gate, as a boolean for callers that only need "may I proceed": toasts the reason once and
 * answers true when the edit must stop.
 */
export function useTimelineLockRefusal(
  showToast: (message: string, tone?: "error" | "info") => void,
): () => boolean {
  return useCallback(() => {
    const reason = timelineEditLockReason();
    if (reason === null) return false;
    showToast(reason, "error");
    return true;
  }, [showToast]);
}

/**
 * The host's reason to refuse a write when an agent turn is running, or when any target element is blocked;
 * toasted. Absent `canEdit` and no turn running never refuses, so Studio itself is unchanged.
 */
export function useTimelineEditRefusal(
  canEdit: CanEditTimelineElement | undefined,
  showToast: (message: string, tone?: "error" | "info") => void,
) {
  return useCallback(
    (targets: readonly TimelineElement[]): string | null => {
      const reason = timelineEditLockReason() ?? timelineEditRefusal(canEdit, targets);
      if (reason !== null) showToast(reason, "error");
      return reason;
    },
    [canEdit, showToast],
  );
}

export function useTimelineEditGate(
  canEdit: CanEditTimelineElement | undefined,
  showToast: (message: string, tone?: "error" | "info") => void,
) {
  const refuse = useTimelineEditRefusal(canEdit, showToast);
  return useCallback(
    (targets: readonly TimelineElement[]): boolean => refuse(targets) === null,
    [refuse],
  );
}
