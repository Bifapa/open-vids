import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { isWorkspace, type Workspace } from "../components/dock/dockWorkspace";
import { useTranslation, type TranslationKey } from "../i18n";
import { SegmentedControl } from "../components/ui";
import { takeOpenvidsWorkspaceParam } from "../utils/openvidsHost";

const OPTIONS = [
  { value: "media", label: "story.workspace.media", title: "story.workspace.mediaTitle" },
  { value: "story", label: "story.workspace.story", title: "story.workspace.storyTitle" },
  { value: "edit", label: "story.workspace.edit", title: "story.workspace.editTitle" },
] as const satisfies readonly { value: Workspace; label: TranslationKey; title: TranslationKey }[];

/**
 * Opens the workspace the desktop asked for with `openvidsWorkspace` (a new project, a start from
 * chat). Before the dock mounts the store keeps it as the pending activation.
 */
export function applyBootWorkspace(): void {
  const requested = takeOpenvidsWorkspaceParam();
  if (isWorkspace(requested)) useDockLayoutStore.getState().setWorkspace(requested);
}

/** The workspace on show: Story while the dock is arranged for it, else Media while its panel shows, else Edit. */
export function useCurrentWorkspace(): Workspace {
  return useDockLayoutStore((state) =>
    state.arrangement === "story" ? "story" : state.visiblePanels.has("media") ? "media" : "edit",
  );
}

/**
 * Media | Story | Edit in the titlebar. Story rearranges the dock (see dockWorkspace.ts) and Edit
 * puts the user's own layout back; Media brings the library to the front of that layout.
 */
export function WorkspaceSwitch({ className }: { className?: string }) {
  const { t } = useTranslation();
  const current = useCurrentWorkspace();
  const setWorkspace = useDockLayoutStore((state) => state.setWorkspace);
  return (
    <SegmentedControl
      label={t("story.workspace.label")}
      value={current}
      options={OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.label),
        title: t(option.title),
      }))}
      onChange={setWorkspace}
      className={className}
    />
  );
}
