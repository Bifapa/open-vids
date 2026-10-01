import { useCallback, useSyncExternalStore } from "react";
import { X } from "@phosphor-icons/react";
import type { IDockviewPanelHeaderProps } from "dockview-react";

/** Centre panels the titlebar's Media | Story | Edit switch brings forward; dock.css hides them while not shown. */
const WORKSPACE_PANELS: Record<string, true> = { preview: true, media: true, story: true };

/**
 * A dock tab: the panel's name, the prototype's text tab. The close glyph shows on the shown tab's
 * hover, keyed on dockview's own tab class so it swaps in the frame the tab changes.
 */
export function DockTab({ api }: IDockviewPanelHeaderProps) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = api.onDidTitleChange(onChange);
      return () => subscription.dispose();
    },
    [api],
  );
  const title = useSyncExternalStore(subscribe, () => api.title ?? "");
  return (
    <div className="hf-dock-tab" data-workspace={WORKSPACE_PANELS[api.id] || undefined}>
      <span className="hf-dock-tab-label">{title}</span>
      {/* Same shape as dockview's own close control: a tab cannot hold a focusable button. */}
      <div
        role="button"
        tabIndex={-1}
        aria-label={`Close ${title}`}
        className="hf-dock-tab-close"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          api.close();
        }}
      >
        <X size={10} aria-hidden />
      </div>
    </div>
  );
}
