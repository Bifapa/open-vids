import { useDockLayoutStore } from "../components/dock/dockLayoutStore";

/**
 * Brings the Voiceover tab up. The tab lives in the Edit workspace's dock, which the Media workspace hides (and Story
 * replaces), so the workspace goes back to Edit first and the tab is shown after it.
 */
export function openVoiceoverTab(): void {
  const dock = useDockLayoutStore.getState();
  dock.setWorkspace("edit");
  dock.activatePanel("voiceover");
}
