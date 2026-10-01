import { useCallback } from "react";
import type { DomEditSelection } from "../components/editor/domEditingTypes";
import type { SafeGsapCommitMutation } from "./gsapScriptCommitTypes";
import { t } from "../i18n";

export function useGsapArcPathOps(commitMutationSafely: SafeGsapCommitMutation) {
  const setArcPath = useCallback(
    (
      selection: DomEditSelection,
      animationId: string,
      config: {
        enabled: boolean;
        autoRotate?: boolean | number;
        segments?: Array<{
          curviness: number;
          cp1?: { x: number; y: number };
          cp2?: { x: number; y: number };
        }>;
      },
    ) => {
      commitMutationSafely(
        selection,
        { type: "set-arc-path" as const, animationId, ...config },
        {
          label: t(
            config.enabled ? "animation.history.enableArcPath" : "animation.history.disableArcPath",
          ),
          softReload: true,
        },
      );
    },
    [commitMutationSafely],
  );

  const updateArcSegment = useCallback(
    (
      selection: DomEditSelection,
      animationId: string,
      segmentIndex: number,
      update: {
        curviness?: number;
        cp1?: { x: number; y: number };
        cp2?: { x: number; y: number };
      },
    ) => {
      commitMutationSafely(
        selection,
        { type: "update-arc-segment" as const, animationId, segmentIndex, ...update },
        { label: t("animation.history.updateArcSegment"), softReload: true },
      );
    },
    [commitMutationSafely],
  );

  const removeArcPath = useCallback(
    (selection: DomEditSelection, animationId: string) => {
      commitMutationSafely(
        selection,
        { type: "remove-arc-path" as const, animationId },
        { label: t("animation.history.removeArcPath"), softReload: true },
      );
    },
    [commitMutationSafely],
  );

  return { setArcPath, updateArcSegment, removeArcPath };
}
