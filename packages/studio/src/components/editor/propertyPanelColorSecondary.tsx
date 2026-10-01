import { useEffect, useRef, useState } from "react";
import {
  getHfColorGradingCapabilities,
  normalizeHfColorGrading,
  type NormalizedHfColorGradingSecondary,
} from "@hyperframes/core/color-grading";
import { Eyedropper, Plus, Trash } from "../../icons/SystemIcons";
import { Button } from "../ui/Button";
import { INSP_CHIP, INSP_MINI_BUTTON, INSP_MINI_LABEL } from "./inspectorStyles";
import { FlatSlider } from "./propertyPanelFlatPrimitives";
import { FlatToggle } from "./propertyPanelFlatToggle";
import type { ColorGradingCapturedFrame } from "./useColorGradingPreviews";
import {
  buildColorGradingSecondaryMatte,
  readColorGradingFramePixels,
  sampleColorGradingSecondary,
} from "./colorGradingFrameAnalysis";

type Secondaries = readonly NormalizedHfColorGradingSecondary[];

const SECONDARY_CAPABILITIES = getHfColorGradingCapabilities().secondaries;
const PERCENT_SCALE = 100;
const RANGE_GAP = 0.01;
const HUE_CENTER_MAX = SECONDARY_CAPABILITIES.hue.center.maxExclusive - RANGE_GAP;

function wrapHueCenter(value: number): number {
  const { min, maxExclusive } = SECONDARY_CAPABILITIES.hue.center;
  const span = maxExclusive - min;
  return ((((value - min) % span) + span) % span) + min;
}

const CORRECTION_CONTROLS = [
  ["hueShift", "Hue shift", 1, "°"],
  ["saturation", "Saturation", PERCENT_SCALE, "%"],
  ["luma", "Luma", PERCENT_SCALE, "%"],
  ["temperature", "Warmth", PERCENT_SCALE, "%"],
  ["tint", "Tint", PERCENT_SCALE, "%"],
] as const;

function defaultSecondary(): NormalizedHfColorGradingSecondary {
  const secondary = normalizeHfColorGrading({
    secondaries: [{ key: {}, correction: {} }],
  })?.secondaries?.[0];
  if (!secondary) throw new Error("Missing default color grading secondary");
  return secondary;
}

const DEFAULT_SECONDARY = defaultSecondary();

