export const STUDIO_PREVIEW_MARK_META = "hyperframes-studio-preview";
export const STUDIO_PREVIEW_UPCOMING_ATTR = "data-hf-upcoming";
export const STUDIO_PREVIEW_LAZY_ATTR = "data-hf-preview-lazy";

/**
 * Carries the authored `src` of a preview `<video>` that holds no source: the Studio server serves
 * every managed video this way (no `src` at parse, so the browser opens no media player for it) and
 * the runtime's preview media budget (runtime/previewMediaBudget.ts) attaches and releases sources
 * around the playhead. While a video is released its `src` attribute is absent, so everything that
 * reads a clip's source from the live preview document goes through `readPreviewMediaSrc`.
 */
export const STUDIO_PREVIEW_DETACHED_SRC_ATTR = "data-hf-detached-src";

/** A media element's `src`, also while the preview holds no source for it. */
export function readPreviewMediaSrc(el: Element): string | null {
  return el.getAttribute("src") ?? el.getAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR);
}

/** The parts of a DOM element the preview's "managed video" rule reads (any realm, linkedom too). */
export interface PreviewVideoProbe {
  tagName: string;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  querySelector(selectors: string): unknown;
}

/**
 * Whether the preview may hold no source for this `<video>`: the one rule the server (which strips
 * the source at parse) and the runtime (which attaches and releases it) share.
 *
 * - Its window must be authored (`data-duration`): a clip whose length comes from the decoder's
 *   `duration` would change its window, and with it the composition, the moment it held no source.
 * - No `<source>` children: the Studio reads the authored `src` attribute.
 * - No `loop` (wrapping reads the source duration) and no `data-var-src` (variable bindings write
 *   `src` themselves and would attach it behind the budget's back).
 * - `<audio>` is never managed: the Web Audio transport decodes it from its `src`.
 */
export function isPreviewManagedVideo(el: PreviewVideoProbe): boolean {
  if (el.tagName.toUpperCase() !== "VIDEO") return false;
  if (!el.hasAttribute("src") && !el.hasAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR)) return false;
  if (el.hasAttribute("loop") || el.hasAttribute("data-var-src")) return false;
  if (el.querySelector("source") !== null) return false;
  const duration = Number(el.getAttribute("data-duration"));
  return el.getAttribute("data-duration") !== null && Number.isFinite(duration) && duration > 0;
}
