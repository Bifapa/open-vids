import type { NormalizedHfColorGrading } from "@hyperframes/core/color-grading";
import type { ColorGradingPreviewOptions } from "./useColorGradingController";

export function presetPreviewHandlers({
  id,
  label,
  resolve,
  onPreview,
  onCommit,
}: {
  id: string;
  label: string;
  resolve: () => NormalizedHfColorGrading;
  onPreview: (
    grading: NormalizedHfColorGrading | null,
    options?: ColorGradingPreviewOptions,
  ) => void;
  onCommit: (grading: NormalizedHfColorGrading) => void;
}) {
  return {
    title: `Preview ${label}`,
    onPointerEnter: () =>
      onPreview(resolve(), {
        animatedPreview: { kind: "presets" as const, id },
      }),
    onPointerLeave: () => onPreview(null),
    onFocus: () => onPreview(resolve()),
    onBlur: () => onPreview(null),
    onClick: () => {
      onCommit(resolve());
    },
  };
}
