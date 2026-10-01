import { useState, type ReactNode } from "react";
import { Sliders } from "@phosphor-icons/react";
import { CANVAS_DIMENSIONS } from "@hyperframes/parsers";
import { Select, type SelectOption } from "../ui/Select";
import { SegmentedControl } from "../ui/SegmentedControl";
import { useDockLayoutStore } from "../dock/dockLayoutStore";
import { usePreviewVariablesStore } from "../../hooks/previewVariablesStore";
import type { ResolutionPreset } from "./useRenderQueue";
import {
  getPersistedRenderSettings,
  persistRenderSettings,
  type PersistedRenderSettings,
} from "./renderSettings";

export interface CompositionDimensions {
  width: number;
  height: number;
}

export type RenderFormat = PersistedRenderSettings["format"];
export type RenderQuality = PersistedRenderSettings["quality"];
export type RenderFps = PersistedRenderSettings["fps"];

// Orientation is derived from the composition's authored aspect ratio,
// not chosen by the user — picking "1080p portrait" for a landscape comp
// would just produce a wrong-aspect render.
type RenderScale = "auto" | "1080p" | "4k";

const SCALE_OPTION_ORDER: RenderScale[] = ["auto", "1080p", "4k"];

const SCALE_LABEL: Record<RenderScale, string> = {
  auto: "Auto",
  "1080p": "1080p",
  "4k": "4K",
};

type CompAspect = "landscape" | "portrait" | "square";

function compAspect(dims: CompositionDimensions | null | undefined): CompAspect {
  // Missing dims fall through to landscape (legacy default — "landscape" was
  // the first preset). Studio shows resolved dims inline, so the user can see
  // when this fallback is in effect.
  if (dims == null) return "landscape";
  if (dims.width === dims.height) return "square";
  return dims.height > dims.width ? "portrait" : "landscape";
}

/** The preset the producer receives for a scale: the composition's own aspect at that size. */
export function resolveResolution(
  scale: RenderScale,
  dims: CompositionDimensions | null | undefined,
): ResolutionPreset | "auto" {
  if (scale === "auto") return "auto";
  const aspect = compAspect(dims);
  if (scale === "1080p") return aspect;
  return aspect === "landscape"
    ? "landscape-4k"
    : aspect === "portrait"
      ? "portrait-4k"
      : "square-4k";
}

function resolvedDimensions(
  scale: RenderScale,
  dims: CompositionDimensions | null | undefined,
): CompositionDimensions | null {
  if (scale === "auto") return dims ?? null;
  const preset = resolveResolution(scale, dims);
  return preset === "auto" ? null : CANVAS_DIMENSIONS[preset];
}

// Mirrors the producer's resolveDeviceScaleFactor validation
// (renderOrchestrator.ts:608): the chosen preset must match the comp's aspect
// ratio exactly (cross-multiplied), can't downsample, and must be an integer
// scale factor. Without this guard the user can pick a preset that throws at
// render time — e.g. 1080p on a 1080×1080 square or 1080p on a 1280×720 comp
// (1.5× isn't integer).
function scaleApplies(scale: RenderScale, dims: CompositionDimensions | null | undefined): boolean {
  if (scale === "auto" || dims == null) return true;
  const preset = resolveResolution(scale, dims);
  if (preset === "auto") return true;
  const target = CANVAS_DIMENSIONS[preset];
  if (target.width * dims.height !== target.height * dims.width) return false;
  if (target.width < dims.width) return false;
  return Number.isInteger(target.width / dims.width);
}

function scaleOptionLabel(
  scale: RenderScale,
  dims: CompositionDimensions | null | undefined,
): string {
  const resolved = resolvedDimensions(scale, dims);
  const base = resolved
    ? `${resolved.width} × ${resolved.height} · ${SCALE_LABEL[scale]}`
    : SCALE_LABEL[scale];
  // Explain *why* an option is disabled instead of greying it silently:
  // the preset must be an exact integer upscale of the authored size.
  if (dims && !scaleApplies(scale, dims)) {
    return `${base} — not an integer scale of ${dims.width}×${dims.height}`;
  }
  return base;
}

// Option order is the persisted contract's order: MP4, MOV, WebM.
const FORMAT_OPTIONS: Array<SelectOption & { value: RenderFormat }> = [
  { value: "mp4", label: "MP4 · H.264" },
  { value: "mov", label: "MOV · ProRes 4444" },
  { value: "webm", label: "WebM · VP9" },
];

const FORMAT_NOTE: Record<RenderFormat, string> = {
  mp4: "Best for general use. Smallest file, universal playback.",
  mov: "Keeps transparency. Works in Final Cut Pro, DaVinci Resolve and most editors. Large files.",
  webm: "Keeps transparency. Smaller than MOV, limited editor support.",
};

