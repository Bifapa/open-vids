import { useCallback } from "react";
import { isGsapEditBlockedError } from "./gsapEditOutcome";

export function useGsapInteractionFailureNotice(
  showToast: (message: string, tone?: "error" | "info") => void,
) {
  return useCallback(
    (error: unknown) => {
      showToast(
        isGsapEditBlockedError(error) ? error.message : "Failed to save animated edit.",
        "error",
      );
    },
    [showToast],
  );
}
