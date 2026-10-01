import { readPreviewMediaSrc } from "@hyperframes/core/studio-preview-mark";
import { useEffect, useState } from "react";
import { Check, ClipboardList, Film, Music, Scissors } from "../../icons/SystemIcons";
import { useTranslation } from "../../i18n";
import type { DomEditSelection } from "./domEditing";
import {
  type BackgroundRemovalProgress,
  type BackgroundRemovalResult,
  formatNumericValue,
  formatTimingValue,
  LABEL,
  parseNumericValue,
  readClipInPoint,
  RESPONSIVE_GRID,
  stripQueryAndHash,
} from "./propertyPanelHelpers";
import { Section, SegmentedControl, SelectField, SliderControl } from "./propertyPanelPrimitives";
import {
  AUDIO_GAIN_FADER_MAX,
  AUDIO_GAIN_FADER_MIN,
  audioFaderPositionToGain,
  formatAudioGain,
  audioGainToFaderPosition,
  audioGainToText,
} from "@hyperframes/core/audio-gain";

export function MediaSection({
  projectDir,
  element,
  styles,
  onSetStyle,
  onSetAttribute,
  onSetHtmlAttribute,
  onRemoveBackground,
}: {
  projectDir: string | null;
  element: DomEditSelection;
  styles: Record<string, string>;
  onSetStyle: (prop: string, value: string) => void | Promise<unknown>;
  onSetAttribute: (attr: string, value: string) => void | Promise<void>;
  onSetHtmlAttribute: (attr: string, value: string | null) => void | Promise<void>;
  onRemoveBackground?: (
    inputPath: string,
    options: {
      createBackgroundPlate?: boolean;
      quality?: "fast" | "balanced" | "best";
      onProgress?: (progress: BackgroundRemovalProgress) => void;
    },
  ) => Promise<BackgroundRemovalResult>;
}) {
  const { t } = useTranslation();
  const isVideo = element.tagName === "video";
  const isAudio = element.tagName === "audio";
  const isImage = element.tagName === "img";
  const isVisualMedia = isVideo || isImage;
  const el = element.element;

  const volume = parseNumericValue(element.dataAttributes.volume ?? "") ?? 1;
  const volumeFaderPosition = audioGainToFaderPosition(volume);

  const { mediaStart, mediaStartAttr } = readClipInPoint(element.dataAttributes);

  const hasLoop = el.hasAttribute("loop");
  const hasMuted = el.hasAttribute("muted");
  const hasAudio = element.dataAttributes["has-audio"] === "true";

  const playbackRate = Number.parseFloat(element.dataAttributes["playback-rate"] ?? "1") || 1;

  const objectFit = styles["object-fit"] || "contain";
  const objectPosition = styles["object-position"] || "center";

  const sourceDuration =
    Number.parseFloat(element.dataAttributes["source-duration"] ?? "") ||
    (el as HTMLMediaElement).duration ||
    0;
  const mediaStartMax = Math.max(30, Math.ceil(sourceDuration || mediaStart + 10));

  const srcAttr = readPreviewMediaSrc(el) ?? "";
  const [copied, setCopied] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeProgress, setRemoveProgress] = useState<BackgroundRemovalProgress | null>(null);
  const [createPlate, setCreatePlate] = useState(false);
  const [quality, setQuality] = useState<"fast" | "balanced" | "best">("balanced");

  const absoluteSrc =
    projectDir && srcAttr && !srcAttr.startsWith("http") ? `${projectDir}/${srcAttr}` : srcAttr;
  const projectSrc =
    srcAttr && !/^(?:https?:|data:|blob:)/i.test(srcAttr)
      ? stripQueryAndHash(srcAttr.startsWith("./") ? srcAttr.slice(2) : srcAttr)
      : "";
  const canRemoveBackground = Boolean(onRemoveBackground && isVisualMedia && projectSrc);
  const panelTitle = isImage
    ? t("inspector.media.title.image")
    : isVideo
      ? t("inspector.media.title.video")
      : t("inspector.media.title.audio");

  useEffect(() => {
    setRemoveProgress(null);
    setCreatePlate(false);
  }, [srcAttr]);

  const applyCutoutResult = async (result: BackgroundRemovalResult) => {
    await onSetHtmlAttribute("src", result.outputPath);
    if (isVideo) {
      await onSetAttribute("has-audio", "");
      await onSetHtmlAttribute("muted", "true");
    }
  };

  const runBackgroundRemoval = async () => {
    if (!onRemoveBackground || !projectSrc || removeBusy) return;
    setRemoveBusy(true);
    setRemoveProgress({
      status: "processing",
      progress: 0,
      stage: t("inspector.media.stage.preparing"),
    });
    try {
      const result = await onRemoveBackground(projectSrc, {
        createBackgroundPlate: isVideo && createPlate,
        quality,
        onProgress: setRemoveProgress,
      });
      await applyCutoutResult(result);
      setRemoveProgress({
        status: "complete",
        progress: 100,
        stage: t("inspector.media.stage.applied"),
        ...result,
      });
    } catch (error) {
      setRemoveProgress({
        status: "failed",
        progress: 0,
        stage: t("inspector.media.stage.failed"),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <Section title={panelTitle} icon={isAudio ? <Music size={15} /> : <Film size={15} />}>
      <div className="space-y-4">
        {srcAttr && (
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-fg-3">{t("inspector.media.source")}</div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(absoluteSrc).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
                className="flex h-6 items-center gap-1 rounded-lg border border-border bg-neutral-950 px-2 text-xs font-medium text-fg-2 transition-colors hover:border-neutral-600 hover:text-fg"
              >
                {copied ? <Check size={11} /> : <ClipboardList size={11} />}
                <span>{copied ? t("inspector.media.copied") : t("inspector.media.copy")}</span>
              </button>
            </div>
            <div className="mt-1 truncate text-sm font-medium text-fg-2" title={absoluteSrc}>
              {absoluteSrc}
            </div>
          </div>
        )}

        {isVisualMedia && (
          <div className="grid min-w-0 max-w-full gap-2 overflow-hidden rounded-md bg-surface-1/30 p-2">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="min-w-0">
                <div className={LABEL}>{t("inspector.media.cutout")}</div>
                <div className="mt-0.5 truncate text-xs text-fg-3">
                  {t("inspector.media.createTransparent", { kind: isVideo ? "video" : "image" })}
                </div>
              </div>
              <button
                type="button"
                disabled={!canRemoveBackground || removeBusy}
                onClick={(event) => {
                  event.stopPropagation();
                  void runBackgroundRemoval();
                }}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-surface-1 px-2.5 text-sm font-medium text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                title={
                  canRemoveBackground
                    ? t("inspector.media.removeBgHint")
                    : t("inspector.media.removeBgDisabledHint")
                }
              >
                <Scissors size={13} />
                <span>
                  {removeBusy ? t("inspector.media.working") : t("inspector.media.removeBg")}
                </span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <SelectField
                label={t("inspector.media.quality")}
                value={quality}
                onChange={(next) => setQuality(next as typeof quality)}
                options={["fast", "balanced", "best"]}
              />
              {isVideo ? (
                <div className="grid min-w-0 gap-1.5">
                  <span className={LABEL}>{t("inspector.media.bgPlate")}</span>
                  <SegmentedControl
                    trackName={t("inspector.media.bgPlate")}
                    value={createPlate ? "on" : "off"}
                    onChange={(next) => setCreatePlate(next === "on")}
                    options={[
                      { label: t("inspector.media.on"), value: "on" },
                      { label: t("inspector.media.off"), value: "off" },
                    ]}
                  />
                  <span className="text-xs leading-tight text-fg-3">
                    {t("inspector.media.plateHint")}
                  </span>
                </div>
              ) : (
                <div />
              )}
            </div>

            {removeProgress && (
              <div className="space-y-1">
                <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-fg-3">
                  <span className="min-w-0 flex-1 truncate">
                    {removeProgress.error ??
                      removeProgress.stage ??
                      t("inspector.media.stage.processing")}
                  </span>
                  <span>{Math.round(removeProgress.progress)}%</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-panel-border">
                  <div
                    className={`h-full rounded-full ${
                      removeProgress.status === "failed" ? "bg-red-400" : "bg-studio-accent"
                    }`}
                    style={{ width: `${Math.max(0, Math.min(100, removeProgress.progress))}%` }}
                  />
                </div>
              </div>
            )}

            {removeProgress?.status === "complete" && removeProgress.outputPath && (
              <div
                className="truncate text-xs font-medium text-fg-3"
                title={removeProgress.outputPath}
              >
                {t("inspector.media.applied", { path: removeProgress.outputPath })}
              </div>
            )}
          </div>
        )}

        {(isVideo || isAudio) && (
          <>
            <div className="grid min-w-0 gap-1.5">
              <span className={LABEL}>{t("inspector.media.volume")}</span>
              <SliderControl
                trackName={t("inspector.media.volume")}
                value={volumeFaderPosition}
                min={AUDIO_GAIN_FADER_MIN}
                max={AUDIO_GAIN_FADER_MAX}
                step={1}
                displayValue={audioGainToText(volume)}
                formatDisplayValue={(next) => audioGainToText(audioFaderPositionToGain(next))}
                onCommit={(next) => {
                  void onSetAttribute("volume", formatAudioGain(audioFaderPositionToGain(next)));
                }}
              />
            </div>

            <div className="grid min-w-0 gap-1.5">
              <span className={LABEL}>{t("inspector.media.playbackRate")}</span>
              <SliderControl
                trackName={t("inspector.media.playbackRate")}
                value={playbackRate * 100}
                min={25}
                max={300}
                step={5}
                displayValue={`${formatNumericValue(playbackRate)}x`}
                formatDisplayValue={(next) => `${formatNumericValue(next / 100)}x`}
                onCommit={(next) => {
                  void onSetAttribute("playback-rate", formatNumericValue(next / 100));
                }}
              />
            </div>

            <div className="grid min-w-0 gap-1.5">
              <span className={LABEL}>{t("inspector.media.mediaStart")}</span>
              <SliderControl
                trackName={t("inspector.media.mediaStart")}
                value={Math.round(mediaStart * 100)}
                min={0}
                max={mediaStartMax * 100}
                step={10}
                displayValue={formatTimingValue(mediaStart)}
                formatDisplayValue={(next) => formatTimingValue(next / 100)}
                onCommit={(next) => {
                  void onSetAttribute(mediaStartAttr, (next / 100).toFixed(2));
                }}
              />
            </div>

            <div className={RESPONSIVE_GRID}>
              <div className="grid min-w-0 gap-1.5">
                <span className={LABEL}>{t("inspector.media.loop")}</span>
                <SegmentedControl
                  trackName={t("inspector.media.loop")}
                  value={hasLoop ? "on" : "off"}
                  onChange={(next) => {
                    void onSetHtmlAttribute("loop", next === "on" ? "true" : null);
                  }}
                  options={[
                    { label: t("inspector.media.on"), value: "on" },
                    { label: t("inspector.media.off"), value: "off" },
                  ]}
                />
              </div>
              <div className="grid min-w-0 gap-1.5">
                <span className={LABEL}>{t("inspector.media.muted")}</span>
                <SegmentedControl
                  trackName={t("inspector.media.muted")}
                  value={hasMuted ? "on" : "off"}
                  onChange={(next) => {
                    void onSetHtmlAttribute("muted", next === "on" ? "true" : null);
                  }}
                  options={[
                    { label: t("inspector.media.on"), value: "on" },
                    { label: t("inspector.media.off"), value: "off" },
                  ]}
                />
              </div>
            </div>

            {isVideo && (
              <div className="grid min-w-0 gap-1.5">
                <span className={LABEL}>{t("inspector.media.hasAudioTrack")}</span>
                <SegmentedControl
                  trackName={t("inspector.media.hasAudioTrack")}
                  value={hasAudio ? "yes" : "no"}
                  onChange={(next) => {
                    if (next === "yes") {
                      void onSetAttribute("has-audio", "true");
                      void onSetHtmlAttribute("muted", null);
                    } else {
                      void onSetAttribute("has-audio", "");
                      void onSetHtmlAttribute("muted", "true");
                    }
                  }}
                  options={[
                    { label: t("inspector.media.yes"), value: "yes" },
                    { label: t("inspector.media.no"), value: "no" },
                  ]}
                />
              </div>
            )}
          </>
        )}

        {isVisualMedia && (
          <>
            <div className={RESPONSIVE_GRID}>
              <SelectField
                label={t("inspector.media.fit")}
                value={objectFit}
                onChange={(next) => {
                  void onSetStyle("object-fit", next);
                }}
                options={["contain", "cover", "fill", "none", "scale-down"]}
              />
              <SelectField
                label={t("inspector.media.position")}
                value={objectPosition}
                onChange={(next) => {
                  void onSetStyle("object-position", next);
                }}
                options={[
                  "center",
                  "top",
                  "bottom",
                  "left",
                  "right",
                  "left top",
                  "right top",
                  "left bottom",
                  "right bottom",
                ]}
              />
            </div>
          </>
        )}
      </div>
    </Section>
  );
}
