import { memo } from "react";
import type { GsapAnimation } from "@hyperframes/core/gsap-parser";
import { Film } from "../../icons/SystemIcons";
import { useTranslation } from "../../i18n";
import { Section } from "./propertyPanelPrimitives";
import type { GsapAnimationEditCallbacks } from "./gsapAnimationCallbacks";
import { GsapAnimationList } from "./GsapAnimationList";

interface GsapAnimationSectionProps extends GsapAnimationEditCallbacks {
  elementId: string;
  animations: GsapAnimation[];
  multipleTimelines?: boolean;
  unsupportedTimelinePattern?: boolean;
  onAddAnimation: (method: "to" | "from" | "set" | "fromTo") => void;
}

export const GsapAnimationSection = memo(function GsapAnimationSection({
  elementId,
  animations,
  multipleTimelines,
  unsupportedTimelinePattern,
  onAddAnimation,
  ...callbacks
}: GsapAnimationSectionProps) {
  const { t } = useTranslation();
  return (
    <Section title={t("editor.animation.section")} icon={<Film size={15} />}>
      {multipleTimelines && (
        <p className="mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm leading-relaxed text-amber-400">
          {t("editor.animation.multipleTimelines")}
        </p>
      )}
      {unsupportedTimelinePattern && (
        <p className="mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm leading-relaxed text-amber-400">
          {t("editor.animation.unsupportedPattern")}
        </p>
      )}
      {multipleTimelines || unsupportedTimelinePattern ? null : (
        <GsapAnimationList
          {...callbacks}
          elementId={elementId}
          animations={animations}
          onAddAnimation={onAddAnimation}
          variant="classic"
        />
      )}
    </Section>
  );
});
