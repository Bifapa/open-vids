import type { GestureRecordingState } from "../../hooks/useGestureCommit";
import type { GestureRecording, Modifiers } from "../../hooks/useGestureRecording";
import { useTranslation } from "../../i18n";
import { Kbd } from "../ui";
import { GestureTrailOverlay } from "./GestureTrailOverlay";

interface GestureCaptureSurfaceProps {
  state: "armed" | "recording";
  /** Name of the element the path is recorded for. */
  label: string;
  onBegin: (startPointer: { x: number; y: number }, modifiers: Modifiers) => void;
  onFinish: () => void;
  onCancel: () => void;
}

/**
 * Covers the whole preview while a motion path is armed or being recorded. It
 * sits above the canvas editing overlay, so no select / drag / marquee handler
 * underneath sees the pointer, and captures the pointer on press so the move
 * and release events keep arriving wherever the drag goes.
 */
function GestureCaptureSurface({
  state,
  label,
  onBegin,
  onFinish,
  onCancel,
}: GestureCaptureSurfaceProps) {
  const { t } = useTranslation();
  const armed = state === "armed";
  return (
    <div
      data-gesture-capture-surface={state}
      className="absolute inset-0 z-40 cursor-crosshair touch-none select-none"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.button !== 0 || !armed) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Capture is a refinement; document-level move events still arrive.
        }
        onBegin(
          { x: event.clientX, y: event.clientY },
          { shift: event.shiftKey, alt: event.altKey, meta: event.metaKey || event.ctrlKey },
        );
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        onFinish();
      }}
      onPointerCancel={() => {
        if (!armed) onCancel();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        role="status"
        className="pointer-events-none absolute inset-x-3 bottom-3 mx-auto flex w-fit max-w-[34rem] flex-col gap-1 rounded-lg border border-border bg-menu-bg/94 px-3 py-2 text-xs text-fg-2 shadow-tip backdrop-blur-xl"
      >
        {armed ? (
          <>
            <p className="truncate text-sm font-medium text-fg-1">
              {t("editor.gesture.arm.title", { label })}
            </p>
            <p>{t("editor.gesture.arm.instruction")}</p>
            <p className="flex items-center gap-1.5 text-fg-3">
              <span className="min-w-0 flex-1">{t("editor.gesture.arm.modifiers")}</span>
              <Kbd>Esc</Kbd>
              <span>{t("editor.gesture.arm.cancel")}</span>
            </p>
          </>
        ) : (
          <p className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-error" />
            <span>{t("editor.gesture.recording.status")}</span>
            <Kbd>Esc</Kbd>
            <span className="text-fg-3">{t("editor.gesture.arm.cancel")}</span>
          </p>
        )}
      </div>
    </div>
  );
}

interface GestureRecordingLayerProps {
  state: GestureRecordingState;
  label: string;
  gestureRecording: GestureRecording;
  canvasRect: DOMRect | null;
  compositionSize?: { width: number; height: number };
  onBegin: GestureCaptureSurfaceProps["onBegin"];
  onFinish: () => void;
  onCancel: () => void;
}

/** Everything the preview shows for a motion-path recording: the pointer-capture
 *  surface (armed + recording) and the live trail of the drawn path (recording). */
export function GestureRecordingLayer({
  state,
  label,
  gestureRecording,
  canvasRect,
  compositionSize,
  onBegin,
  onFinish,
  onCancel,
}: GestureRecordingLayerProps) {
  if (state === "idle") return null;
  return (
    <>
      <GestureCaptureSurface
        state={state}
        label={label}
        onBegin={onBegin}
        onFinish={onFinish}
        onCancel={onCancel}
      />
      {state === "recording" && (
        <GestureTrailOverlay
          samples={gestureRecording.samplesRef.current}
          sampleCount={gestureRecording.samplesRef.current.length}
          trail={gestureRecording.trailRef.current}
          canvasRect={canvasRect}
          compositionSize={compositionSize}
          mode="recording"
        />
      )}
    </>
  );
}