const QUALITY_OPTIONS: Array<{ value: RenderQuality; label: string }> = [
  { value: "draft", label: "Draft" },
  { value: "standard", label: "Standard" },
  { value: "high", label: "High" },
];

const FPS_OPTIONS: Array<SelectOption & { value: `${RenderFps}` }> = [
  { value: "24", label: "24 fps" },
  { value: "30", label: "30 fps" },
  { value: "60", label: "60 fps" },
];

function isFormat(value: string): value is RenderFormat {
  return FORMAT_OPTIONS.some((option) => option.value === value);
}

function isScale(value: string): value is RenderScale {
  return SCALE_OPTION_ORDER.some((scale) => scale === value);
}

function toFps(value: string): RenderFps | null {
  const fps = Number(value);
  return fps === 24 || fps === 30 || fps === 60 ? fps : null;
}

/** What the Render button submits: the persisted format/quality/fps plus this session's scale. */
export interface RenderSettings {
  format: RenderFormat;
  quality: RenderQuality;
  fps: RenderFps;
  scale: RenderScale;
}

export interface RenderSettingsState {
  settings: RenderSettings;
  update: (patch: Partial<RenderSettings>) => void;
}

export function useRenderSettings(): RenderSettingsState {
  const [settings, setSettings] = useState<RenderSettings>(() => ({
    ...getPersistedRenderSettings(),
    scale: "auto",
  }));
  const update = (patch: Partial<RenderSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    // Resolution follows the composition, so only the portable three persist.
    if (patch.format || patch.quality || patch.fps) {
      persistRenderSettings(next.format, next.quality, next.fps);
    }
  };
  return { settings, update };
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-ctl-sm grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
      <span className="whitespace-nowrap text-sm text-fg-3">{label}</span>
      {children}
    </div>
  );
}

/** "Uses current variable values · 1 overridden": what the render injects, with a way to edit it. */
function VariablesLine() {
  const overridden = usePreviewVariablesStore((state) =>
    state.values ? Object.keys(state.values).length : 0,
  );
  return (
    <div className="flex min-h-5 min-w-0 items-center gap-2 pl-20">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fg-3">
        <Sliders size={12} className="shrink-0" aria-hidden />
        <span className="truncate">
          {overridden > 0 ? (
            <>
              Uses current variable values ·{" "}
              <span className="font-mono text-num text-fg-2">{overridden}</span> overridden
            </>
          ) : (
            "Uses default variable values"
          )}
        </span>
      </span>
      <button
        type="button"
        onClick={() => useDockLayoutStore.getState().activatePanel("variables")}
        className="shrink-0 rounded-xs text-xs text-fg-2 underline decoration-border-strong underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        Edit
      </button>
    </div>
  );
}

/** The export form: resolution, frame rate, format and quality, on the prototype's label column. */
export function RenderSettingsForm({
  state,
  disabled,
  compositionDimensions,
}: {
  state: RenderSettingsState;
  disabled: boolean;
  compositionDimensions?: CompositionDimensions | null;
}) {
  const { settings, update } = state;
  // MOV (ProRes) is a fixed-quality codec — the quality choice has no effect.
  const showQuality = settings.format !== "mov";

  return (
    <div className="grid gap-1.5 py-2.5">
      <FieldRow label="Resolution">
        <Select
          label="Resolution"
          value={settings.scale}
          options={SCALE_OPTION_ORDER.map((value) => ({
            value,
            label: scaleOptionLabel(value, compositionDimensions),
            disabled: !scaleApplies(value, compositionDimensions),
          }))}
          disabled={disabled}
          onCommit={(next) => {
            if (isScale(next)) update({ scale: next });
          }}
        />
      </FieldRow>
      <FieldRow label="Frame rate">
        <Select
          label="Frame rate"
          value={String(settings.fps)}
          options={FPS_OPTIONS}
          disabled={disabled}
          onCommit={(next) => {
            const fps = toFps(next);
            if (fps) update({ fps });
          }}
        />
      </FieldRow>
      <FieldRow label="Format">
        <Select
          label="Format"
          value={settings.format}
          options={FORMAT_OPTIONS}
          disabled={disabled}
          onCommit={(next) => {
            if (isFormat(next)) update({ format: next });
          }}
        />
      </FieldRow>
      <p className="m-0 pl-20 text-xs text-fg-3 text-pretty">{FORMAT_NOTE[settings.format]}</p>
      {showQuality && (
        <FieldRow label="Quality">
          <SegmentedControl
            label="Quality"
            value={settings.quality}
            options={QUALITY_OPTIONS}
            disabled={disabled}
            onChange={(quality) => update({ quality })}
            className="justify-self-start"
          />
        </FieldRow>
      )}
      <VariablesLine />
    </div>
  );
}
