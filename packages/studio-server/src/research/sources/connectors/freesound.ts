import { isRecord, normalizeLicense } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import { clip, htmlToText } from "../htmlText.js";
import type { AssetConnector, RawCandidate } from "../types.js";

const API_URL = "https://freesound.org/apiv2/search/";
const PEOPLE_URL = "https://freesound.org/people";
/** The API serves at most 150 sounds per page. */
const MAX_PAGE_SIZE = 150;
const MAX_DESCRIPTION_CHARS = 500;
const FIELDS = "id,name,description,username,license,previews,images,duration,url";
/** Only reusable sounds are asked for; whatever else comes back is still labelled with its real license. */
const LICENSE_FILTER = 'license:("Creative Commons 0" OR "Attribution")';
const LICENSE_BASIS = "Freesound API (license)";
const PREVIEW = "preview-hq-mp3";

/**
 * The API names licenses in prose ("Attribution") and, in newer answers, by their creativecommons.org URL; the prose
 * has no version, so it is spelled the way the protocol's license names are.
 */
const LICENSE_NAMES: Record<string, string> = {
  "creative commons 0": "CC0",
  attribution: "CC BY",
  "attribution noncommercial": "CC BY-NC",
};

type Rec = Record<string, unknown>;

function str(rec: Rec, key: string): string | null {
  const value = rec[key];
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function httpUrl(rec: Rec, key: string): string | null {
  const value = str(rec, key);
  return value && /^https?:\/\//i.test(value) ? value : null;
}

function licenseOf(value: string | null) {
  if (!value) return normalizeLicense({ confidence: "none", basis: LICENSE_BASIS });
  const isUrl = /^https?:\/\//i.test(value);
  return normalizeLicense({
    name: isUrl ? null : (LICENSE_NAMES[value.toLowerCase()] ?? value),
    url: isUrl ? value : null,
    confidence: "high",
    basis: LICENSE_BASIS,
  });
}

function toCandidate(sound: Rec): RawCandidate | null {
  const previews = isRecord(sound.previews) ? sound.previews : {};
  const mediaUrl = httpUrl(previews, PREVIEW);
  if (!mediaUrl) return null;

  const username = str(sound, "username");
  const duration = sound.duration;
  const images = isRecord(sound.images) ? sound.images : {};
  const description = str(sound, "description");
  const intro = "MP3 preview (128 kbps) of a Freesound sound; the original file is not downloaded.";
  return {
    mediaKind: "audio",
    title: str(sound, "name") ?? "Untitled",
    description: clip(
      description ? `${intro} ${htmlToText(description)}` : intro,
      MAX_DESCRIPTION_CHARS,
    ),
    pageUrl: httpUrl(sound, "url"),
    mediaUrl,
    previewUrl: httpUrl(images, "waveform_m"),
    author: username,
    authorUrl: username ? `${PEOPLE_URL}/${encodeURIComponent(username)}/` : null,
    license: licenseOf(str(sound, "license")),
    width: null,
    height: null,
    duration:
      typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null,
    // `filesize` describes the original upload, not the preview that is downloaded.
    bytes: null,
    contentType: "audio/mpeg",
  };
}

/** Freesound (audio only, needs the user's API key): community sound effects and recordings. */
export const freesoundConnector: AssetConnector = {
  id: "freesound",

  async search(query, kind, limit, ctx) {
    if (kind !== "audio") return [];
    if (!ctx.apiKey) throw new ResearchFailure("invalid_request", "Freesound needs an API key");
    const pageSize = Math.max(1, Math.min(Math.floor(limit), MAX_PAGE_SIZE));
    const params = new URLSearchParams({
      query,
      page_size: String(pageSize),
      fields: FIELDS,
      filter: LICENSE_FILTER,
    });
    const json = await ctx.http.getJson(`${API_URL}?${params.toString()}`, {
      headers: { Authorization: `Token ${ctx.apiKey}` },
    });
    if (!isRecord(json) || !Array.isArray(json.results)) {
      throw new ResearchFailure(
        "provider_error",
        "Freesound answered with an unexpected document.",
      );
    }
    const out: RawCandidate[] = [];
    for (const sound of json.results) {
      if (!isRecord(sound)) continue;
      const candidate = toCandidate(sound);
      if (candidate) out.push(candidate);
      if (out.length >= pageSize) break;
    }
    return out;
  },
};
