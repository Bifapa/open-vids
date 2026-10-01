import { buildProjectApiPath } from "../../utils/projectRouting";
import { useMemo, useRef, useState } from "react";
import { Plus, X } from "../../icons/SystemIcons";
import {
  buildDefaultGradientModel,
  insertGradientStop,
  parseGradient,
  serializeGradient,
  type GradientModel,
} from "./gradientValue";
import { ReverseGradientIcon } from "../icons/ReverseGradientIcon";
import { IMAGE_EXT } from "@hyperframes/core/media-types";
import { FIELD, LABEL, RESPONSIVE_GRID } from "./propertyPanelHelpers";
import {
  DetailField,
  SelectField,
  SegmentedControl,
  SliderControl,
} from "./propertyPanelPrimitives";
import { ColorField } from "./propertyPanelColor";
import { buttonBase, buttonSizes, buttonVariants } from "../ui/Button";
import { INSP_MINI_BUTTON } from "./inspectorStyles";

/** The prototype's secondary `.btn.sm` for the fill editors' actions. */
const FILL_BUTTON = `${buttonBase} ${buttonVariants.secondary} ${buttonSizes.sm}`;

/* ------------------------------------------------------------------ */
/*  Asset path helpers                                                 */
/* ------------------------------------------------------------------ */

function normalizeProjectPath(value: string): string {
  const trimmed = value.trim();
  const maybeUrl = /^[a-z]+:\/\//i.test(trimmed) ? new URL(trimmed).pathname : trimmed;
  return decodeURIComponent(maybeUrl)
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
}

function toRelativeProjectAssetPath(sourceFile: string, assetPath: string): string {
  const fromParts = normalizeProjectPath(sourceFile).split("/").filter(Boolean);
  const targetParts = normalizeProjectPath(assetPath).split("/").filter(Boolean);
  fromParts.pop();
  while (fromParts.length > 0 && targetParts.length > 0 && fromParts[0] === targetParts[0]) {
    fromParts.shift();
    targetParts.shift();
  }
  return [...fromParts.map(() => ".."), ...targetParts].join("/") || assetPath;
}

function toProjectRootAssetPath(assetPath: string): string {
  return normalizeProjectPath(assetPath);
}

