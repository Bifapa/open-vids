import { create } from "zustand";
import { WORKSPACE_PANELS, isStoryPanel, type Arrangement, type Workspace } from "./dockWorkspace";
import {
  PANEL_DEFINITIONS,
  PANEL_IDS,
  panelsInZone,
  type PanelId,
  type PanelZone,
} from "./panelRegistry";

/** The narrow surface Dock.Root exposes; dockview types never leave the dock folder. */
export interface DockController {
  /** Adds the panel at its default place if it is closed; never moves focus. */
  open: (id: PanelId) => void;
  /** Focuses the panel, reopening it at its default place if it was closed. */
  activate: (id: PanelId) => void;
  setTitle: (id: PanelId, title: string) => void;
  close: (id: PanelId) => void;
  /** Hides or shows the panel's whole tab group without closing it. */
  setGroupVisible: (id: PanelId, visible: boolean) => void;
  /** Moves into the Story arrangement (a no-op if already there); Edit's layout is remembered. */
  enterStory: () => void;
  /** Moves back to the Edit layout (a no-op if already there). */
  leaveStory: () => void;
  reset: () => void;
}

export interface DockSnapshot {
  /** The dock's arrangement; in Story only the Story panels count as open. */
  arrangement: Arrangement;
  openPanels: ReadonlySet<PanelId>;
  /** Open panels whose tab is showing and whose group is not hidden. */
  visiblePanels: ReadonlySet<PanelId>;
  activePanel: PanelId | null;
  /** The tab each group shows, so a restored layout still records what every side column last showed. */
  groupActivePanels?: readonly PanelId[];
}

type LastActive = Partial<Record<PanelZone, PanelId>>;

interface DockLayoutState extends DockSnapshot {
  controller: DockController | null;
  lastActive: LastActive;
  /** A workspace requested before the dock mounted; Dock.Root applies it on ready. */
  pendingWorkspace: Workspace | null;
  /** An activation requested before the dock mounted; Dock.Root applies it on ready. */
  pendingActivation: PanelId | null;
  attach: (controller: DockController) => void;
  detach: () => void;
  sync: (snapshot: DockSnapshot) => void;
  takePendingActivation: () => PanelId | null;
  takePendingWorkspace: () => Workspace | null;
  /** Media | Story | Edit: leaves Story unless it is the target, then brings that workspace's centre panel forward. */
  setWorkspace: (workspace: Workspace) => void;
  activatePanel: (id: PanelId) => void;
  closePanel: (id: PanelId) => void;
  togglePanel: (id: PanelId) => void;
  setZoneVisible: (zone: PanelZone, visible: boolean) => void;
  /** Hides or shows the whole group holding `id` (the titlebar's Timeline toggle). */
  setGroupVisible: (id: PanelId, visible: boolean) => void;
  resetLayout: () => void;
}

export const useDockLayoutStore = create<DockLayoutState>((set, get) => ({
  controller: null,
  arrangement: "edit",
  openPanels: new Set(PANEL_IDS),
  visiblePanels: new Set(PANEL_IDS),
  activePanel: null,
  lastActive: {},
  pendingActivation: null,
  pendingWorkspace: null,
  attach: (controller) => set({ controller }),
  detach: () => set({ controller: null, lastActive: {}, arrangement: "edit" }),
  sync: (snapshot) =>
    set((state) => {
      const lastActive = { ...state.lastActive };
      for (const id of snapshot.groupActivePanels ?? []) {
        const zone = PANEL_DEFINITIONS[id].zone;
        if (zone !== "center") lastActive[zone] = id;
      }
      const { activePanel } = snapshot;
      if (activePanel) lastActive[PANEL_DEFINITIONS[activePanel].zone] = activePanel;
      return { ...snapshot, lastActive };
    }),
  takePendingActivation: () => {
    const { pendingActivation } = get();
    set({ pendingActivation: null });
    return pendingActivation;
  },
  takePendingWorkspace: () => {
    const { pendingWorkspace } = get();
    set({ pendingWorkspace: null });
    return pendingWorkspace;
  },
  setWorkspace: (workspace) => {
    const { controller, activatePanel } = get();
    if (!controller) {
      set({ pendingWorkspace: workspace });
      return;
    }
    if (workspace !== "story") controller.leaveStory();
    activatePanel(WORKSPACE_PANELS[workspace]);
  },
  activatePanel: (id) => {
    const { controller, arrangement } = get();
    if (!controller) {
      set({ pendingActivation: id });
      return;
    }
    // Story is a layout of its own; the Story panel brings it up, and any other panel asked for by
    // name (the inspector, the timeline) is somewhere Story does not show, so it takes the dock back to Edit.
    if (id === "story") controller.enterStory();
    else if (arrangement === "story" && !isStoryPanel(id)) controller.leaveStory();
    controller.setGroupVisible(id, true);
    controller.activate(id);
  },
  closePanel: (id) => get().controller?.close(id),
  togglePanel: (id) => {
    const { openPanels, activatePanel, closePanel } = get();
    if (openPanels.has(id)) closePanel(id);
    else activatePanel(id);
  },
  setZoneVisible: (zone, visible) => {
    const { controller, openPanels } = get();
    for (const id of panelsInZone(zone)) {
      if (openPanels.has(id)) controller?.setGroupVisible(id, visible);
    }
  },
  setGroupVisible: (id, visible) => {
    const { controller, openPanels } = get();
    if (openPanels.has(id)) controller?.setGroupVisible(id, visible);
  },
  resetLayout: () => get().controller?.reset(),
}));

/** The panel of `zone` the user is looking at: the last one focused if still showing, else any showing. */
export function visiblePanelInZone(
  zone: PanelZone,
  lastActive: LastActive,
  visiblePanels: ReadonlySet<PanelId>,
): PanelId | null {
  const last = lastActive[zone];
  if (last && visiblePanels.has(last)) return last;
  return panelsInZone(zone).find((id) => visiblePanels.has(id)) ?? null;
}
