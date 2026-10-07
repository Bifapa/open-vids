import type { Direction } from "dockview-react";
import { isBetaFeatureEnabled, type BetaFeatureId } from "../../betaFeatures";
import type { TranslationKey } from "../../i18n";

export const PANEL_IDS = [
  "media",
  "preview",
  "story",
  "timeline",
  "chat",
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
  "voiceover",
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
  /** Only on a build with this beta feature on: otherwise the panel is not offered in the Window menu. */
  beta?: BetaFeatureId;
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
    reopen: { near: "preview", direction: "left" },
  },
  code: {
    title: "shell.dock.panel.code",
    zone: "left",
    reopen: { near: "preview", direction: "left" },
  },
  catalog: {
    title: "shell.dock.panel.catalog",
    zone: "left",
    reopen: { near: "preview", direction: "left" },
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
  /**
   * Beta. Not in the default layout: Window > Voiceover, the Media library's Voice group and the voice clip's
   * inspector open it. It is the project's script (a long list of lines with takes), the counterpart of the
   * inspector for the whole voiceover, so it sits as a tab beside Design in the right column.
   */
  voiceover: {
    title: "shell.dock.panel.voiceover",
    zone: "right",
    reopen: { near: "design", direction: "within" },
    beta: "voiceover",
  },
  chat: {
    title: "shell.dock.panel.chat",
    zone: "left",
    reopen: { near: "preview", direction: "left" },
    keepMounted: true,
  },
} as const satisfies Record<PanelId, PanelDefinition>;

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && (PANEL_IDS as readonly string[]).includes(value);
}

/** Whether the panel is offered on this build: a beta panel only with its feature on. */
export function isPanelAvailable(id: PanelId): boolean {
  const definition: PanelDefinition = PANEL_DEFINITIONS[id];
  return definition.beta === undefined || isBetaFeatureEnabled(definition.beta);
}

export function panelsInZone(zone: PanelZone): PanelId[] {
  return PANEL_IDS.filter((id) => PANEL_DEFINITIONS[id].zone === zone);
}
