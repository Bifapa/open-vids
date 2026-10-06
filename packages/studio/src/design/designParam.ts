import type { DesignSourceKind } from "@hyperframes/agent-protocol";

export const OPENVIDS_DESIGN_PARAM = "openvidsDesign";
export const OPENVIDS_DESIGN_SOURCE_PARAM = "openvidsDesignSource";

/** The sources the Projects page can preselect: the ones that need no other project. */
const PRESELECTABLE_SOURCES = ["scratch", "project", "video", "website"] as const;

/** What the desktop shell asked Studio to open: the create dialog, on a source. */
export interface OpenvidsDesignRequest {
  source: DesignSourceKind;
}

/**
 * Takes the one-shot request the desktop shell adds when the Projects page's "Create design system" opens a project
 * (`openvidsDesign=create`, and optionally `openvidsDesignSource` to preselect the source), and drops both from the
 * address so a reload does not ask again. Null when there is no request; an unknown source falls back to a brief.
 */
export function takeOpenvidsDesignParam(): OpenvidsDesignRequest | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const action = url.searchParams.get(OPENVIDS_DESIGN_PARAM);
  const source = url.searchParams.get(OPENVIDS_DESIGN_SOURCE_PARAM);
  if (action === null && source === null) return null;
  url.searchParams.delete(OPENVIDS_DESIGN_PARAM);
  url.searchParams.delete(OPENVIDS_DESIGN_SOURCE_PARAM);
  window.history.replaceState(window.history.state, "", url);
  if (action !== "create") return null;
  return { source: PRESELECTABLE_SOURCES.find((known) => known === source) ?? "scratch" };
}
