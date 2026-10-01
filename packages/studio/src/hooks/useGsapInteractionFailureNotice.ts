import { useCallback } from "react";
import { isGsapEditBlockedError } from "./gsapEditOutcome";
import { t } from "../i18n";

export function useGsapInteractionFailureNotice(
  showToast: (message: string, tone?: "error" | "info") => void,
) {
  return useCallback(
    (error: unknown) => {
      showToast(
        isGsapEditBlockedError(error) ? error.message : t("animation.toast.interactionSaveFailed"),
        "error",
      );
    },
    [showToast],
  );
}
