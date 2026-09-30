import type { SourceConnector } from "@hyperframes/agent-protocol";
import type { AssetConnector } from "../types.js";
import { archiveConnector } from "./archive.js";
import { commonsConnector } from "./commons.js";
import { nasaConnector } from "./nasa.js";
import { openverseConnector } from "./openverse.js";
import { siteConnector } from "./site.js";

const CONNECTORS: Record<SourceConnector, AssetConnector> = {
  wikimedia_commons: commonsConnector,
  openverse: openverseConnector,
  nasa_images: nasaConnector,
  internet_archive: archiveConnector,
  site: siteConnector,
};

/** The connector that searches a source (`site` for a user's website). */
export function connectorFor(connector: SourceConnector): AssetConnector {
  return CONNECTORS[connector];
}
