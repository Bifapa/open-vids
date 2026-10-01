import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { INSP_MINI_LABEL } from "./inspectorStyles";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import { SUPPORTED_EASES, SUPPORTED_PROPS } from "@hyperframes/core/gsap-constants";
import { RESPONSIVE_GRID } from "./propertyPanelHelpers";
import { MetricField, SelectField } from "./propertyPanelPrimitives";
import { controlPointsForGsapEase } from "./studioMotion";
import { EASE_LABELS, METHOD_LABELS, METHOD_TOOLTIPS, PROP_LABELS } from "./gsapAnimationConstants";
import { buildTweenSummary } from "./gsapAnimationHelpers";
import { EaseCurveSection } from "./EaseCurveSection";
import { ArcPathControls } from "./ArcPathControls";
import type { GsapAnimationEditCallbacks } from "./gsapAnimationCallbacks";
import { ComputedTweenNotice } from "./ComputedTweenNotice";
import { KeyframeEaseList } from "./KeyframeEaseList";
import {
  PropertyRow,
  AddPropertyTrigger,
  parseNumericOrString,
  BOOLEAN_PROPS,
} from "./AnimationCardParts";
import type { AnimationKeyframeTarget } from "../../hooks/gsapTweenSynth";

interface AnimationCardProps extends GsapAnimationEditCallbacks {
  animation: GsapAnimation;
  defaultExpanded: boolean;
  flat?: boolean;
  focusedSegment?: {
    tweenPercentage: number;
    collidingAnimationTargets?: AnimationKeyframeTarget[];
  } | null;
  onFocusSegmentConsumed?: () => void;
}

