import { useState } from "react";
import { Button, Dialog, Meter, SegmentedControl, Toggle } from "../components/ui";
import { formatPercent, t as translate, useTranslation } from "../i18n";
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
  { value: "fast", label: "media.removeBackground.quality.fast" },
  { value: "balanced", label: "media.removeBackground.quality.balanced" },
  { value: "best", label: "media.removeBackground.quality.best" },
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
  const { t } = useTranslation();
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
        setError(
          failure instanceof Error ? failure.message : translate("media.removeBackground.failed"),
        );
      },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("media.removeBackground.title")}
      description={item.name}
      className="w-[420px]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {running ? t("media.removeBackground.hide") : t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={start} loading={running} disabled={running}>
            {t("media.removeBackground.submit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5 text-sm">
        <label className="grid gap-1.5 text-xs font-medium text-fg-2">
          {t("media.removeBackground.qualityLabel")}
          <SegmentedControl
            label={t("media.removeBackground.qualityLabel")}
            value={quality}
            options={QUALITIES.map((entry) => ({ value: entry.value, label: t(entry.label) }))}
            onChange={setQuality}
            disabled={running}
            className="justify-self-start"
          />
        </label>
        {item.kind === "video" && (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs font-medium text-fg-2">
            <span>
              {t("media.removeBackground.plate")}
              <span className="mt-0.5 block font-normal text-fg-3">
                {t("media.removeBackground.plateHint")}
              </span>
            </span>
            <Toggle
              label={t("media.removeBackground.plate")}
              checked={plate}
              onCommit={setPlate}
              disabled={running}
            />
          </div>
        )}
        <p className="m-0 text-xs text-fg-3">
          {item.kind === "video"
            ? t("media.removeBackground.writesVideo")
            : t("media.removeBackground.writesImage")}
        </p>
        {progress && (
          <div className="grid gap-1.5">
            <div className="flex justify-between gap-2 text-xs text-fg-2">
              <span>{progress.stage ?? t("media.removeBackground.progress")}</span>
              <span className="font-mono text-num text-fg-3 tabular-nums">
                {formatPercent(progress.progress / 100)}
              </span>
            </div>
            <Meter value={progress.progress / 100} label={t("media.removeBackground.progress")} />
          </div>
        )}
        {error && <p className="m-0 text-xs text-error">{error}</p>}
      </div>
    </Dialog>
  );
}
