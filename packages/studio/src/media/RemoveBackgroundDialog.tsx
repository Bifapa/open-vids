import { useState } from "react";
import { Button, Dialog, Meter, SegmentedControl, Toggle } from "../components/ui";
import type {
  BackgroundRemovalProgress,
  BackgroundRemovalResult,
} from "../components/editor/propertyPanelTypes";
import type { MediaItem } from "./mediaLibrary";

type Quality = "fast" | "balanced" | "best";

export type RemoveBackground = (
  inputPath: string,
  options: {
    createBackgroundPlate?: boolean;
    quality?: Quality;
    onProgress?: (progress: BackgroundRemovalProgress) => void;
  },
) => Promise<BackgroundRemovalResult>;

const QUALITIES = [
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "best", label: "Best" },
] as const;

/**
 * Remove Background… for the selected video or image: the same server job the Design inspector runs, writing a
 * transparent cutout next to the original (and, for video, an optional background plate).
 */
export function RemoveBackgroundDialog({
  item,
  onClose,
  removeBackground,
}: {
  item: MediaItem;
  onClose: () => void;
  removeBackground: RemoveBackground;
}) {
  const [quality, setQuality] = useState<Quality>("balanced");
  const [plate, setPlate] = useState(false);
  const [progress, setProgress] = useState<BackgroundRemovalProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = progress?.status === "processing";
  const start = () => {
    setError(null);
    setProgress({ status: "processing", progress: 0 });
    removeBackground(item.path, {
      quality,
      createBackgroundPlate: item.kind === "video" && plate,
      onProgress: setProgress,
    }).then(
      () => onClose(),
      (failure: unknown) => {
        setProgress(null);
        setError(failure instanceof Error ? failure.message : "Background removal failed");
      },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Remove Background"
      description={item.name}
      className="w-[420px]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {running ? "Hide" : "Cancel"}
          </Button>
          <Button variant="primary" onClick={start} loading={running} disabled={running}>
            Remove Background
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5 text-sm">
        <label className="grid gap-1.5 text-xs font-medium text-fg-2">
          Quality
          <SegmentedControl
            label="Quality"
            value={quality}
            options={QUALITIES}
            onChange={setQuality}
            disabled={running}
            className="justify-self-start"
          />
        </label>
        {item.kind === "video" && (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs font-medium text-fg-2">
            <span>
              Background plate
              <span className="mt-0.5 block font-normal text-fg-3">
                Also keep the background without the subject, as its own video.
              </span>
            </span>
            <Toggle
              label="Background plate"
              checked={plate}
              onCommit={setPlate}
              disabled={running}
            />
          </div>
        )}
        <p className="m-0 text-xs text-fg-3">
          Writes a transparent {item.kind === "video" ? "video" : "image"} next to the original. The
          original is kept.
        </p>
        {progress && (
          <div className="grid gap-1.5">
            <div className="flex justify-between gap-2 text-xs text-fg-2">
              <span>{progress.stage ?? "Removing background"}</span>
              <span className="font-mono text-num text-fg-3 tabular-nums">
                {Math.round(progress.progress)}%
              </span>
            </div>
            <Meter value={progress.progress / 100} label="Removing background" />
          </div>
        )}
        {error && <p className="m-0 text-xs text-error">{error}</p>}
      </div>
    </Dialog>
  );
}