function resolveSelectedAsset(
  imageUrl: string,
  sourceFile: string,
  assets: string[],
): string | null {
  const normalizedUrl = normalizeProjectPath(imageUrl);
  if (!normalizedUrl) return null;
  for (const asset of assets) {
    const normalizedAsset = normalizeProjectPath(asset);
    const relativeAsset = toRelativeProjectAssetPath(sourceFile, asset);
    if (
      normalizedUrl === normalizedAsset ||
      normalizedUrl === relativeAsset ||
      normalizedUrl.endsWith(`/${normalizedAsset}`) ||
      normalizedUrl.endsWith(`/${relativeAsset}`)
    ) {
      return asset;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  ImageFillField                                                     */
/* ------------------------------------------------------------------ */

export function ImageFillField({
  projectId,
  sourceFile,
  value,
  assets,
  disabled,
  onCommit,
  onImportAssets,
}: {
  projectId: string;
  sourceFile: string;
  value: string;
  assets: string[];
  disabled?: boolean;
  onCommit: (nextValue: string) => void;
  onImportAssets?: (files: FileList) => Promise<string[]>;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const imageAssets = useMemo(() => assets.filter((a) => IMAGE_EXT.test(a)), [assets]);
  const selectedAsset = useMemo(
    () => resolveSelectedAsset(value, sourceFile, imageAssets),
    [imageAssets, sourceFile, value],
  );
  const externalUrlValue = selectedAsset ? "" : value;

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length || !onImportAssets) return;
    setUploading(true);
    setUploadError(null);
    try {
      const uploaded = await onImportAssets(files);
      const nextImage = uploaded.find((a) => IMAGE_EXT.test(a));
      if (nextImage) {
        onCommit(`url("${toProjectRootAssetPath(nextImage)}")`);
      }
    } catch {
      setUploadError("Upload failed — check the file and try again.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="grid gap-2">
      <div className="grid min-w-0 gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className={LABEL}>Project asset</span>
          <button
            type="button"
            disabled={disabled || uploading}
            onClick={() => fileInputRef.current?.click()}
            className={`${FILL_BUTTON} max-w-full`}
          >
            <Plus size={12} className="shrink-0" />
            <span className="truncate">{uploading ? "Uploading…" : "Upload image"}</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            aria-label="Upload image asset"
            disabled={disabled || uploading}
            className="hidden"
            onChange={async (event) => {
              await handleUpload(event.target.files);
              event.target.value = "";
            }}
          />
        </div>
        {uploadError && (
          <div className="text-xs text-error" role="alert">
            {uploadError}
          </div>
        )}
        {imageAssets.length > 0 ? (
          <div className="grid gap-1.5">
            {selectedAsset && (
              <div className="overflow-hidden rounded-sm border border-border-subtle bg-bg-1">
                <img
                  src={buildProjectApiPath(projectId, `/preview/${selectedAsset}`)}
                  alt={selectedAsset.split("/").pop() ?? selectedAsset}
                  className="h-28 w-full bg-bg-1 object-contain"
                />
              </div>
            )}
            <div className={FIELD}>
              <select
                value={selectedAsset ?? ""}
                disabled={disabled}
                onChange={(e) => {
                  const next = e.target.value;
                  if (!next) {
                    onCommit("none");
                    return;
                  }
                  onCommit(`url("${toProjectRootAssetPath(next)}")`);
                }}
                className="min-w-0 w-full appearance-none bg-transparent text-sm font-medium text-fg outline-hidden disabled:cursor-not-allowed disabled:text-fg-disabled"
              >
                <option value="">None</option>
                {imageAssets.map((asset) => (
                  <option key={asset} value={asset}>
                    {asset}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-surface-1/50 px-3 py-3 text-sm leading-5 text-fg-3">
            No image assets yet. Upload one here and Studio will also add it to the Assets tab.
          </div>
        )}
      </div>

      <DetailField
        label="External URL"
        value={externalUrlValue}
        disabled={disabled}
        onCommit={(next) => onCommit(next.trim() ? `url("${next.trim()}")` : "none")}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  GradientField                                                      */
/* ------------------------------------------------------------------ */

export function GradientField({
  value,
  fallbackColor,
  disabled,
  onCommit,
}: {
  value: string;
  fallbackColor: string | undefined;
  disabled?: boolean;
  onCommit: (nextValue: string) => void;
}) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const parsed = parseGradient(value) ?? buildDefaultGradientModel(fallbackColor);

  const commit = (next: GradientModel) => onCommit(serializeGradient(next));
  const patch = (partial: Partial<GradientModel>) => commit({ ...parsed, ...partial });

  const updateStop = (index: number, partial: Partial<GradientModel["stops"][number]>) => {
    const stops = parsed.stops.map((stop, i) => (i === index ? { ...stop, ...partial } : stop));
    commit({ ...parsed, stops });
  };

  const addStop = (position?: number) => {
    const nextGradient =
      position != null
        ? insertGradientStop(parsed, position)
        : insertGradientStop(
            parsed,
            parsed.stops.at(-1)?.position != null
              ? Math.min(100, (parsed.stops.at(-1)?.position ?? 90) + 10)
              : 100,
          );
    commit(nextGradient);
  };

  const removeStop = (index: number) => {
    if (parsed.stops.length <= 2) return;
    commit({ ...parsed, stops: parsed.stops.filter((_, i) => i !== index) });
  };

  const previewStyle = { backgroundImage: serializeGradient(parsed) };

  return (
    <div className="space-y-4">
      <div className={`${FIELD} space-y-3 p-3`}>
        <div
          ref={previewRef}
          className="relative h-11 overflow-hidden rounded-lg border border-border"
          style={previewStyle}
          onClick={(event) => {
            if (disabled) return;
            const rect = previewRef.current?.getBoundingClientRect();
            if (!rect || rect.width <= 0) return;
            addStop(((event.clientX - rect.left) / rect.width) * 100);
          }}
        >
          {parsed.stops.map((stop, index) => (
            <div
              key={`stop-preview-${index}`}
              role="slider"
              tabIndex={disabled ? -1 : 0}
              aria-label={`Stop ${index + 1} position`}
              aria-valuenow={Math.round(stop.position)}
              aria-valuemin={0}
              aria-valuemax={100}
              onKeyDown={(event) => {
                if (disabled) return;
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const step = event.shiftKey ? 10 : 1;
                const delta = event.key === "ArrowRight" ? step : -step;
                updateStop(index, {
                  position: Math.max(0, Math.min(100, Math.round(stop.position + delta))),
                });
              }}
              className="hf-insp-puck absolute top-1/2 size-3.5 -translate-y-1/2 cursor-ew-resize rounded-full outline-hidden focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              style={{
                left: `calc(${stop.position}% - 7px)`,
                backgroundColor: stop.color,
              }}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => {
                if (disabled) return;
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const rect = previewRef.current?.getBoundingClientRect();
                if (!rect || rect.width <= 0) return;
                const next = Math.max(
                  0,
                  Math.min(100, ((event.clientX - rect.left) / rect.width) * 100),
                );
                updateStop(index, { position: Math.round(next * 10) / 10 });
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
            />
          ))}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SegmentedControl
            trackName="Gradient type"
            disabled={disabled}
            value={parsed.kind}
            onChange={(next) => patch({ kind: next as GradientModel["kind"] })}
            options={[
              { label: "Linear", value: "linear" },
              { label: "Radial", value: "radial" },
              { label: "Conic", value: "conic" },
            ]}
          />
          <label className="flex items-center gap-2 text-sm text-fg-2">
            <input
              type="checkbox"
              checked={parsed.repeating}
              disabled={disabled}
              onChange={(e) => {
                patch({ repeating: e.target.checked });
              }}
              className="size-3.5 accent-fg"
            />
            Repeat
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              commit({
                ...parsed,
                stops: [...parsed.stops].reverse().map((stop) => ({
                  ...stop,
                  position: 100 - stop.position,
                })),
              });
            }}
            className={FILL_BUTTON}
          >
            <ReverseGradientIcon size={14} />
            Reverse
          </button>
        </div>
      </div>

      {(parsed.kind === "linear" || parsed.kind === "conic") && (
        <div className="grid gap-1.5">
          <span className={LABEL}>{parsed.kind === "linear" ? "Angle" : "Start angle"}</span>
          <SliderControl
            trackName={parsed.kind === "linear" ? "Angle" : "Start angle"}
            value={parsed.angle}
            min={0}
            max={360}
            step={1}
            disabled={disabled}
            displayValue={`${Math.round(parsed.angle)}°`}
            formatDisplayValue={(next) => `${Math.round(next)}°`}
            onCommit={(next) => patch({ angle: next })}
          />
        </div>
      )}

      {parsed.kind === "radial" && (
        <div className={RESPONSIVE_GRID}>
          <SelectField
            label="Shape"
            value={parsed.shape}
            disabled={disabled}
            onChange={(next) => patch({ shape: next as GradientModel["shape"] })}
            options={["ellipse", "circle"]}
          />
          <SelectField
            label="Size"
            value={parsed.radialSize}
            disabled={disabled}
            onChange={(next) => patch({ radialSize: next as GradientModel["radialSize"] })}
            options={["closest-side", "closest-corner", "farthest-side", "farthest-corner"]}
          />
        </div>
      )}

      {(parsed.kind === "radial" || parsed.kind === "conic") && (
        <div className={RESPONSIVE_GRID}>
          <div className="grid min-w-0 gap-1.5">
            <span className={LABEL}>Center X</span>
            <SliderControl
              trackName="Center X"
              value={parsed.centerX}
              min={0}
              max={100}
              step={1}
              disabled={disabled}
              displayValue={`${Math.round(parsed.centerX)}%`}
              formatDisplayValue={(next) => `${Math.round(next)}%`}
              onCommit={(next) => patch({ centerX: next })}
            />
          </div>
          <div className="grid min-w-0 gap-1.5">
            <span className={LABEL}>Center Y</span>
            <SliderControl
              trackName="Center Y"
              value={parsed.centerY}
              min={0}
              max={100}
              step={1}
              disabled={disabled}
              displayValue={`${Math.round(parsed.centerY)}%`}
              formatDisplayValue={(next) => `${Math.round(next)}%`}
              onCommit={(next) => patch({ centerY: next })}
            />
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className={LABEL}>Stops</span>
          <button
            type="button"
            disabled={disabled || parsed.stops.length >= 6}
            onClick={() => addStop()}
            title={parsed.stops.length >= 6 ? "Maximum 6 stops" : "Add a gradient stop"}
            className={FILL_BUTTON}
          >
            <Plus size={12} />
            Add stop
          </button>
        </div>
        <div className="grid gap-1.5">
          {parsed.stops.map((stop, index) => (
            <div
              key={`stop-editor-${index}`}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_64px_auto] items-end gap-1"
            >
              <ColorField
                label={`Stop ${index + 1}`}
                value={stop.color}
                disabled={disabled}
                onCommit={(next) => updateStop(index, { color: next })}
              />
              <DetailField
                label="Pos"
                value={`${Math.round(stop.position)}%`}
                disabled={disabled}
                onCommit={(next) =>
                  updateStop(index, {
                    position: Number.parseFloat(next.replace("%", "")) || 0,
                  })
                }
              />
              <button
                type="button"
                disabled={disabled || parsed.stops.length <= 2}
                onClick={() => removeStop(index)}
                className={`${INSP_MINI_BUTTON} mb-0.5 hover:text-error`}
                aria-label={`Remove stop ${index + 1}`}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
