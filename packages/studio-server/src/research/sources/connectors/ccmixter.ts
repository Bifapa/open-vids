import { isRecord, normalizeLicense } from "@hyperframes/agent-protocol";
import { ResearchFailure } from "../../errors.js";
import { clip } from "../htmlText.js";
import type { AssetConnector, RawCandidate } from "../types.js";

const API_URL = "https://ccmixter.org/api/query";
/** Above this the server answers 200 with an empty body. */
const MAX_RESULTS = 20;
/** Searches are not narrowed by license, so a few extra uploads make room for the reusable ones. */
const OVERFETCH = 3;
const MAX_DESCRIPTION_CHARS = 500;
const LICENSE_BASIS = "ccMixter API (license_url)";

type Rec = Record<string, unknown>;

function str(rec: Rec, key: string): string | null {
  const value = rec[key];
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text || null;
}

function httpUrl(rec: Rec, key: string): string | null {
  const value = str(rec, key);
  return value && /^https?:\/\//i.test(value) ? value : null;
}

/** ccMixter writes track lengths as "3:58" (or "1:02:03"). */
function secondsOf(text: string | null): number | null {
  if (!text) return null;
  const parts = text.split(":").map(Number);
  if (parts.length > 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? seconds : null;
}

/**
 * The MP3 to download. An upload lists its mix first, then stems (a cappellas, samples) tagged with `file_extra.type`
 * and often other formats; the mix wins, a stem is the fallback.
 */
function pickMp3(files: unknown[]): { file: Rec; isStem: boolean } | null {
  const mp3s = files.filter(isRecord).filter((file) => {
    const info = file.file_format_info;
    return isRecord(info) && info["default-ext"] === "mp3" && httpUrl(file, "download_url");
  });
  const isStem = (file: Rec): boolean =>
    isRecord(file.file_extra) && Boolean(str(file.file_extra, "type"));
  const mix = mp3s.find((file) => !isStem(file));
  const file = mix ?? mp3s[0];
  return file ? { file, isStem: !mix } : null;
}

function toCandidate(upload: Rec): RawCandidate | null {
  if (isRecord(upload.upload_extra) && upload.upload_extra.nsfw === true) return null;
  const files = Array.isArray(upload.files) ? upload.files : [];
  const picked = pickMp3(files);
  const mediaUrl = picked && httpUrl(picked.file, "download_url");
  if (!picked || !mediaUrl) return null;

  const info = isRecord(picked.file.file_format_info) ? picked.file.file_format_info : {};
  const size = picked.file.file_rawsize;
  const stemName = picked.isStem ? str(picked.file, "file_nicname") : null;
  const title = str(upload, "upload_name") ?? "Untitled";
  const licenseUrl = httpUrl(upload, "license_url");
  const licenseName = str(upload, "license_name");
  const author = str(upload, "user_real_name") ?? str(upload, "user_name");
  const description = str(upload, "upload_description_plain");
  return {
    mediaKind: "audio",
    title: stemName ? `${title} (${stemName})` : title,
    description: description ? clip(description, MAX_DESCRIPTION_CHARS) : "",
    pageUrl: httpUrl(upload, "file_page_url"),
    mediaUrl,
    previewUrl: null,
    author,
    authorUrl: author ? httpUrl(upload, "artist_page_url") : null,
    // Sampling Plus and the other legacy licenses are not recognized and come out as `other` (restricted).
    license:
      licenseName || licenseUrl
        ? normalizeLicense({
            name: licenseName,
            url: licenseUrl,
            confidence: "high",
            basis: LICENSE_BASIS,
          })
        : normalizeLicense({ confidence: "none", basis: LICENSE_BASIS }),
    width: null,
    height: null,
    duration: secondsOf(str(info, "ps")),
    bytes: typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null,
    contentType: "audio/mpeg",
  };
}

/** ccMixter (audio only): Creative Commons tracks, remixes and stems through its query API. */
export const ccmixterConnector: AssetConnector = {
  id: "ccmixter",

  async search(query, kind, limit, ctx) {
    if (kind !== "audio") return [];
    const wanted = Math.max(1, Math.floor(limit));
    const params = new URLSearchParams({
      f: "json",
      search: query,
      limit: String(Math.min(wanted * OVERFETCH, MAX_RESULTS)),
      sort: "rank",
    });
    const json = await ctx.http.getJson(`${API_URL}?${params.toString()}`);
    if (!Array.isArray(json)) {
      throw new ResearchFailure("provider_error", "ccMixter answered with an unexpected document.");
    }
    const usable: RawCandidate[] = [];
    const restricted: RawCandidate[] = [];
    for (const upload of json) {
      if (!isRecord(upload)) continue;
      const candidate = toCandidate(upload);
      if (!candidate) continue;
      // Rank order is kept inside each group; non-commercial and legacy licenses only fill what is left.
      const reusable =
        candidate.license.status === "clear" || candidate.license.status === "attribution";
      (reusable ? usable : restricted).push(candidate);
    }
    return [...usable, ...restricted].slice(0, wanted);
  },
};
