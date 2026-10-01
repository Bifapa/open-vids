import { create } from "zustand";

/** The Settings window's sections, in sidebar order. */
export const SETTINGS_SECTIONS = [
  "general",
  "appearance",
  "agents",
  "jev",
  "assets",
  "execution",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

interface SettingsDialogState {
  open: boolean;
  section: SettingsSection;
  /** Element that opened Settings; focus returns to it on close. */
  returnFocus: HTMLElement | null;
  setSection: (section: SettingsSection) => void;
  close: () => void;
}

/** Whether the Settings window is open and which section it shows. */
export const useSettingsDialog = create<SettingsDialogState>((set) => ({
  open: false,
  section: "general",
  returnFocus: null,
  setSection: (section) => set({ section }),
  close: () => set({ open: false }),
}));

/**
 * Opens Settings, on `section` when given (otherwise where the user left it).
 * Focus returns to the element focused at the time of the call when it closes.
 */
export function openSettings(section?: SettingsSection): void {
  const active = typeof document === "undefined" ? null : document.activeElement;
  useSettingsDialog.setState((state) => ({
    open: true,
    section: section ?? state.section,
    returnFocus: active instanceof HTMLElement ? active : null,
  }));
}
