import { ArrowsClockwise, Layout } from "@phosphor-icons/react";
import { Fragment } from "react";
import { useTranslation } from "../../i18n";
import { IconButton, Menu, MenuCheckboxItem, MenuItem, MenuSeparator, Tooltip } from "../ui";
import { useDockLayoutStore } from "./dockLayoutStore";
import { PANEL_DEFINITIONS, panelsInZone, type PanelZone } from "./panelRegistry";

/** The prototype's order: the left column, the centre, the right column. */
const ZONES: readonly PanelZone[] = ["left", "center", "right"];

/** Window: every panel as an open/closed check, grouped by column, then Reset Layout. */
export function DockWindowMenu() {
  const { t } = useTranslation();
  const openPanels = useDockLayoutStore((state) => state.openPanels);
  const togglePanel = useDockLayoutStore((state) => state.togglePanel);
  const resetLayout = useDockLayoutStore((state) => state.resetLayout);
  return (
    <Tooltip label={t("shell.dock.window")} side="bottom">
      <Menu
        align="end"
        aria-label={t("shell.dock.window")}
        trigger={<IconButton aria-label={t("shell.dock.window")} icon={<Layout size={14} />} />}
      >
        {ZONES.map((zone) => (
          <Fragment key={zone}>
            {panelsInZone(zone).map((id) => (
              <MenuCheckboxItem
                key={id}
                checked={openPanels.has(id)}
                onCheckedChange={() => togglePanel(id)}
              >
                {t(PANEL_DEFINITIONS[id].title)}
              </MenuCheckboxItem>
            ))}
            <MenuSeparator />
          </Fragment>
        ))}
        <MenuItem onClick={resetLayout}>
          <span className="flex items-center gap-2">
            <ArrowsClockwise size={14} aria-hidden />
            {t("shell.dock.resetLayout")}
          </span>
        </MenuItem>
      </Menu>
    </Tooltip>
  );
}
