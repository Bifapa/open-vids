import type { TrustedSource } from "@hyperframes/agent-protocol";

/**
 * The built-in trusted sources, in display order. Each one has a connector that speaks its public API; the domains
 * are what trusted mode allows to be read (the API, the pages and the media files of the source).
 *
 * DUPLICATED in `apps/desktop/src-tauri/src/research_policy.rs` (`BUILT_INS`): the Projects page edits the same
 * policy file without a Studio server. Change both lists together (a Rust test compares ids, names, connectors,
 * homepages and domains).
 */
export const BUILT_IN_SOURCES: readonly TrustedSource[] = [
  {
    id: "wikimedia-commons",
    name: "Wikimedia Commons",
    builtIn: true,
    enabled: true,
    connector: "wikimedia_commons",
    domains: ["commons.wikimedia.org", "upload.wikimedia.org", "wikimedia.org"],
    kinds: ["video", "picture", "audio"],
    description: "Free media files of Wikipedia and its sister projects.",
    licenseNote:
      "Each file carries its own license (public domain, CC0, CC BY, CC BY-SA…); the author and license come from the file's page.",
    homepage: "https://commons.wikimedia.org",
  },
  {
    id: "openverse",
    name: "Openverse",
    builtIn: true,
    enabled: true,
    connector: "openverse",
    domains: ["api.openverse.org", "openverse.org"],
    kinds: ["picture", "audio"],
    description:
      "Openly licensed images and audio gathered from Flickr, Freesound, Wikimedia and other collections.",
    licenseNote:
      "Every result states its Creative Commons license and creator; the files are hosted by the original collection.",
    homepage: "https://openverse.org",
  },
  {
    id: "nasa-images",
    name: "NASA Image and Video Library",
    builtIn: true,
    enabled: true,
    connector: "nasa_images",
    domains: ["images-api.nasa.gov", "images-assets.nasa.gov", "images.nasa.gov"],
    kinds: ["video", "picture", "audio"],
    description: "Images, video and audio from NASA missions.",
    licenseNote:
      "NASA media is generally not copyrighted (public domain), except where the page says otherwise; logos and people's likenesses have their own rules.",
    homepage: "https://images.nasa.gov",
  },
  {
    id: "internet-archive",
    name: "Internet Archive",
    builtIn: true,
    enabled: true,
    connector: "internet_archive",
    domains: ["archive.org"],
    kinds: ["video", "picture", "audio"],
    description: "Public-domain and openly licensed films, recordings and images.",
    licenseNote:
      "Only items with a license field are treated as licensed; everything else is marked unknown.",
    homepage: "https://archive.org",
  },
];

export const BUILT_IN_IDS: readonly string[] = BUILT_IN_SOURCES.map((source) => source.id);
