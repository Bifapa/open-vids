import { classifyPropertyGroup, type PropertyGroupName } from "@hyperframes/core/gsap-parser";
import { t, type TranslationKey } from "../i18n";

const STATIC_SET_LABELS: Partial<Record<PropertyGroupName, TranslationKey>> = {
  position: "layer.history.move",
  scale: "layer.history.resize",
  size: "layer.history.resize",
  rotation: "layer.history.rotate",
  visual: "layer.history.setOpacity",
  other: "layer.history.set3dTransform",
};

/** Undo-history label for a static-set commit, from the group it writes. */
export function staticSetLabel(propEntries: [string, number | string][]): string {
  const groups = new Set(propEntries.map(([k]) => classifyPropertyGroup(k)));
  const only = groups.size === 1 ? [...groups][0] : undefined;
  return t((only && STATIC_SET_LABELS[only]) || "layer.history.setProperties");
}
