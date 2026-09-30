import { useDockLayoutStore } from "../components/dock/dockLayoutStore";
import { cn } from "../components/ui";

const WORKSPACES = [
  { id: "edit", label: "Edit", panel: "preview" },
  { id: "story", label: "Story", panel: "story" },
] as const;

/**
 * Edit | Story in the Studio header: brings the preview or the Story canvas to the front of the centre dock.
 * Everything else (Chat, the library, the inspector) stays where it is.
 */
export function WorkspaceSwitch() {
  const storyShown = useDockLayoutStore((state) => state.visiblePanels.has("story"));
  const activatePanel = useDockLayoutStore((state) => state.activatePanel);
  const current = storyShown ? "story" : "edit";
  return (
    <div
      role="radiogroup"
      aria-label="Workspace"
      className="flex h-ctl items-center gap-0.5 rounded-md border border-border-strong bg-bg-2 p-0.5"
    >
      {WORKSPACES.map((workspace) => {
        const checked = workspace.id === current;
        return (
          <button
            key={workspace.id}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => activatePanel(workspace.panel)}
            className={cn(
              "h-full rounded-sm px-2.5 text-step-11 font-medium outline-hidden transition-colors duration-hover",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
              checked ? "bg-hover text-text-0" : "text-text-3 hover:text-text-1",
            )}
          >
            {workspace.label}
          </button>
        );
      })}
    </div>
  );
}
