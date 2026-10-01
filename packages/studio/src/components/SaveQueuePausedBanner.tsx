import { ArrowsClockwise } from "@phosphor-icons/react";
import { StudioBanner } from "./StudioBanner";
import { Button } from "./ui/Button";

interface SaveQueuePausedBannerProps {
  message: string;
  /** Resets the save-queue circuit breaker so persistence resumes. */
  onRetry: () => void;
}

/** Alert shown when the DOM-edit save queue circuit breaker pauses persistence. */
export function SaveQueuePausedBanner({ message, onRetry }: SaveQueuePausedBannerProps) {
  return (
    <StudioBanner
      tone="err"
      actions={
        <Button size="sm" icon={<ArrowsClockwise size={12} aria-hidden />} onClick={onRetry}>
          Retry Saving
        </Button>
      }
    >
      {message}
    </StudioBanner>
  );
}
