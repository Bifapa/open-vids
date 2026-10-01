import { useState, useRef, useEffect, useCallback } from "react";
import { Pause, Play, Waveform } from "@phosphor-icons/react";
import { classifyWebAudioMediaRoute } from "@hyperframes/core/runtime/web-audio-route";
import { useTranslation } from "../../i18n";
import { IconButton, cn } from "../ui";
import { ContextMenu } from "./AssetContextMenu";
import {
  ASSET_ITEM_CLASS,
  ASSET_NAME_CLASS,
  ASSET_THUMB_CLASS,
  basename,
  filename,
  formatDuration,
  getAudioSubtype,
  type CopyFeedback,
} from "./assetHelpers";
import {
  CopyChip,
  UsedDot,
  openAssetContextMenu,
  useAssetActivation,
  writeAssetDragData,
} from "./AssetCard";
import { resolveMediaPreviewUrl } from "../../player/components/thumbnailUtils";

// Only one preview should play at a time; starting a row stops the previous one.
let stopCurrentPreview: (() => void) | null = null;

const BAR_COUNT = 16;

export function AudioRow({
  projectId,
  asset,
  used,
  meta,
  onCopy,
  copyFeedback,
  onDelete,
  onRename,
  onAddAssetToTimeline,
}: {
  projectId: string;
  asset: string;
  used: boolean;
  meta?: { description?: string; duration?: number };
  onCopy: (path: string) => void;
  copyFeedback: CopyFeedback;
  onDelete?: (path: string) => void;
  onRename?: (oldPath: string, newPath: string) => void;
  onAddAssetToTimeline?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [bars, setBars] = useState<number[]>([]);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const actxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const animRef = useRef<number>(0);
  const name = basename(asset);
  const subtype = t(getAudioSubtype(asset));
  const serveUrl = resolveMediaPreviewUrl(asset, projectId);
  const isCopied = copyFeedback?.path === asset && copyFeedback.ok;
  const activation = useAssetActivation(asset, projectId, used, onAddAssetToTimeline);
  const durationLabel = formatDuration(meta?.duration ?? 0);

  const stopPlayback = useCallback(() => {
    audioRef.current?.pause();
    setPlaying(false);
    setProgress(0);
    cancelAnimationFrame(animRef.current);
  }, []);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(animRef.current);
      audioRef.current?.pause();
      actxRef.current?.close();
      if (stopCurrentPreview === stopPlayback) stopCurrentPreview = null;
    };
  }, [stopPlayback]);

  useEffect(() => {
    if (playing) {
      const loop = () => {
        const audio = audioRef.current;
        if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
          setProgress(audio.currentTime / audio.duration);
        }
        const analyser = analyserRef.current;
        if (analyser) {
          const data = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(data);
          const step = Math.floor(data.length / BAR_COUNT);
          const next: number[] = [];
          for (let i = 0; i < BAR_COUNT; i++) {
            let sum = 0;
            for (let j = 0; j < step; j++) sum += data[i * step + j];
            next.push(sum / step / 255);
          }
          setBars(next);
        }
        if (!audio || !audio.paused) animRef.current = requestAnimationFrame(loop);
      };
      animRef.current = requestAnimationFrame(loop);
    } else {
      setBars([]);
    }
    return () => cancelAnimationFrame(animRef.current);
  }, [playing]);

  const togglePlay = useCallback(async () => {
    if (playing) {
      stopPlayback();
      if (stopCurrentPreview === stopPlayback) stopCurrentPreview = null;
      return;
    }

    // Stop whichever other row is currently previewing.
    if (stopCurrentPreview && stopCurrentPreview !== stopPlayback) stopCurrentPreview();
    stopCurrentPreview = stopPlayback;

    if (!actxRef.current) {
      actxRef.current = new AudioContext();
      analyserRef.current = actxRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      analyserRef.current.smoothingTimeConstant = 0.7;
    }

    if (!audioRef.current) {
      const el = new Audio();
      el.onended = () => {
        setPlaying(false);
        setProgress(0);
        cancelAnimationFrame(animRef.current);
      };
      // `src` must be set BEFORE classifying: the check reads `currentSrc`/
      // `src`, and a same-origin `serveUrl` mustn't be judged from a blank
      // element.
      el.src = serveUrl;
      audioRef.current = el;
      const analyser = analyserRef.current;
      // Same hazard `webAudioRoute.ts` documents for the timeline runtime
      // (#3458): `createMediaElementSource` on a cross-origin element without
      // a `crossorigin` opt-in permanently reroutes it to a node that outputs
      // SILENCE per the Web Audio spec, without throwing. Classify first so
      // this preview player can't reintroduce that bug — skipping the Web
      // Audio graph here only costs the frequency-bar visualizer; native
      // `<audio>` playback below stays audible either way.
      if (analyser && classifyWebAudioMediaRoute(el).kind === "web-audio") {
        sourceRef.current = actxRef.current.createMediaElementSource(el);
        sourceRef.current.connect(analyser);
        analyser.connect(actxRef.current.destination);
      }
    }

    if (actxRef.current.state === "suspended") await actxRef.current.resume();
    audioRef.current.currentTime = 0;
    try {
      await audioRef.current.play();
      setPlaying(true);
    } catch {
      // Playback refused (e.g. decode failure) — reset instead of a stuck state.
      setPlaying(false);
      if (stopCurrentPreview === stopPlayback) stopCurrentPreview = null;
    }
  }, [serveUrl, playing, stopPlayback]);

  return (
    <>
      <div
        draggable
        role="button"
        tabIndex={0}
        title={filename(asset)}
        aria-label={t("sidebar.asset.rowLabel", { name })}
        {...activation}
        onDragStart={(e) => writeAssetDragData(e, asset)}
        onContextMenu={(e) => openAssetContextMenu(e, setContextMenu)}
        className={cn(
          ASSET_ITEM_CLASS,
          "flex h-row min-w-0 cursor-grab items-center gap-1.5 pr-1.5 pl-0.5 active:cursor-grabbing",
          isCopied && "border-accent-line bg-accent-soft",
        )}
      >
        <IconButton
          size="xs"
          aria-label={t(playing ? "sidebar.audio.pausePreview" : "sidebar.audio.playPreview", {
            name,
          })}
          aria-pressed={playing}
          icon={playing ? <Pause size={12} weight="fill" /> : <Play size={12} weight="fill" />}
          onClick={(e) => {
            e.stopPropagation();
            void togglePlay();
          }}
        />
        <div className={cn(ASSET_THUMB_CLASS, "w-11 shrink-0 bg-k-audio-b")}>
          {bars.length > 0 ? (
            <span aria-hidden="true" className="absolute inset-x-1 inset-y-1 flex items-end gap-px">
              {bars.map((v, i) => (
                <span
                  key={i}
                  className="flex-1 rounded-[1px] bg-wave transition-[height] duration-75 ease-out"
                  style={{ height: `${Math.max(10, v * 100)}%`, opacity: 0.5 + v * 0.5 }}
                />
              ))}
            </span>
          ) : (
            <span
              aria-hidden="true"
              className="absolute inset-0 flex items-center justify-center text-wave"
            >
              <Waveform size={16} />
            </span>
          )}
          {playing && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-fg"
              style={{ width: `${progress * 100}%` }}
            />
          )}
        </div>
        <span className={cn(ASSET_NAME_CLASS, "flex-1 text-base", playing && "text-fg")}>
          {name}
        </span>
        {used && <UsedDot />}
        <CopyChip feedback={copyFeedback} asset={asset} />
        <span className="shrink-0 text-xs text-fg-3 tabular-nums">
          {durationLabel
            ? t("sidebar.audio.subtypeDuration", { subtype, duration: durationLabel })
            : subtype}
        </span>
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          asset={asset}
          onClose={() => setContextMenu(null)}
          onCopy={onCopy}
          onDelete={onDelete}
          onRename={onRename}
          onAddAtPlayhead={onAddAssetToTimeline}
        />
      )}
    </>
  );
}
