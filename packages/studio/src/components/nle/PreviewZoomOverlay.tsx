import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Button } from "../ui";
import { Trans, formatPercent, useTranslation } from "../../i18n";
import {
  isFitZoom,
  isPreviewAtFit,
  resolvePreviewVisibleRegion,
  toDomPrecision,
  type PreviewZoomState,
} from "./previewZoom";

const NAVIGATOR_PX = 112;

function navigatorFrameSize(stage: { width: number; height: number }) {
  const ratio = stage.width > 0 && stage.height > 0 ? stage.width / stage.height : 16 / 9;
  return ratio >= 1
    ? { width: NAVIGATOR_PX, height: toDomPrecision(NAVIGATOR_PX / ratio) }
    : { width: toDomPrecision(NAVIGATOR_PX * ratio), height: NAVIGATOR_PX };
}

/** `draw` moves the navigator's highlight without a render, so it can follow every transform write. */
export function usePreviewNavigator(
  viewportRef: RefObject<HTMLDivElement | null>,
  stageSize: { width: number; height: number },
  zoomRef: RefObject<PreviewZoomState>,
) {
  const regionRef = useRef<HTMLDivElement | null>(null);
  const stageSizeRef = useRef(stageSize);
  stageSizeRef.current = stageSize;
  const draw = useCallback(
    (state: PreviewZoomState) => {
      const region = regionRef.current;
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!region || !rect) return;
      const visible = resolvePreviewVisibleRegion({
        state,
        viewportWidth: rect.width,
        viewportHeight: rect.height,
        contentWidth: stageSizeRef.current.width,
        contentHeight: stageSizeRef.current.height,
      });
      region.style.left = `${visible.left * 100}%`;
      region.style.top = `${visible.top * 100}%`;
      region.style.width = `${visible.width * 100}%`;
      region.style.height = `${visible.height * 100}%`;
    },
    [viewportRef],
  );
  const setRegion = useCallback(
    (node: HTMLDivElement | null) => {
      regionRef.current = node;
      draw(zoomRef.current);
    },
    [draw, zoomRef],
  );
  useEffect(() => draw(zoomRef.current), [stageSize, draw, zoomRef]);
  return { draw, setRegion };
}

export function PreviewZoomOverlay({
  zoom,
  stageSize,
  onFit,
  navigatorRegionRef,
}: {
  zoom: PreviewZoomState;
  stageSize: { width: number; height: number };
  onFit: () => void;
  navigatorRegionRef: (node: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation();
  if (isPreviewAtFit(zoom)) return null;
  return (
    <>
      <div
        className="absolute top-2.5 left-2.5 z-50 flex h-ctl items-center gap-2 rounded-md border border-border bg-bg-1/94 py-0 pr-0.5 pl-2.5 text-xs whitespace-nowrap text-fg-2 shadow-tip"
        data-testid="preview-zoom-chip"
        // The pane clears the timeline selection on a pointerdown outside the frame.
        onPointerDown={(event) => event.stopPropagation()}
      >
        {isFitZoom(zoom.zoomPercent) ? (
          <span>{t("timeline.zoom.panned")}</span>
        ) : (
          <span>
            <Trans
              i18nKey="timeline.zoom.zoomed"
              values={{ percent: formatPercent(Math.round(zoom.zoomPercent) / 100) }}
              components={{
                b: <b className="font-mono text-num font-medium tabular-nums text-fg" />,
              }}
            />
          </span>
        )}
        <Button
          size="xs"
          variant="secondary"
          onClick={onFit}
          aria-label={t("timeline.zoom.fitLabel")}
          data-testid="preview-zoom-fit"
        >
          {t("timeline.zoom.fit")}
        </Button>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-2.5 left-2.5 z-50 overflow-hidden rounded-sm border border-border bg-tip-bg/88 shadow-tip"
        data-testid="preview-zoom-navigator"
      >
        <div className="relative overflow-hidden" style={navigatorFrameSize(stageSize)}>
          <div
            ref={navigatorRegionRef}
            className="absolute rounded-[2px] border-[1.5px] border-fg bg-fg/10"
            data-testid="preview-zoom-navigator-region"
          />
        </div>
      </div>
    </>
  );
}
