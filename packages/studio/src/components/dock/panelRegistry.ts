import type { Direction } from "dockview-react";
import type { TranslationKey } from "../../i18n";

export const PANEL_IDS = [
  "media",
  "preview",
  "story",
  "timeline",
  "compositions",
  "assets",
  "code",
  "catalog",
  "design",
  "layers",
  "renders",
  "sources",
  "variables",
  "slideshow",
  "chat",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];
export type PanelZone = "left" | "center" | "right";

export interface PanelDefinition {
  /** The panel's name in the tab and the Window menu; translated where it is shown. */
  title: TranslationKey;
  zone: PanelZone;
  /** Where Window > <panel> puts it when it has no saved place: next to `near`. */
  reopen: { near: PanelId; direction: Direction };
  /** Content stays mounted while its tab is hidden (the preview iframe must not reload). */
  keepMounted?: true;
}

export const PANEL_DEFINITIONS = {
  preview: {
    title: "shell.dock.panel.preview",
    zone: "center",
    reopen: { near: "timeline", direction: "above" },
    keepMounted: true,
  },
  /** The Media workspace: the project's media library. While it shows, the other dock groups step aside. */
  media: {
    title: "shell.dock.panel.media",
    zone: "center",
    reopen: { near: "preview", direction: "within" },
  },
  story: {
    title: "shell.dock.panel.story",
    zone: "center",
    reopen: { near: "preview", direction: "within" },
  },
  timeline: {
    title: "shell.dock.panel.timeline",
    zone: "center",
    reopen: { near: "preview", direction: "below" },
    keepMounted: true,
  },
  compositions: {
    title: "shell.dock.panel.compositions",
    zone: "left",
    reopen: { near: "preview", direction: "left" },
  },
  assets: {
    title: "shell.dock.panel.assets",
    zone: "left",
    reopen: { near: "compositions", direction: "within" },
  },
  code: {
    title: "shell.dock.panel.code",
    zone: "left",
    reopen: { near: "compositions", direction: "within" },
  },
  catalog: {
    title: "shell.dock.panel.catalog",
    zone: "left",
    reopen: { near: "compositions", direction: "within" },
  },
  design: {
    title: "shell.dock.panel.design",
    zone: "right",
    reopen: { near: "preview", direction: "right" },
  },
  layers: {
    title: "shell.dock.panel.layers",
    zone: "right",
    reopen: { near: "design", direction: "within" },
  },
  renders: {
    title: "shell.dock.panel.renders",
    zone: "right",
    reopen: { near: "design", direction: "within" },
  },
  /** Not in the default layout: Window > Sources & Licenses, the Story workspace and the export check open it. */
  sources: {
    title: "shell.dock.panel.sources",
    zone: "right",
    reopen: { near: "renders", direction: "within" },
  },
  variables: {
    title: "shell.dock.panel.variables",
    zone: "right",
    reopen: { near: "design", direction: "within" },
  },
  slideshow: {
    title: "shell.dock.panel.slideshow",
    zone: "right",
    reopen: { near: "design", direction: "within" },
  },
  chat: {
    title: "shell.dock.panel.chat",
    zone: "left",
    reopen: { near: "compositions", direction: "within" },
    keepMounted: true,
  },
} as const satisfies Record<PanelId, PanelDefinition>;

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && (PANEL_IDS as readonly string[]).includes(value);
}

export function panelsInZone(zone: PanelZone): PanelId[] {
  return PANEL_IDS.filter((id) => PANEL_DEFINITIONS[id].zone === zone);
}
