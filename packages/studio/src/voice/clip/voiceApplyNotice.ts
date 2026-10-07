import { t } from "../../i18n";
import type { VoiceApplyReport } from "./voiceClipOps";

/** What the user is told after clips followed their takes; null when nothing changed and nothing is to be said. */
export interface VoiceApplyNotice {
  message: string;
  tone: "error" | "info";
  /** Undo is offered only when something was written. */
  undoable: boolean;
}

/**
 * The notice for a finished take change: "Shifted 3 clips" when the ripple moved any, else "Updated N clips", with
 * a refused or failed write says why (a locked later clip refuses the whole change, naming the clips).
 */
export function describeApplyReport(report: VoiceApplyReport): VoiceApplyNotice | null {
  if (report.failure !== null) return { message: report.failure, tone: "error", undoable: false };
  if (report.blockedBy.length > 0) {
    return {
      message: t("voice.toast.laterClipLocked", { clips: report.blockedBy.join(", ") }),
      tone: "error",
      undoable: false,
    };
  }
  if (report.updated === 0) return null;
  if (report.shiftFailed) {
    return { message: t("voice.toast.shiftFailed"), tone: "error", undoable: true };
  }
  const base =
    report.shifted > 0
      ? t("voice.toast.shifted", { count: report.shifted })
      : t("voice.toast.clipsUpdated", { count: report.updated });
  return { message: base, tone: "info", undoable: true };
}
