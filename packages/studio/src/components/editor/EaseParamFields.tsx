import { useEffect, useId, useRef, useState } from "react";
import { parseSpringBounce } from "@hyperframes/core/spring-ease";
import {
  parseWiggleEase,
  type WiggleEaseConfig,
  type WiggleType,
} from "@hyperframes/core/wiggle-ease";
import { roundToCenti } from "../../utils/rounding";
import { MiniCurveSvg } from "./easeCurveSvg";
import { useTranslation } from "../../i18n";
import { INSP_SELECT } from "./inspectorStyles";

type Pts = [number, number, number, number];

const round2 = roundToCenti;
const BEZIER_Y_MIN = -1;
const BEZIER_Y_MAX = 2;
const WIGGLE_TYPES = ["easeOut", "easeInOut", "anticipate", "uniform"] as const;
const WIGGLE_DEFAULT_AMPLITUDE = {
  easeOut: 0.16,
  easeInOut: 0.08,
  anticipate: 0.12,
  uniform: 0.14,
} satisfies Record<WiggleType, number>;

function isWiggleType(value: string): value is WiggleType {
  return WIGGLE_TYPES.some((type) => type === value);
}

function commitWiggle(
  onCommit: (ease: string) => void,
  count: number,
  type: WiggleType,
  amplitude: number,
): void {
  const ease = `wiggle(${count},${type},${roundToCenti(amplitude)})`;
  if (parseWiggleEase(ease)) onCommit(ease);
}

// Editable cubic-bezier control points, Figma-style ("0.33, 0, 0, 1").
export function EaseBezierField({
  tuple,
  onCommit,
}: {
  tuple: Pts;
  onCommit: (ease: string) => void;
}) {
  const { t } = useTranslation();
  const text = tuple.join(", ");
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [error, setError] = useState<"count" | "range" | null>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.value = text;
    setError(null);
  }, [text]);

  const commit = (raw: string) => {
    const tokens = raw.trim().split(/[\s,]+/);
    const nums = tokens.map(Number);
    if (tokens.length !== 4 || nums.some((value) => !Number.isFinite(value))) {
      setError("count");
      return;
    }
    const [x1, y1, x2, y2] = nums as [number, number, number, number];
    if (y1 < BEZIER_Y_MIN || y1 > BEZIER_Y_MAX || y2 < BEZIER_Y_MIN || y2 > BEZIER_Y_MAX) {
      setError("range");
      return;
    }
    const cx = (v: number) => Math.max(0, Math.min(1, v));
    setError(null);
    onCommit(`custom(M0,0 C${round2(cx(x1))},${round2(y1)} ${round2(cx(x2))},${round2(y2)} 1,1)`);
  };
  return (
    <div className="mt-1.5 px-0.5">
      <div className="flex items-center gap-1.5">
        <MiniCurveSvg
          ease={`custom(M0,0 C${tuple[0]},${tuple[1]} ${tuple[2]},${tuple[3]} 1,1)`}
          active
          size={14}
        />
        <input
          ref={inputRef}
          type="text"
          defaultValue={text}
          aria-label={t("editor.ease.bezierPoints")}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          onInput={() => setError(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = text;
              setError(null);
            }
          }}
          onBlur={(event) => commit(event.currentTarget.value)}
          className={`h-ctl-sm w-full rounded-sm border bg-surface-1 px-1.5 font-mono text-num text-fg outline-hidden focus-visible:outline-2 focus-visible:outline-offset-1 ${
            error
              ? "border-error focus-visible:outline-error"
              : "border-border hover:border-border-strong focus-visible:outline-accent"
          }`}
        />
      </div>
      <p
        id={errorId}
        aria-live="polite"
        className={`mt-1 text-2xs text-error ${error ? "" : "sr-only"}`}
      >
        {error === "count" && t("editor.ease.errorCount")}
        {error === "range" && t("editor.ease.errorRange", { min: BEZIER_Y_MIN, max: BEZIER_Y_MAX })}
        {error === null && t("editor.ease.validBezier")}
      </p>
    </div>
  );
}

function NumericCommitInput({
  label,
  value,
  min,
  max,
  step,
  className,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  className: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    if (draft.trim() === "") {
      setDraft(String(value));
      return;
    }
    const next = Number(draft);
    if (!Number.isFinite(next) || next < min || (max !== undefined && next > max)) {
      setDraft(String(value));
      return;
    }
    onCommit(next);
  };
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(String(value));
        }
      }}
      className={className}
    />
  );
}

export function SpringBounceField({
  springBounce,
  onCommit,
}: {
  springBounce: number;
  onCommit: (ease: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-1.5 flex items-center gap-2 px-0.5 text-xs text-fg-2">
      <span aria-hidden="true">{t("editor.ease.bounce")}</span>
      <NumericCommitInput
        label={t("editor.ease.springBounce")}
        value={springBounce}
        min={0}
        max={1}
        step={0.01}
        onCommit={(value) => {
          const bounce = parseSpringBounce(`spring(${value})`);
          if (bounce !== null) onCommit(`spring(${round2(bounce)})`);
        }}
        className="h-ctl-sm w-16 rounded-sm border border-border bg-surface-1 px-1.5 font-mono text-num text-fg outline-hidden hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      />
    </div>
  );
}

export function WiggleField({
  config,
  onCommit,
}: {
  config: WiggleEaseConfig;
  onCommit: (ease: string) => void;
}) {
  const { t } = useTranslation();
  const amplitude = config.amplitude ?? WIGGLE_DEFAULT_AMPLITUDE[config.type];
  return (
    <div className="mt-1.5 flex items-center gap-2 px-0.5 text-xs text-fg-2">
      <div className="flex items-center gap-1">
        <span aria-hidden="true">{t("editor.ease.count")}</span>
        <NumericCommitInput
          label={t("editor.ease.wiggleCount")}
          value={config.wiggles}
          min={1}
          step={1}
          onCommit={(value) => commitWiggle(onCommit, value, config.type, amplitude)}
          className="h-ctl-sm w-14 rounded-sm border border-border bg-surface-1 px-1.5 font-mono text-num text-fg outline-hidden hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        />
      </div>
      <div className="flex items-center gap-1">
        <span aria-hidden="true">{t("editor.ease.type")}</span>
        <select
          aria-label={t("editor.ease.wiggleType")}
          value={config.type}
          onChange={(event) => {
            if (isWiggleType(event.currentTarget.value)) {
              commitWiggle(onCommit, config.wiggles, event.currentTarget.value, amplitude);
            }
          }}
          className={`${INSP_SELECT} w-auto`}
        >
          {WIGGLE_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1">
        <span aria-hidden="true">{t("editor.ease.amplitude")}</span>
        <NumericCommitInput
          label={t("editor.ease.wiggleAmplitude")}
          value={amplitude}
          min={0}
          max={1}
          step={0.01}
          onCommit={(value) => commitWiggle(onCommit, config.wiggles, config.type, value)}
          className="h-ctl-sm w-16 rounded-sm border border-border bg-surface-1 px-1.5 font-mono text-num text-fg outline-hidden hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        />
      </div>
    </div>
  );
}
