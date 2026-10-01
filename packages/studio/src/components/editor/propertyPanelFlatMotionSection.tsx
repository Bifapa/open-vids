import { scopedElementKey } from "../../hooks/gsapKeyframeCacheHelpers";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import { t as translate, useTranslation } from "../../i18n";
import type { DomEditSelection } from "./domEditing";
import { formatTimingValue } from "./propertyPanelHelpers";
import { parseTimingValue } from "./propertyPanelTimingSection";
import { FlatRow } from "./propertyPanelFlatPrimitives";
import type { GsapAnimationEditCallbacks } from "./gsapAnimationCallbacks";
import { deriveElementTiming } from "./propertyPanelFlatTimingDerivation";
import { GsapAnimationList } from "./GsapAnimationList";

export function FlatTimingRow({
  element,
  animations = [],
  onSetAttribute,
  onSetAttributes,
}: {
  element: DomEditSelection;
  animations?: GsapAnimation[];
  onSetAttribute: (attr: string, value: string) => void | Promise<void>;
  /** Commits start+duration together in ONE atomic persist call, bound to
   *  THIS render's `element` explicitly — not whatever is "currently"
   *  selected by the time the call resolves. Falls back to two sequential
   *  `onSetAttribute` calls (with the same non-atomicity/misdirection risk
   *  documented below) when the caller doesn't wire it up. */
  onSetAttributes?: (selection: DomEditSelection, attrs: Record<string, string>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { start, duration, inferred: derived } = deriveElementTiming(element, animations);
  const end = start + duration;

  // While the range is inferred from animations, editing ONE field must pin the
  // WHOLE displayed range: writing only data-duration flips inference off and
  // drops start to data-start-or-0 (the clip silently shifts), and writing only
  // data-start is ignored while duration is still inferred (the edit looks
  // dead). Pin both attributes in ONE atomic commit bound to THIS element —
  // two sequential `onSetAttribute` calls would each resolve `domEditSelection`
  // fresh from current hook state, so a selection change between the two
  // awaits could misdirect the second write at the newly-selected element, and
  // a failure of just the second call would leave the pair half-applied.
  const pinRange = async (nextStart: number, nextDuration: number) => {
    const attrs = { start: nextStart.toFixed(2), duration: nextDuration.toFixed(2) };
    if (onSetAttributes) {
      await onSetAttributes(element, attrs);
      return;
    }
    await onSetAttribute("start", attrs.start);
    await onSetAttribute("duration", attrs.duration);
  };

  const commitStart = (nextValue: string) => {
    const parsed = parseTimingValue(nextValue);
    if (parsed == null) return;
    if (derived) {
      void pinRange(parsed, duration);
      return;
    }
    void onSetAttribute("start", parsed.toFixed(2));
  };

  const commitDuration = (nextValue: string) => {
    const parsed = parseTimingValue(nextValue);
    if (parsed == null || parsed <= 0) return;
    if (derived) {
      void pinRange(start, parsed);
      return;
    }
    void onSetAttribute("duration", parsed.toFixed(2));
  };

  const commitEnd = (nextValue: string) => {
    const parsed = parseTimingValue(nextValue);
    if (parsed == null || parsed <= start) return;
    if (derived) {
      void pinRange(start, parsed - start);
      return;
    }
    void onSetAttribute("duration", (parsed - start).toFixed(2));
  };

  const row = (label: string, value: string, onCommit: (next: string) => void) => (
    <FlatRow
      label={label}
      value={value}
      tier="explicitDefault"
      onCommit={(next) => {
        onCommit(next);
      }}
    />
  );

  return (
    <div className="grid gap-1.5">
      {row(t("inspector.timing.start"), formatTimingValue(start), commitStart)}
      {row(t("inspector.timing.end"), formatTimingValue(end), commitEnd)}
      {row(t("inspector.timing.duration"), formatTimingValue(duration), commitDuration)}
      {derived && (
        <p className="m-0 text-xs leading-[15px] text-fg-3">{t("inspector.timing.inferred")}</p>
      )}
    </div>
  );
}

export function FlatMotionSection({
  element,
  animations,
  showTiming,
  showEffects,
  multipleTimelines,
  unsupportedTimelinePattern,
  onSetAttribute,
  onSetAttributes,
  onAddAnimation,
  ...callbacks
}: {
  element: DomEditSelection;
  animations: GsapAnimation[];
  showTiming: boolean;
  showEffects: boolean;
  multipleTimelines?: boolean;
  unsupportedTimelinePattern?: boolean;
  onSetAttribute: (attr: string, value: string) => void | Promise<void>;
  onSetAttributes?: (selection: DomEditSelection, attrs: Record<string, string>) => Promise<void>;
  onAddAnimation: (method: "to" | "from" | "set" | "fromTo") => void;
} & GsapAnimationEditCallbacks) {
  const { t } = useTranslation();
  // Only consume a focus request aimed at the element THIS panel renders (not
  // the store's selectedElementId, which flips synchronously during async
  // selection resolution), so a shared class-selector animation id can't open
  // the wrong element's editor.
  const renderedElementId = scopedElementKey(element);

  return (
    <div className="grid gap-2.5">
      {showTiming && (
        <FlatTimingRow
          element={element}
          animations={animations}
          onSetAttribute={onSetAttribute}
          onSetAttributes={onSetAttributes}
        />
      )}
      {showEffects && (
        <>
          {multipleTimelines && (
            <p className="m-0 rounded-sm border border-warning/35 bg-warning-soft px-2 py-1.5 text-xs leading-[15px] text-fg-2">
              {t("inspector.motion.multipleTimelines")}
            </p>
          )}
          {unsupportedTimelinePattern && (
            <p className="m-0 rounded-sm border border-warning/35 bg-warning-soft px-2 py-1.5 text-xs leading-[15px] text-fg-2">
              {t("inspector.motion.unsupportedTimeline")}
            </p>
          )}
          {!multipleTimelines && !unsupportedTimelinePattern && (
            <GsapAnimationList
              {...callbacks}
              elementId={renderedElementId}
              animations={animations}
              onAddAnimation={onAddAnimation}
              variant="flat"
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * What the Motion section is called, and what its collapsed line says.
 *
 * "Motion" names the tween editor. On audio the section is Start/Duration/End
 * and nothing else, so the label would promise what it no longer offers — and
 * "Motion: 0 effects" on a sound is a category error, hence the span instead of
 * a count.
 *
 * Keyed on the TAG by its caller, not on whether the effects half is showing:
 * that half also disappears when a host simply has not wired the GSAP handlers,
 * and a div in that state is still a thing that moves — renaming its section
 * would be describing the host's wiring rather than the element.
 */
export function motionSectionLabel(args: {
  timingOnly: boolean;
  start: number;
  duration: number;
  effectCount: number;
}): { title: string; summary: string } {
  if (args.timingOnly) {
    return {
      title: translate("inspector.group.timing"),
      summary: `${formatTimingValue(args.start)} – ${formatTimingValue(args.start + args.duration)}`,
    };
  }
  return {
    title: translate("inspector.group.motion"),
    summary: translate("inspector.group.motionSummary", { count: args.effectCount }),
  };
}
