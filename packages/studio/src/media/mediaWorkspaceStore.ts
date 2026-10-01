import { create } from "zustand";

export type MediaRightTab = "inspector" | "chat";
export type MediaCenterTab = "media" | "sources";

interface MediaWorkspaceState {
  /** The Media panel's right column: the asset Inspector or the project's Chat. */
  rightTab: MediaRightTab;
  centerTab: MediaCenterTab;
  /** Project-relative path of the asset the Inspector shows. */
  selectedPath: string | null;
  setRightTab: (tab: MediaRightTab) => void;
  setCenterTab: (tab: MediaCenterTab) => void;
  select: (path: string | null) => void;
}

export const useMediaWorkspaceStore = create<MediaWorkspaceState>((set) => ({
  rightTab: "inspector",
  centerTab: "media",
  selectedPath: null,
  setRightTab: (rightTab) => set({ rightTab }),
  setCenterTab: (centerTab) => set({ centerTab }),
  select: (selectedPath) =>
    set((state) => ({
      selectedPath,
      rightTab: selectedPath && state.selectedPath !== selectedPath ? "inspector" : state.rightTab,
    })),
}));

/** Brings the Media workspace's Chat tab forward (the start-from-chat intake lands there). */
export function showMediaChat(): void {
  useMediaWorkspaceStore.setState({ rightTab: "chat" });
}