function sampleCapturedFrame(
  pixels: Uint8ClampedArray,
  frame: ColorGradingCapturedFrame,
  target: HTMLElement,
  clientX?: number,
  clientY?: number,
) {
  const rect = target.getBoundingClientRect();
  const x = (clientX === undefined ? 0.5 : (clientX - rect.left) / rect.width) * frame.width;
  const y = (clientY === undefined ? 0.5 : (clientY - rect.top) / rect.height) * frame.height;
  return sampleColorGradingSecondary(pixels, frame.width, frame.height, x, y);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function PropertyPanelColorSecondary({
  secondaries,
  captureFrame,
  onCommit,
}: {
  secondaries: Secondaries;
  captureFrame: () => Promise<ColorGradingCapturedFrame | null>;
  onCommit: (secondaries: Secondaries) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [sampleFrame, setSampleFrame] = useState<ColorGradingCapturedFrame | null>(null);
  const [samplePixels, setSamplePixels] = useState<Uint8ClampedArray | null>(null);
  const [showMatte, setShowMatte] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [sampling, setSampling] = useState(false);
  const matteCanvasRef = useRef<HTMLCanvasElement>(null);
  const activeIndex = Math.min(selectedIndex, Math.max(0, secondaries.length - 1));
  const selected = secondaries[activeIndex];

  useEffect(() => {
    const canvas = matteCanvasRef.current;
    if (!showMatte || !canvas || !sampleFrame || !samplePixels || !selected) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(sampleFrame.width, sampleFrame.height);
    image.data.set(
      buildColorGradingSecondaryMatte(
        samplePixels,
        sampleFrame.width,
        sampleFrame.height,
        selected.key,
      ),
    );
    context.putImageData(image, 0, 0);
  }, [sampleFrame, samplePixels, selected, showMatte]);

  const replaceSelected = (next: NormalizedHfColorGradingSecondary) => {
    if (!selected) return;
    onCommit(secondaries.map((secondary, index) => (index === activeIndex ? next : secondary)));
  };
  const addSecondary = () => {
    if (secondaries.length >= SECONDARY_CAPABILITIES.max) return;
    onCommit([...secondaries, DEFAULT_SECONDARY]);
    setSelectedIndex(secondaries.length);
  };
  const removeSelected = () => {
    if (!selected) return;
    const next = secondaries.filter((_, index) => index !== activeIndex);
    onCommit(next);
    setSelectedIndex(Math.max(0, Math.min(activeIndex, next.length - 1)));
    setSampleFrame(null);
    setSamplePixels(null);
    setCaptureError(null);
  };

  return (
    <div className="grid gap-1.5" data-flat-grade-secondary="true">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          {secondaries.map((_, index) => (
            <button
              key={index}
              type="button"
              aria-pressed={activeIndex === index}
              onClick={() => {
                setSelectedIndex(index);
                setSampleFrame(null);
                setSamplePixels(null);
                setCaptureError(null);
              }}
              className={INSP_CHIP}
            >
              {index + 1}
            </button>
          ))}
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Add secondary color selection"
            title="Add secondary color selection"
            disabled={secondaries.length >= SECONDARY_CAPABILITIES.max}
            onClick={addSecondary}
            className={INSP_MINI_BUTTON}
          >
            <Plus size={12} />
          </button>
          <button
            type="button"
            aria-label="Remove selected secondary"
            title="Remove selected secondary"
            disabled={!selected}
            onClick={removeSelected}
            className={`${INSP_MINI_BUTTON} hover:text-error`}
          >
            <Trash size={12} />
          </button>
        </span>
      </div>

      {!selected ? (
        <Button
          size="sm"
          title="Add color selection"
          icon={<Plus size={12} />}
          onClick={addSecondary}
        >
          Add a color selection
        </Button>
      ) : (
        <>
          <FlatToggle
            label="Selection enabled"
            checked={selected.enabled}
            onChange={(enabled) => replaceSelected({ ...selected, enabled })}
          />
          <Button
            size="sm"
            className="justify-self-start"
            icon={<Eyedropper size={12} />}
            disabled={sampling}
            onClick={async () => {
              setSampling(true);
              setCaptureError(null);
              try {
                const frame = await captureFrame();
                if (!frame) throw new Error("Frame capture unavailable");
                const pixels = await readColorGradingFramePixels(frame);
                if (!pixels) throw new Error("Frame pixels unavailable");
                setSampleFrame(frame);
                setSamplePixels(pixels);
                setShowMatte(false);
              } catch {
                setSampleFrame(null);
                setSamplePixels(null);
                setCaptureError("Preview frame unavailable. Try again after the media loads.");
              } finally {
                setSampling(false);
              }
            }}
          >
            {sampling ? "Capturing frame" : "Sample color from frame"}
          </Button>
          {captureError && (
            <p role="alert" className="text-xs leading-4 text-error">
              {captureError}
            </p>
          )}
          {sampleFrame && samplePixels && (
            <div className="grid gap-1">
              <div className="flex gap-1">
                <button
                  type="button"
                  aria-pressed={!showMatte}
                  onClick={() => setShowMatte(false)}
                  className={INSP_CHIP}
                >
                  Source
                </button>
                <button
                  type="button"
                  aria-pressed={showMatte}
                  onClick={() => setShowMatte(true)}
                  className={INSP_CHIP}
                >
                  Selection matte
                </button>
              </div>
              {showMatte ? (
                <canvas
                  ref={matteCanvasRef}
                  width={sampleFrame.width}
                  height={sampleFrame.height}
                  role="img"
                  aria-label="Selected color matte"
                  className="block h-auto w-full rounded-sm border border-border bg-bg-1"
                />
              ) : (
                <button
                  type="button"
                  className="block w-full cursor-crosshair overflow-hidden rounded-sm border border-border bg-bg-1"
                  title="Click a color to initialize this selection"
                  aria-label="Sample color from captured frame"
                  onClick={(event) => {
                    const pointer: [] | [number, number] =
                      event.detail === 0 ? [] : [event.clientX, event.clientY];
                    const key = sampleCapturedFrame(
                      samplePixels,
                      sampleFrame,
                      event.currentTarget,
                      ...pointer,
                    );
                    if (!key) return;
                    replaceSelected({ ...selected, key });
                    setShowMatte(true);
                  }}
                >
                  <img
                    src={sampleFrame.dataUrl}
                    alt=""
                    draggable={false}
                    className="block h-auto w-full cursor-crosshair object-contain"
                  />
                </button>
              )}
            </div>
          )}

          <div className={`mt-1 ${INSP_MINI_LABEL}`}>Qualifier</div>
          <FlatSlider
            label="Hue"
            value={selected.key.hue.center}
            min={SECONDARY_CAPABILITIES.hue.center.min}
            max={HUE_CENTER_MAX}
            step={0.1}
            tier="explicitCustom"
            displayValue={`${Math.round(selected.key.hue.center)}°`}
            onCommit={(center) =>
              replaceSelected({
                ...selected,
                key: {
                  ...selected.key,
                  hue: { ...selected.key.hue, center: wrapHueCenter(center) },
                },
              })
            }
          />
          <FlatSlider
            label="Hue range"
            value={selected.key.hue.range}
            min={SECONDARY_CAPABILITIES.hue.range.min}
            max={SECONDARY_CAPABILITIES.hue.range.max}
            tier="explicitCustom"
            displayValue={`${Math.round(selected.key.hue.range)}°`}
            onCommit={(range) =>
              replaceSelected({
                ...selected,
                key: {
                  ...selected.key,
                  hue: {
                    ...selected.key.hue,
                    range,
                    softness: Math.min(
                      selected.key.hue.softness,
                      SECONDARY_CAPABILITIES.hue.rangePlusSoftnessMax - range,
                    ),
                  },
                },
              })
            }
          />
          <FlatSlider
            label="Hue softness"
            value={selected.key.hue.softness}
            min={SECONDARY_CAPABILITIES.hue.softness.min}
            max={Math.min(
              SECONDARY_CAPABILITIES.hue.softness.max,
              SECONDARY_CAPABILITIES.hue.rangePlusSoftnessMax - selected.key.hue.range,
            )}
            tier="explicitCustom"
            displayValue={`${Math.round(selected.key.hue.softness)}°`}
            onCommit={(softness) =>
              replaceSelected({
                ...selected,
                key: { ...selected.key, hue: { ...selected.key.hue, softness } },
              })
            }
          />
          {(["saturation", "luma"] as const).flatMap((key) => {
            const label = key === "saturation" ? "Saturation" : "Luma";
            const range = selected.key[key];
            const capability = SECONDARY_CAPABILITIES[key];
            return [
              <FlatSlider
                key={`${key}-min`}
                label={`${label} min`}
                value={range.min * PERCENT_SCALE}
                min={capability.min.min * PERCENT_SCALE}
                max={capability.min.max * PERCENT_SCALE}
                tier="explicitCustom"
                displayValue={percent(range.min)}
                onCommit={(value) =>
                  replaceSelected({
                    ...selected,
                    key: {
                      ...selected.key,
                      [key]: {
                        ...range,
                        min: Math.max(
                          capability.min.min,
                          Math.min(value / PERCENT_SCALE, range.max - RANGE_GAP),
                        ),
                      },
                    },
                  })
                }
              />,
              <FlatSlider
                key={`${key}-max`}
                label={`${label} max`}
                value={range.max * PERCENT_SCALE}
                min={capability.max.min * PERCENT_SCALE}
                max={capability.max.max * PERCENT_SCALE}
                tier="explicitCustom"
                displayValue={percent(range.max)}
                onCommit={(value) =>
                  replaceSelected({
                    ...selected,
                    key: {
                      ...selected.key,
                      [key]: {
                        ...range,
                        max: Math.min(
                          capability.max.max,
                          Math.max(value / PERCENT_SCALE, range.min + RANGE_GAP),
                        ),
                      },
                    },
                  })
                }
              />,
              <FlatSlider
                key={`${key}-softness`}
                label={`${label} softness`}
                value={range.softness * PERCENT_SCALE}
                min={capability.softness.min * PERCENT_SCALE}
                max={capability.softness.max * PERCENT_SCALE}
                tier="explicitCustom"
                displayValue={percent(range.softness)}
                onCommit={(value) =>
                  replaceSelected({
                    ...selected,
                    key: {
                      ...selected.key,
                      [key]: { ...range, softness: value / PERCENT_SCALE },
                    },
                  })
                }
              />,
            ];
          })}

          <div className={`mt-1 ${INSP_MINI_LABEL}`}>Correction</div>
          {CORRECTION_CONTROLS.map(([key, label, scale, suffix]) => {
            const limit = SECONDARY_CAPABILITIES.correction[key];
            const value = selected.correction[key] * scale;
            return (
              <FlatSlider
                key={key}
                label={label}
                value={value}
                min={limit.min * scale}
                max={limit.max * scale}
                centerTick
                tier={Math.abs(value) > 0.0001 ? "explicitCustom" : "default"}
                displayValue={`${Math.round(value)}${suffix}`}
                onCommit={(next) =>
                  replaceSelected({
                    ...selected,
                    correction: { ...selected.correction, [key]: next / scale },
                  })
                }
                onReset={() =>
                  replaceSelected({
                    ...selected,
                    correction: { ...selected.correction, [key]: 0 },
                  })
                }
              />
            );
          })}
        </>
      )}
    </div>
  );
}
