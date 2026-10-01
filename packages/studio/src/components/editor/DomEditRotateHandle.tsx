import type { PointerEvent as ReactPointerEvent } from "react";
import type { OverlayRect } from "./domEditOverlayGeometry";

/** Rotate handle below the selection: a small knob on a stem back to the box
 *  (prototype `.v-rot`, flipped below so it clears our crop handles). Anchors
 *  to the crop outline when the element is cropped so it stays next to what's
 *  visible on screen. Presentation only — the rotation gesture measures pointer
 *  angles from the element CENTER (resolveDomEditRotationGesture), so the
 *  handle position doesn't affect the math. Sits 12px below the bbox, past the
 *  bottom crop handle's hit strip. */
export function DomEditRotateHandle({
  overlayRect,
  cropOutlineInsetPx,
  onStartRotate,
}: {
  overlayRect: OverlayRect;
  cropOutlineInsetPx?: { top: number; right: number; bottom: number; left: number };
  onStartRotate: (e: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const inset = cropOutlineInsetPx ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const visibleLeft = overlayRect.left + inset.left;
  const visibleWidth = Math.max(0, overlayRect.width - inset.left - inset.right);
  const visibleBottom = overlayRect.top + overlayRect.height - inset.bottom;
  return (
    <button
      type="button"
      className="pointer-events-auto absolute flex items-center justify-center border-0 bg-transparent p-0"
      style={{
        left: visibleLeft + visibleWidth / 2,
        top: visibleBottom + 12,
        width: 22,
        height: 22,
        transform: "translateX(-50%)",
        touchAction: "none",
        // Closed-hand grab cursor: this handle is grabbed and dragged to rotate.
        cursor: "grabbing",
      }}
      title="Rotate"
      aria-label="Rotate selection"
      onPointerDown={onStartRotate}
    >
      <span className="pointer-events-none relative size-2.5 rounded-full border-[1.5px] border-accent bg-fg before:absolute before:bottom-full before:left-1/2 before:h-[17px] before:w-px before:-translate-x-1/2 before:bg-accent before:content-['']" />
    </button>
  );
}
