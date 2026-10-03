import type { ComponentProps } from "react";
import { LintModal } from "./LintModal";
import { StudioToast } from "./StudioToast";
import { ExportLicenseDialog } from "../research/ExportLicenseDialog";
import type { useToast } from "../hooks/useToast";

type LintFindings = ComponentProps<typeof LintModal>["findings"];

export interface StudioOverlaysProps {
  projectId: string;
  projectDir?: string | null;
  lintModal: LintFindings | null;
  closeLintModal: () => void;
  consoleErrors: LintFindings | null;
  clearConsoleErrors: () => void;
  toasts: ReturnType<typeof useToast>["toasts"];
  dismissToast: (id: number) => void;
}

/**
 * Floating overlays for the studio shell: lint / console-error modals, the
 * export license check and the toast. Extracted from
 * `App.tsx` to keep the shell within the studio's 600-line decomposition budget.
 */
export function StudioOverlays({
  projectId,
  projectDir,
  lintModal,
  closeLintModal,
  consoleErrors,
  clearConsoleErrors,
  toasts,
  dismissToast,
}: StudioOverlaysProps) {
  return (
    <>
      {lintModal !== null && (
        <LintModal
          findings={lintModal}
          projectId={projectId}
          projectDir={projectDir}
          onClose={closeLintModal}
        />
      )}
      {/* One modal at a time — console errors wait behind an open lint modal
          instead of stacking two full-screen overlays. */}
      {lintModal === null && consoleErrors !== null && consoleErrors.length > 0 && (
        <LintModal
          findings={consoleErrors}
          projectId={projectId}
          projectDir={projectDir}
          kind="console"
          promptIntro="Fix these runtime console errors from the composition preview"
          onClose={clearConsoleErrors}
        />
      )}
      <ExportLicenseDialog />
      {/* Bottom-right stack for toasts. Empty when nothing is showing. */}
      <div className="absolute bottom-6 right-6 z-91 flex flex-col items-end gap-2">
        {toasts.map((toast) => (
          <StudioToast
            key={toast.id}
            message={toast.message}
            tone={toast.tone}
            leaving={toast.leaving}
            onDismiss={() => dismissToast(toast.id)}
          />
        ))}
      </div>
    </>
  );
}
