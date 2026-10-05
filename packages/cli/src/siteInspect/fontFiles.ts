/**
 * The file name a captured font is saved under. The name comes from the font's URL when that ends in a font
 * extension, otherwise from the face (family and weight); either way it is unique within the run, because two
 * faces served as `/a/Brand.woff2` and `/b/Brand.woff2` must not end up in one file.
 */

/** The last path segment of a URL, percent-decoded when it decodes (a lone `%` stays as written). */
function lastSegment(url: string): string {
  const raw = new URL(url).pathname.split("/").at(-1) ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** A name for the face itself, for fonts whose URL says nothing usable. */
export function faceName(family: string, weight: number, style: "normal" | "italic"): string {
  const base = `${family}-${weight}${style === "italic" ? "-italic" : ""}`;
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

/**
 * `taken` holds the names already handed out (lower case, since the output folder may be case-insensitive); the
 * returned name is added to it.
 */
export function fontFileName(
  url: string,
  mimeType: string,
  fallback: string,
  taken: Set<string>,
): string {
  const cleaned = lastSegment(url)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "");
  const named = /\.(woff2|woff|ttf|otf)$/i.test(cleaned);
  const name = named ? cleaned : `${fallback}.${mimeType.replace("font/", "")}`;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix++) {
    candidate = `${stem}-${suffix}${extension}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}
