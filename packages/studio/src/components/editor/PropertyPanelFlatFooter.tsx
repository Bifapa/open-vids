import { Record as RecordIcon, Sparkle, Stop } from "@phosphor-icons/react";
import { Button, Kbd } from "../ui";

export function PropertyPanelFlatFooter({
  onAskAgent,
  recordingState,
  recordingDuration,
  onToggleRecording,
}: {
  onAskAgent?: () => void;
  recordingState?: "idle" | "recording" | "preview";
  recordingDuration?: number;
  onToggleRecording?: () => void;
}) {
  const recording = recordingState === "recording";
  const recordTitle = recording
    ? `Stop recording ${(recordingDuration ?? 0).toFixed(1)}s`
    : "Record gesture (R)";

  return (
    // The 1px line is a shadow, not a border: when the sections fill the body,
    // the last collapsed header's own bottom border sits exactly there.
    <div className="relative flex shrink-0 flex-wrap gap-1.5 bg-bg-0 px-3 py-2 shadow-[0_-1px_0_var(--color-border-subtle)]">
      <Button
        variant="ghost"
        size="sm"
        data-flat-footer-ask="true"
        disabled={!onAskAgent}
        icon={<Sparkle size={12} />}
        className="min-w-0 flex-auto"
        onClick={() => {
          onAskAgent?.();
        }}
      >
        Ask Agent About This Element
      </Button>
      {onToggleRecording && (
        <Button
          variant="secondary"
          size="sm"
          data-flat-footer-record="true"
          aria-label={recordTitle}
          title={recordTitle}
          aria-pressed={recording}
          icon={
            recording ? (
              <Stop size={12} weight="fill" className="text-error" />
            ) : (
              <RecordIcon size={12} className="text-fg-2" />
            )
          }
          className={`min-w-0 flex-auto justify-start ${recording ? "border-error/60" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onToggleRecording();
          }}
        >
          <span className="truncate">
            {recording
              ? `Stop Recording ${(recordingDuration ?? 0).toFixed(1)}s`
              : "Record Gesture"}
          </span>
          {!recording && <Kbd className="ml-auto">R</Kbd>}
        </Button>
      )}
    </div>
  );
}
