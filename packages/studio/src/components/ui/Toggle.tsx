/**
 * Toggle: a switch, not a checkbox (immediate effect). `role="switch"` needed an entry in
 * `typingTarget.ts` so Space is not leaked to the global playback shortcut.
 */

import { Switch } from "@base-ui/react/switch";
import { cn } from "./cn";
import type { PreviewState } from "./Button";

export interface ToggleProps {
  /** Accessible name. */
  label: string;
  checked: boolean;
  /** Called on every flip. */
  onCommit: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
  "data-preview-state"?: PreviewState;
}

export function Toggle({
  label,
  checked,
  onCommit,
  disabled,
  className,
  "data-preview-state": previewState,
}: ToggleProps) {
  return (
    <Switch.Root
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCommit}
      data-preview-state={previewState}
      className={cn(
        // The prototype's `.sw`: a neutral switch. On is a brighter track and the
        // primary ink, not the accent, which stays for selection and focus.
        "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-pill p-0.5",
        "border border-border-strong bg-surface-1",
        "transition-[background-color,border-color] ease-standard duration-press",
        "hover:border-fg-3 data-[preview-state=hover]:border-fg-3",
        "data-[checked]:border-fg-3 data-[checked]:bg-surface-3",
        "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "data-[preview-state=focus]:outline-solid data-[preview-state=focus]:outline-2 data-[preview-state=focus]:outline-offset-2 data-[preview-state=focus]:outline-accent",
        "data-[disabled]:cursor-not-allowed data-[disabled]:border-border data-[disabled]:bg-transparent",
        className,
      )}
    >
      <Switch.Thumb
        className={cn(
          "size-2.5 rounded-full bg-fg-3",
          "transition-[transform,background-color] ease-standard duration-press",
          "data-[checked]:translate-x-3 data-[checked]:bg-fg",
          "data-[disabled]:bg-fg-disabled data-[disabled]:data-[checked]:bg-fg-3",
        )}
      />
    </Switch.Root>
  );
}
