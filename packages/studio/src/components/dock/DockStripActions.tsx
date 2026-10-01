import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { ArrowsClockwise, CornersIn, CornersOut, DotsThree, X } from "@phosphor-icons/react";
import type { IDockviewHeaderActionsProps } from "dockview-react";
import { useTranslation } from "../../i18n";
import { PreviewHeadTools } from "../nle/PreviewHeadTools";
import { IconButton, Menu, MenuCheckboxItem, MenuItem, MenuSeparator } from "../ui";
import { useDockLayoutStore } from "./dockLayoutStore";
import { PANEL_DEFINITIONS, isPanelId, panelsInZone } from "./panelRegistry";

/** A menu row with the prototype's leading glyph. */
function Row({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-2">
      {icon}
      {label}
    </span>
  );
}

/**
 * The right end of every panel head: the Viewer's tools while the preview is the shown tab, then the
 * prototype's "Panel options" menu (the column's panels, Maximize / Restore, Close, Reset Layout). A
 * maximised group also keeps a Restore button in view, so the way back is never inside a menu only.
 */
export function DockStripActions({
  api,
  containerApi,
  panels,
  activePanel,
}: IDockviewHeaderActionsProps) {
  const { t } = useTranslation();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscription = containerApi.onDidMaximizedGroupChange(onChange);
      return () => subscription.dispose();
    },
    [containerApi],
  );
  const maximized = useSyncExternalStore(subscribe, () => api.isMaximized());
  const openPanels = useDockLayoutStore((state) => state.openPanels);
  const togglePanel = useDockLayoutStore((state) => state.togglePanel);
  const resetLayout = useDockLayoutStore((state) => state.resetLayout);

  const first = panels.find((panel) => isPanelId(panel.id))?.id;
  const menuPanels = isPanelId(first) ? panelsInZone(PANEL_DEFINITIONS[first].zone) : [];
  const toggleMaximized = () => (maximized ? api.exitMaximized() : api.maximize());
  return (
    <div className="hf-dock-strip-actions">
      {activePanel?.id === "preview" ? (
        <div className="flex min-w-0 items-center">
          <PreviewHeadTools />
        </div>
      ) : null}
      {maximized ? (
        <IconButton
          size="sm"
          aria-label={t("shell.dock.restoreLabel")}
          icon={<CornersIn size={14} />}
          onClick={toggleMaximized}
        />
      ) : null}
      <Menu
        align="end"
        aria-label={t("shell.dock.panelOptions")}
        trigger={
          <IconButton
            size="sm"
            aria-label={t("shell.dock.panelOptions")}
            icon={<DotsThree size={16} />}
          />
        }
      >
        {menuPanels.map((id) => (
          <MenuCheckboxItem
            key={id}
            checked={openPanels.has(id)}
            onCheckedChange={() => togglePanel(id)}
          >
            {t(PANEL_DEFINITIONS[id].title)}
          </MenuCheckboxItem>
        ))}
        {menuPanels.length > 0 ? <MenuSeparator /> : null}
        <MenuItem onClick={toggleMaximized}>
          <Row
            icon={
              maximized ? <CornersIn size={14} aria-hidden /> : <CornersOut size={14} aria-hidden />
            }
            label={maximized ? t("shell.dock.restorePanel") : t("shell.dock.maximizePanel")}
          />
        </MenuItem>
        <MenuItem onClick={() => api.close()}>
          <Row icon={<X size={14} aria-hidden />} label={t("shell.dock.closePanel")} />
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={resetLayout}>
          <Row
            icon={<ArrowsClockwise size={14} aria-hidden />}
            label={t("shell.dock.resetLayout")}
          />
        </MenuItem>
      </Menu>
    </div>
  );
}
