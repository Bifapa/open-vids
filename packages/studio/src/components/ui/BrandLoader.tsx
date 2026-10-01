import { OpenvidsMark } from "./OpenvidsLogo";

export interface BrandLoaderProps {
  /** Status text shown below the mark. */
  title: string;
  /** Optional secondary detail line. */
  detail?: string;
  /** Optional monospace third line for IDs, counts, or percentages. */
  mono?: string;
  /** Pixel height of the mark itself; status text scales independently. */
  size?: number;
  /** Optional normalized progress value from 0 to 1. */
  progress?: number;
}

/** The calm, branded loading state preview overlays show instead of a generic spinner. */
export function BrandLoader({ title, detail, mono, size = 40, progress }: BrandLoaderProps) {
  const boundedProgress =
    typeof progress === "number" && Number.isFinite(progress)
      ? Math.min(1, Math.max(0, progress))
      : undefined;

  return (
    <div className="hf-loader" role="status" draggable={false}>
      <div className="hf-loader-mark-frame" draggable={false}>
        <OpenvidsMark className="hf-loader-mark" height={size} />
      </div>
      <div className="hf-loader-title">{title}</div>
      {detail && <div className="hf-loader-detail">{detail}</div>}
      {boundedProgress !== undefined && (
        <div
          className="hf-loader-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(boundedProgress * 100)}
        >
          <div
            className="hf-loader-progress__fill"
            style={{ transform: `scaleX(${boundedProgress})` }}
          />
        </div>
      )}
      {mono && <div className="hf-loader-mono">{mono}</div>}
    </div>
  );
}

export function StatusFrame(props: BrandLoaderProps) {
  return (
    <div className="hf-frame">
      <BrandLoader {...props} />
    </div>
  );
}
