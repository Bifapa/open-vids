/**
 * Slider: `onPreview` fires while the thumb moves and writes nothing durable; `onCommit`
 * fires at a boundary. Right-click or Escape aborts a drag via `eventDetails.cancel()` and restores the start value.
 */

import { Slider as BaseSlider } from "@base-ui/react/slider";
import { useEffect, useRef, useState } from "react";
import { cn } from "./cn";
import type { PreviewState } from "./Button";

export interface SliderProps {
  /** Accessible name for the thumb. The inspector's row label is the usual one. */
  label: string;
  /** The committed value. */
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Every intermediate value while dragging or stepping. Not a commit. */
  onPreview?: (next: number) => void;
  /** Called at a commit boundary when the value really changed. */
  onCommit: (next: number) => void;
  disabled?: boolean;
  className?: string;
  "data-preview-state"?: PreviewState;
}

const first = (next: number | number[]): number => (Array.isArray(next) ? next[0] : next);

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onPreview,
  onCommit,
  disabled,
  className,
  "data-preview-state": previewState,
}: SliderProps) {
  const [draft, setDraft] = useState(value);
  const draggingRef = useRef(false);
  const abortedRef = useRef(false);
  // The committed value the current gesture started from, so an abort has
  // something to put back.
  const dragStartRef = useRef(value);
  // What was last handed to `onCommit`. A gesture's own commit lands before the
  // parent re-renders, so deduping against the `value` prop would double-fire.
  const committedRef = useRef(value);
  const valueRef = useRef(value);
  valueRef.current = value;

  // An external write wins, except mid-drag: the echo is a frame behind, and
  // applying it would snap the thumb backwards under the pointer.
  useEffect(() => {
    if (draggingRef.current) return;
    committedRef.current = value;
    setDraft(value);
  }, [value]);

  const commit = (next: number) => {
    if (next === committedRef.current) return;
    committedRef.current = next;
    onCommit(next);
  };

  const abort = () => {
    if (!draggingRef.current) return;
    abortedRef.current = true;
    const start = dragStartRef.current;
    setDraft(start);
    onPreview?.(start);
    commit(start);
  };

  return (
    <BaseSlider.Root
      value={draft}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(next, details) => {
        if (abortedRef.current) {
          // The pointer is still down after a right-click abort. Base UI would
          // otherwise keep applying moves to a gesture the user cancelled.
          details.cancel();
          return;
        }
        const n = first(next);
        setDraft(n);
        onPreview?.(n);
      }}
      onValueCommitted={(next) => {
        draggingRef.current = false;
        if (abortedRef.current) {
          abortedRef.current = false;
          return;
        }
        commit(first(next));
      }}
      className={cn("flex min-w-0 items-center", className)}
      data-preview-state={previewState}
    >
      <BaseSlider.Control
        // A stable hook for the drag tests and for the screenshot script. Base
        // UI's own marker on this part only exists before hydration.
        data-slider-control="true"
        // h-6 is the 24x24 WCAG 2.2 (2.5.8) target: the visible track stays
        // 2px, only the pointer box grows.
        className="flex h-6 w-full min-w-0 touch-none select-none items-center"
        onPointerDown={() => {
          draggingRef.current = true;
          abortedRef.current = false;
          dragStartRef.current = valueRef.current;
        }}
        onContextMenu={(event) => {
          if (!draggingRef.current) return;
          event.preventDefault();
          abort();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !draggingRef.current) return;
          event.preventDefault();
          abort();
        }}
      >
        <BaseSlider.Track className="h-[3px] w-full rounded-full bg-surface-3">
          <BaseSlider.Indicator className="rounded-full bg-fg-3" />
          <BaseSlider.Thumb
            aria-label={label}
            className={cn(
              // The prototype's `.rng` thumb: a primary-ink dot whose dark hairline
              // separates it from the track and the panel in both themes.
              "size-3 rounded-full border border-black/45 bg-fg",
              "cursor-grab active:cursor-grabbing data-[preview-state=active]:cursor-grabbing",
              "hover:scale-110 data-[preview-state=hover]:scale-110",
              "transition-transform ease-standard duration-hover",
              "has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
              "data-[preview-state=focus]:outline-solid data-[preview-state=focus]:outline-2 data-[preview-state=focus]:outline-offset-2 data-[preview-state=focus]:outline-accent",
            )}
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
