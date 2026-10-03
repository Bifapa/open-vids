import { useEffect } from "react";
import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { isPanelId, type PanelId } from "../components/dock/panelRegistry";

const storageKey = (projectId: string) => `openvids.media.hiddenGroups.${projectId}`;

function readHidden(projectId: string): PanelId[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(projectId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isPanelId) : [];
  } catch {
    return [];
  }
}

function writeHidden(projectId: string, ids: readonly PanelId[]) {
  try {
    if (ids.length) localStorage.setItem(storageKey(projectId), JSON.stringify(ids));
    else localStorage.removeItem(storageKey(projectId));
  } catch {
    /* storage unavailable: the groups just stay as they are on the next launch */
  }
}

/**
 * The Media workspace takes the whole window, like the prototype: while the Media panel is the centre's visible tab,
 * every other dock group (timeline, side columns) is hidden, and exactly those groups come back when another
 * workspace takes the centre. What was hidden is remembered per project, so a relaunch inside Media still restores
 * the Edit layout. Groups the user re-shows or hides meanwhile are theirs: only what this hid is restored.
 */
export function MediaWorkspaceLayout({ projectId }: { projectId: string }) {
  const mediaShown = useDockLayoutStore((state) => state.visiblePanels.has("media"));
  const inStory = useDockLayoutStore((state) => state.arrangement === "story");
  const controller = useDockLayoutStore((state) => state.controller);
  useEffect(() => {
    // Story arranges the dock itself and keeps Edit's groups (and the hidden list) for the way back.
    if (!controller || inStory) return;
    if (mediaShown) {
      const { visiblePanels } = useDockLayoutStore.getState();
      const hide = [...visiblePanels].filter((id) => id !== "media");
      for (const id of hide) controller.setGroupVisible(id, false);
      writeHidden(projectId, [...new Set([...readHidden(projectId), ...hide])]);
      return;
    }
    const hidden = readHidden(projectId);
    for (const id of hidden) controller.setGroupVisible(id, true);
    if (hidden.length) writeHidden(projectId, []);
  }, [controller, inStory, mediaShown, projectId]);
  return null;
}
