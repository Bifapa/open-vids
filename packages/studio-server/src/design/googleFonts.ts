import { DesignFailure } from "./errors.js";

/** The CSS2 API answers woff2 (and subsets) only to a current browser's user agent. */
export const CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export const FONT_LIMITS = {
  fileBytes: 4 * 1024 * 1024,
  familyFiles: 24,
  familyBytes: 12 * 1024 * 1024,
  cssBytes: 512 * 1024,
  cssTimeoutMs: 10_000,
  fileTimeoutMs: 20_000,
  concurrency: 4,
} as const;

const CSS_HOST = "fonts.googleapis.com";
const FILE_HOST = "fonts.gstatic.com";
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,79}$/;

export interface FontFetchRequest {
  url: string;
  userAgent: string;
  maxBytes: number;
  timeoutMs: number;
}

/** Reads one URL: the whole body, or throws (non-200, too large, timeout, network). Tests inject their own. */
export type FontFetcher = (request: FontFetchRequest) => Promise<Uint8Array>;

/** A downloaded face: one weight and style of one unicode subset, as woff2 bytes. */
export interface GoogleFontFace {
  weight: number;
  style: "normal" | "italic";
  subset: string;
  unicodeRange?: string;
  data: Uint8Array;
}

/** The network fetcher: no redirects (a redirect could leave the allowed hosts), a byte cap and a timeout. */
export const networkFontFetcher: FontFetcher = async ({ url, userAgent, maxBytes, timeoutMs }) => {
  const response = await fetch(url, {
    headers: { "user-agent": userAgent, accept: "text/css,font/woff2,*/*;q=0.1" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error("the file is too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("the file is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

function allowedUrl(url: string, host: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === host && parsed.username === "";
  } catch {
    return false;
  }
}

export function googleFontsCssUrl(family: string, weights: number[], italic: boolean): string {
  const sorted = [...new Set(weights)].sort((a, b) => a - b);
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  const axis = italic
    ? `ital,wght@${[0, 1].flatMap((ital) => sorted.map((weight) => `${ital},${weight}`)).join(";")}`
    : `wght@${sorted.join(";")}`;
  return `https://${CSS_HOST}/css2?family=${name}:${axis}&display=swap`;
}

interface CssFace {
  weight: number;
  style: "normal" | "italic";
  subset: string;
  unicodeRange?: string;
  url: string;
}

/** The `@font-face` blocks of a CSS2 answer; the comment naming a subset (latin, cyrillic…) before a block says which it is. */
function parseFaces(css: string): CssFace[] {
  const faces: CssFace[] = [];
  for (const block of css.matchAll(
    /(?:\/\*\s*([A-Za-z0-9-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g,
  )) {
    const body = block[2] ?? "";
    const url = /url\(\s*['"]?(https:\/\/[^)'"\s]+)['"]?\s*\)/.exec(body)?.[1];
    const weight = Number(/font-weight:\s*(\d{3})/.exec(body)?.[1]);
    const style = /font-style:\s*(normal|italic)/.exec(body)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim();
    if (!url || !Number.isInteger(weight) || (style !== "normal" && style !== "italic")) continue;
    faces.push({
      weight,
      style,
      subset: (block[1] ?? "latin").toLowerCase(),
      ...(range && /^[Uu+0-9A-Fa-f?, -]{1,2000}$/.test(range) && { unicodeRange: range }),
      url,
    });
  }
  return faces;
}

function unavailable(family: string, reason: string): DesignFailure {
  return new DesignFailure(
    "asset_unavailable",
    `Google Fonts could not provide "${family}": ${reason}`,
  );
}

/**
 * Downloads a Google Fonts family as woff2: every subset the CSS2 API returns for the weights (and italics), so a
 * face covers every script the system may meet. The CSS comes from `fonts.googleapis.com`, the files only from
 * `fonts.gstatic.com`; a family over 24 files / 12 MB, a file over 4 MB, a timeout or any failure is
 * `asset_unavailable`. Network access goes through `fetcher`.
 */
export async function fetchGoogleFontFaces(
  family: string,
  weights: number[],
  italic: boolean,
  fetcher: FontFetcher = networkFontFetcher,
): Promise<GoogleFontFace[]> {
  if (!FAMILY.test(family)) throw unavailable(family, "that is not a plain family name");
  const cssUrl = googleFontsCssUrl(family, weights, italic);
  if (!allowedUrl(cssUrl, CSS_HOST)) throw unavailable(family, "the CSS address is not allowed");
  let css: string;
  try {
    css = Buffer.from(
      await fetcher({
        url: cssUrl,
        userAgent: CHROME_USER_AGENT,
        maxBytes: FONT_LIMITS.cssBytes,
        timeoutMs: FONT_LIMITS.cssTimeoutMs,
      }),
    ).toString("utf-8");
  } catch (error) {
    throw unavailable(
      family,
      `${error instanceof Error ? error.message : "the request failed"} (is the family name right, and do these weights${
        italic ? " and italics" : ""
      } exist?)`,
    );
  }
  const faces = parseFaces(css);
  if (faces.length === 0) throw unavailable(family, "the answer holds no font files");
  if (faces.length > FONT_LIMITS.familyFiles)
    throw unavailable(
      family,
      `${faces.length} files exceed the ${FONT_LIMITS.familyFiles}-file limit; ask for fewer weights`,
    );
  for (const face of faces)
    if (!allowedUrl(face.url, FILE_HOST))
      throw unavailable(family, "a font file is not on fonts.gstatic.com");

  const downloads = new Map<string, Promise<Uint8Array>>();
  const download = (url: string): Promise<Uint8Array> => {
    let pending = downloads.get(url);
    if (!pending) {
      pending = fetcher({
        url,
        userAgent: CHROME_USER_AGENT,
        maxBytes: FONT_LIMITS.fileBytes,
        timeoutMs: FONT_LIMITS.fileTimeoutMs,
      });
      downloads.set(url, pending);
    }
    return pending;
  };
  const out: GoogleFontFace[] = [];
  let total = 0;
  try {
    for (let from = 0; from < faces.length; from += FONT_LIMITS.concurrency) {
      const batch = faces.slice(from, from + FONT_LIMITS.concurrency);
      const datas = await Promise.all(batch.map((face) => download(face.url)));
      for (const [index, face] of batch.entries()) {
        const data = datas[index];
        if (!data) continue;
        total += data.byteLength;
        if (total > FONT_LIMITS.familyBytes)
          throw unavailable(family, "the files exceed the 12 MB limit; ask for fewer weights");
        if (
          data.byteLength > FONT_LIMITS.fileBytes ||
          Buffer.from(data.subarray(0, 4)).toString("latin1") !== "wOF2"
        )
          throw unavailable(family, "a downloaded file is not a woff2 font");
        out.push({
          weight: face.weight,
          style: face.style,
          subset: face.subset,
          ...(face.unicodeRange && { unicodeRange: face.unicodeRange }),
          data,
        });
      }
    }
  } catch (error) {
    if (error instanceof DesignFailure) throw error;
    throw unavailable(family, error instanceof Error ? error.message : "a download failed");
  }
  return out;
}
