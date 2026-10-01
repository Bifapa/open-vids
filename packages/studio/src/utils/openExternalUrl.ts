/**
 * The address as an `https:` URL, or null for anything else (another scheme, a relative or malformed string).
 * Text from the agent runtime is untrusted: only an address this accepts is ever shown as a link or opened.
 */
export function parseHttpsUrl(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Opens an https address outside Studio the way Studio opens every external page (source homepages and licence
 * links use `target="_blank"`; this is the same request made from code). Returns false, opening nothing, for any
 * address that is not https. `noopener` means the browser gives no handle back, so a true return says the request
 * was made, not that a window appeared.
 */
export function openExternalUrl(raw: string | null): boolean {
  const url = parseHttpsUrl(raw);
  if (!url) return false;
  window.open(url.href, "_blank", "noopener,noreferrer");
  return true;
}
