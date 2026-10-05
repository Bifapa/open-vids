import type { SourceConnector } from "@hyperframes/agent-protocol";
import type { AssetConnector } from "../types.js";
import { archiveConnector } from "./archive.js";
import { artInstituteChicagoConnector } from "./artInstituteChicago.js";
import { ccmixterConnector } from "./ccmixter.js";
import { clevelandMuseumConnector } from "./clevelandMuseum.js";
import { commonsConnector } from "./commons.js";
import { flickrConnector } from "./flickr.js";
import { freesoundConnector } from "./freesound.js";
import { iconifyConnector } from "./iconify.js";
import { metMuseumConnector } from "./metMuseum.js";
import { nasaConnector } from "./nasa.js";
import { nasaSvsConnector } from "./nasaSvs.js";
import { openverseConnector } from "./openverse.js";
import { pexelsConnector } from "./pexels.js";
import { pixabayConnector } from "./pixabay.js";
import { siteConnector } from "./site.js";
import { smithsonianConnector } from "./smithsonian.js";
import { smkConnector } from "./smk.js";
import { wellcomeCollectionConnector } from "./wellcomeCollection.js";

const CONNECTORS: Record<SourceConnector, AssetConnector> = {
  wikimedia_commons: commonsConnector,
  openverse: openverseConnector,
  nasa_images: nasaConnector,
  internet_archive: archiveConnector,
  nasa_svs: nasaSvsConnector,
  met_museum: metMuseumConnector,
  art_institute_chicago: artInstituteChicagoConnector,
  cleveland_museum: clevelandMuseumConnector,
  smk: smkConnector,
  wellcome_collection: wellcomeCollectionConnector,
  ccmixter: ccmixterConnector,
  iconify: iconifyConnector,
  pexels: pexelsConnector,
  pixabay: pixabayConnector,
  flickr: flickrConnector,
  freesound: freesoundConnector,
  smithsonian: smithsonianConnector,
  site: siteConnector,
};

/** The connector that searches a source (`site` for a user's website). */
export function connectorFor(connector: SourceConnector): AssetConnector {
  return CONNECTORS[connector];
}
