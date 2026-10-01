import { create } from "zustand";
import { readStudioUiPreferences, writeStudioUiPreferences } from "../../utils/studioUiPreferences";

/** Space the preview fit reserves above and left of the frame while the ruler is on. */
export const RULER_GUTTER_PX = 16;

type GuideKey = "rulerVisible" | "safeMarginsVisible";

export interface PreviewSnapPreferences {
  snapEnabled: boolean;
  gridVisible: boolean;
  gridSpacing: number;
  snapToGrid: boolean;
}

interface PreviewGuidesState {
  rulerVisible: boolean;
  safeMarginsVisible: boolean;
  /**
   * Snap and grid preferences. Lives here rather than in the overlay provider so
   * the viewer head (outside the preview pane) and the canvas share one copy.
   */
  snapPrefs: PreviewSnapPreferences;
  toggle: (key: GuideKey) => void;
  setSnapPrefs: (patch: Partial<PreviewSnapPreferences>) => void;
}

function readSnapPrefs(): PreviewSnapPreferences {
  const prefs = readStudioUiPreferences();
  return {
    snapEnabled: prefs.snapEnabled ?? true,
    gridVisible: prefs.gridVisible ?? false,
    gridSpacing: prefs.gridSpacing ?? 50,
    snapToGrid: prefs.snapToGrid ?? false,
  };
}

export const usePreviewGuidesStore = create<PreviewGuidesState>((set, get) => {
  const stored = readStudioUiPreferences();
  return {
    rulerVisible: stored.rulerVisible ?? false,
    safeMarginsVisible: stored.safeMarginsVisible ?? false,
    snapPrefs: readSnapPrefs(),
    toggle: (key) => {
      const next = !get()[key];
      writeStudioUiPreferences({ [key]: next });
      set({ [key]: next });
    },
    setSnapPrefs: (patch) => {
      writeStudioUiPreferences(patch);
      set({ snapPrefs: { ...get().snapPrefs, ...patch } });
    },
  };
});
