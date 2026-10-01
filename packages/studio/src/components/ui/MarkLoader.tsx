import loaderDark from "../../assets/openvids-mark-loader.svg";
import loaderLight from "../../assets/openvids-mark-loader-light.svg";
import { cn } from "./cn";

interface MarkLoaderProps {
  /** What is loading, shown beside the mark and read to assistive tech. */
  label: string;
  /** Pixel height of the mark. */
  size?: number;
  className?: string;
}

/**
 * The brand's looping loader: the OpenVids mark with its playhead scrubbing the timeline (1.8 s), from the same
 * source as the launch intro (the prototype's `openvids-mark-loader[-light].svg`). The artwork carries its own
 * keyframes and stands still under `prefers-reduced-motion`; one file per theme, shown by `data-theme`.
 */
export function MarkLoader({ label, size = 28, className }: MarkLoaderProps) {
  return (
    <span role="status" className={cn("inline-flex select-none items-center gap-3", className)}>
      <img
        src={loaderDark}
        alt=""
        height={size}
        draggable={false}
        className="hf-mark-loader-dark"
      />
      <img
        src={loaderLight}
        alt=""
        height={size}
        draggable={false}
        className="hf-mark-loader-light"
      />
      <span className="text-sm text-fg-3">{label}</span>
    </span>
  );
}