export const AnimationCard = memo(function AnimationCard({
  animation,
  defaultExpanded,
  flat,
  focusedSegment,
  onFocusSegmentConsumed,
  onUpdateProperty,
  onUpdateMeta,
  onDeleteAnimation,
  onAddProperty,
  onRemoveProperty,
  onUpdateFromProperty,
  onAddFromProperty,
  onRemoveFromProperty,
  onLivePreview,
  onLivePreviewEnd,
  onSetArcPath,
  onUpdateArcSegment,
  onUpdateKeyframeEase,
  onUpdateSegmentEase,
  onSetAllKeyframeEases,
  onUnroll,
}: AnimationCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [addingProp, setAddingProp] = useState(false);
  const [addingFromProp, setAddingFromProp] = useState(false);
  const [expandedKfPct, setExpandedKfPct] = useState<number | null>(null);
  const [focusedCollidingAnimationTargets, setFocusedCollidingAnimationTargets] = useState<
    AnimationKeyframeTarget[] | undefined
  >();
  const cardRef = useRef<HTMLDivElement>(null);
  const pendingAutoScrollRef = useRef(false);

  useEffect(() => {
    if (!focusedSegment) return;
    setExpanded(true);
    pendingAutoScrollRef.current = true;
    setExpandedKfPct(focusedSegment.tweenPercentage);
    setFocusedCollidingAnimationTargets(focusedSegment.collidingAnimationTargets);
    onFocusSegmentConsumed?.();
  }, [focusedSegment, onFocusSegmentConsumed]);

  useEffect(() => {
    if (!pendingAutoScrollRef.current || expandedKfPct === null) return;
    const segment = cardRef.current?.querySelector<HTMLElement>(
      `[data-ease-segment-pct="${expandedKfPct}"]`,
    );
    segment?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    pendingAutoScrollRef.current = false;
  }, [expandedKfPct]);

  const usedProps = useMemo(
    () => new Set(Object.keys(animation.properties)),
    [animation.properties],
  );
  const availableProps = useMemo(
    () =>
      SUPPORTED_PROPS.filter(
        (p) => !usedProps.has(p) && (animation.method === "set" || !BOOLEAN_PROPS.has(p)),
      ),
    [usedProps, animation.method],
  );

  const usedFromProps = useMemo(
    () => new Set(Object.keys(animation.fromProperties ?? {})),
    [animation.fromProperties],
  );
  const availableFromProps = useMemo(
    () => SUPPORTED_PROPS.filter((p) => !usedFromProps.has(p) && !BOOLEAN_PROPS.has(p)),
    [usedFromProps],
  );

  const commitProperty = useCallback(
    (prop: string, raw: string) => {
      const value = parseNumericOrString(raw);
      onUpdateProperty(animation.id, prop, value);
      onLivePreviewEnd?.();
    },
    [animation.id, onUpdateProperty, onLivePreviewEnd],
  );

  const scrubProperty = useCallback(
    (prop: string, raw: string) => {
      onLivePreview?.(prop, parseNumericOrString(raw));
    },
    [onLivePreview],
  );

  const commitFromProperty = useCallback(
    (prop: string, raw: string) => {
      const value = parseNumericOrString(raw);
      onUpdateFromProperty?.(animation.id, prop, value);
      onLivePreviewEnd?.();
    },
    [animation.id, onUpdateFromProperty, onLivePreviewEnd],
  );

  const commitDuration = useCallback(
    (raw: string) => {
      const num = Number(raw);
      if (Number.isFinite(num) && num >= 0)
        onUpdateMeta(animation.id, { duration: Math.max(0, num) });
    },
    [animation.id, onUpdateMeta],
  );

  const commitPosition = useCallback(
    (raw: string) => {
      const num = Number(raw);
      if (Number.isFinite(num) && num >= 0)
        onUpdateMeta(animation.id, { position: Math.max(0, num) });
    },
    [animation.id, onUpdateMeta],
  );

  const [copied, setCopied] = useState(false);

  const methodLabel = METHOD_LABELS[animation.method] ?? animation.method;
  const easeName =
    (animation.keyframes ? animation.keyframes.easeEach : undefined) ?? animation.ease ?? "none";
  const easeLabel = easeName.startsWith("custom(")
    ? "Custom curve"
    : (EASE_LABELS[easeName] ?? easeName);
  const endTime =
    typeof animation.position === "number"
      ? animation.position + (animation.duration ?? 0)
      : animation.position;

  const summary = useMemo(() => buildTweenSummary(animation), [animation]);
  const setKeys = Object.keys(animation.properties);
  if (
    animation.method === "set" &&
    // `every` is vacuously true on an empty bag — require at least one key so a
    // property-less set doesn't masquerade as a position row.
    (setKeys.includes("x") || setKeys.includes("y")) &&
    setKeys.every((k) => k === "x" || k === "y" || k === "immediateRender")
  )
    return (
      <div className="flex min-h-7 items-center gap-2 rounded-md border border-border-subtle bg-bg-1 px-2">
        <span className="rounded-xs bg-surface-3 px-1.5 text-xs font-medium leading-[18px] text-fg-2">
          Position
        </span>
        <span className="font-mono text-num text-fg-3">
          x: {Math.round(Number(animation.properties.x ?? 0))}, y:{" "}
          {Math.round(Number(animation.properties.y ?? 0))}
        </span>
        <span className="ml-auto text-2xs text-fg-3">drag to move</span>
      </div>
    );

  return (
    <div
      ref={cardRef}
      data-flat-effect-card={flat ? "true" : undefined}
      className={`grid min-w-0 gap-1.5 rounded-md border bg-bg-1 p-2 ${
        expanded ? "border-border-strong" : "border-border"
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="-m-1 flex min-w-0 items-center gap-1.5 rounded-sm p-1 text-left transition-colors hover:bg-surface-1 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent"
      >
        <span
          className="shrink-0 rounded-xs bg-surface-3 px-1.5 text-xs font-medium leading-[18px] text-fg"
          title={METHOD_TOOLTIPS[animation.method]}
        >
          {methodLabel}
        </span>
        <span
          className="min-w-0 truncate font-mono text-num text-fg-2"
          title="When this effect plays"
        >
          {typeof animation.position === "number"
            ? `${parseFloat(animation.position.toFixed(3))}s`
            : animation.position}{" "}
          – {typeof endTime === "number" ? `${parseFloat(endTime.toFixed(3))}s` : endTime}
        </span>
        <span className="ml-auto min-w-0 truncate text-xs text-fg-3" title={easeName}>
          {easeLabel}
        </span>
        <CaretDown
          size={12}
          aria-hidden="true"
          className={`shrink-0 text-fg-3 transition-transform ${expanded ? "" : "-rotate-90"}`}
        />
      </button>

      {expanded && (
        <div className="border-t border-border-subtle pt-2">
          <div className="grid gap-2">
            <ComputedTweenNotice
              provenance={animation.provenance}
              onUnroll={onUnroll ? () => onUnroll(animation.id) : undefined}
            />
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <p className="m-0 text-xs leading-[15px] text-fg-2">{summary}</p>
                {animation.keyframes && (
                  <p className="mt-1 text-2xs text-fg-3">
                    <span
                      className="inline-block w-2 h-2 mr-1 align-middle"
                      style={{
                        background: "currentColor",
                        clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
                      }}
                    />
                    Keyframed — click a segment below to edit its curve
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(summary);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="shrink-0 rounded-sm px-1.5 py-0.5 text-2xs font-medium text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg"
                title="Copy description to clipboard — paste into agent prompts"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className={RESPONSIVE_GRID}>
              {animation.method !== "set" && (
                <MetricField
                  label="Length"
                  value={String(Math.max(0, animation.duration ?? 0))}
                  suffix="s"
                  tooltip="How long this effect lasts"
                  onCommit={commitDuration}
                />
              )}
              <MetricField
                label="Starts at"
                value={
                  typeof animation.position === "string"
                    ? animation.position
                    : String(parseFloat(Math.max(0, animation.position).toFixed(3)))
                }
                suffix={typeof animation.position === "number" ? "s" : undefined}
                tooltip="When this effect begins on the timeline"
                onCommit={commitPosition}
              />
            </div>

            {animation.method !== "set" && (
              <>
                {animation.keyframes && onUpdateKeyframeEase ? (
                  <KeyframeEaseList
                    keyframes={animation.keyframes.keyframes}
                    globalEase={animation.keyframes.easeEach ?? animation.ease ?? "none"}
                    expandedPct={expandedKfPct}
                    collidingAnimationTargets={focusedCollidingAnimationTargets}
                    onToggle={(pct) => {
                      setExpandedKfPct(pct);
                      setFocusedCollidingAnimationTargets(undefined);
                    }}
                    onEaseCommit={(pct, ease) => {
                      if (
                        focusedCollidingAnimationTargets &&
                        focusedCollidingAnimationTargets.length > 1 &&
                        onUpdateSegmentEase
                      ) {
                        onUpdateSegmentEase(focusedCollidingAnimationTargets, ease);
                      } else {
                        onUpdateKeyframeEase(animation.id, pct, ease);
                      }
                    }}
                    onApplyAll={
                      onSetAllKeyframeEases
                        ? (ease) => onSetAllKeyframeEases(animation.id, ease)
                        : undefined
                    }
                  />
                ) : (
                  <>
                    <SelectField
                      label="Speed"
                      value={easeName.startsWith("custom(") ? "custom" : easeName}
                      options={[...SUPPORTED_EASES, "custom"]}
                      onChange={(next) => {
                        const easeKey = animation.keyframes ? "easeEach" : "ease";
                        if (next === "custom") {
                          const points = controlPointsForGsapEase(
                            easeName !== "none" ? easeName : "power2.out",
                          );
                          const path = `M0,0 C${points.x1},${points.y1} ${points.x2},${points.y2} 1,1`;
                          onUpdateMeta(animation.id, { [easeKey]: `custom(${path})` });
                        } else {
                          onUpdateMeta(animation.id, { [easeKey]: next });
                        }
                      }}
                    />
                    <EaseCurveSection
                      ease={easeName}
                      onCustomEaseCommit={(customEase) => {
                        const easeKey = animation.keyframes ? "easeEach" : "ease";
                        onUpdateMeta(animation.id, { [easeKey]: customEase });
                      }}
                    />
                  </>
                )}
              </>
            )}

            {animation.method === "fromTo" && (
              <div className="grid gap-1">
                <p className={`m-0 ${INSP_MINI_LABEL}`}>From</p>
                <div className="grid gap-1.5">
                  {Object.entries(animation.fromProperties ?? {}).map(([prop, val]) => (
                    <PropertyRow
                      key={prop}
                      prop={prop}
                      val={val}
                      onCommit={(adjusted) => commitFromProperty(prop, adjusted)}
                      onRemove={() => onRemoveFromProperty?.(animation.id, prop)}
                      removeTitle={`Remove from-${PROP_LABELS[prop] ?? prop}`}
                    />
                  ))}
                </div>
                <div className="pt-0.5">
                  <AddPropertyTrigger
                    adding={addingFromProp}
                    available={availableFromProps}
                    addLabel="+ From property"
                    addTitle="Add a from-state property"
                    onAdd={(prop) => onAddFromProperty?.(animation.id, prop)}
                    onOpen={() => setAddingFromProp(true)}
                    onClose={() => setAddingFromProp(false)}
                    buttonClassName="text-sm font-medium text-fg-2 transition-colors hover:text-fg"
                  />
                </div>
              </div>
            )}

            {animation.method === "fromTo" && Object.keys(animation.properties).length > 0 && (
              <p className={`m-0 ${INSP_MINI_LABEL}`}>To</p>
            )}

            {Object.keys(animation.properties).length > 0 && (
              <div className="grid gap-1.5">
                {Object.entries(animation.properties).map(([prop, val]) => (
                  <PropertyRow
                    key={prop}
                    prop={prop}
                    val={val}
                    onCommit={(adjusted) => {
                      scrubProperty(prop, adjusted);
                      commitProperty(prop, adjusted);
                    }}
                    onRemove={() => onRemoveProperty(animation.id, prop)}
                    removeTitle={`Remove ${PROP_LABELS[prop] ?? prop}`}
                  />
                ))}
              </div>
            )}

            {onSetArcPath &&
              (animation.properties.x != null ||
                animation.properties.y != null ||
                animation.keyframes) && (
                <div className="border-t border-border-subtle pt-2">
                  <ArcPathControls
                    arcPath={
                      animation.arcPath ?? { enabled: false, autoRotate: false, segments: [] }
                    }
                    segmentCount={Math.max(
                      animation.properties.x != null || animation.properties.y != null ? 1 : 0,
                      (animation.keyframes?.keyframes?.length ?? 0) - 1,
                    )}
                    onToggle={(enabled) =>
                      onSetArcPath(animation.id, {
                        enabled,
                        segments: animation.arcPath?.segments,
                      })
                    }
                    onUpdateSegment={(index, update) =>
                      onUpdateArcSegment?.(animation.id, index, update)
                    }
                    onToggleAutoRotate={(autoRotate) =>
                      onSetArcPath(animation.id, {
                        enabled: true,
                        autoRotate,
                        segments: animation.arcPath?.segments,
                      })
                    }
                  />
                </div>
              )}

            <div className="flex items-center gap-2 pt-0.5">
              <AddPropertyTrigger
                adding={addingProp}
                available={availableProps}
                addLabel="+ Effect"
                addTitle="Add another animated property to this effect"
                onAdd={(prop) => onAddProperty(animation.id, prop)}
                onOpen={() => setAddingProp(true)}
                onClose={() => setAddingProp(false)}
                buttonClassName="text-sm font-medium text-fg-2 transition-colors hover:text-fg"
              />
              <button
                type="button"
                onClick={() => onDeleteAnimation(animation.id)}
                className="ml-auto rounded-sm px-1.5 text-sm font-medium text-error transition-colors hover:bg-error-soft"
                title="Remove this animation"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
