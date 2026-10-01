import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import type { PanelId } from "../components/dock/panelRegistry";
import { useTranslation, type TranslationKey } from "../i18n";
import { SegmentedControl } from "../components/ui";
import { takeOpenvidsWorkspaceParam } from "../utils/openvidsHost";

export type Workspace = "media" | "story" | "edit";

/** Each workspace is the centre panel it brings to the front; prototype order. */
export const WORKSPACE_PANELS = {
  media: "media",
  story: "story",
  edit: "preview",
} as const satisfies Record<Workspace, PanelId>;

const OPTIONS = [
  { value: "media", label: "story.workspace.media", title: "story.workspace.mediaTitle" },
  { value: "story", label: "story.workspace.story", title: "story.workspace.storyTitle" },
  { value: "edit", label: "story.workspace.edit", title: "story.workspace.editTitle" },
] as const satisfies readonly { value: Workspace; label: TranslationKey; title: TranslationKey }[];

export function isWorkspace(value: unknown): value is Workspace {
  return value === "media" || value === "story" || value === "edit";
}

/**
 * Opens the workspace the desktop asked for with `openvidsWorkspace` (a new project, a start from
 * chat). Before the dock mounts the store keeps it as the pending activation.
 */
export function applyBootWorkspace(): void {
  const requested = takeOpenvidsWorkspaceParam();
  if (isWorkspace(requested)) {
    useDockLayoutStore.getState().activatePanel(WORKSPACE_PANELS[requested]);
  }
}

/** The workspace whose centre panel is showing; Edit when neither Media nor Story is. */
export function useCurrentWorkspace(): Workspace {
  return useDockLayoutStore((state) =>
    state.visiblePanels.has("media")
      ? "media"
      : state.visiblePanels.has("story")
        ? "story"
        : "edit",
  );
}

/**
 * Media | Story | Edit in the titlebar: brings the Media library, the Story canvas or the preview to
 * the front of the centre dock. Everything else (Chat, the library, the inspector) stays where it is.
 */
export function WorkspaceSwitch({ className }: { className?: string }) {
  const { t } = useTranslation();
  const current = useCurrentWorkspace();
  const activatePanel = useDockLayoutStore((state) => state.activatePanel);
  return (
    <SegmentedControl
      label={t("story.workspace.label")}
      value={current}
      options={OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.label),
        title: t(option.title),
      }))}
      onChange={(next) => activatePanel(WORKSPACE_PANELS[next])}
      className={className}
    />
  );
}
