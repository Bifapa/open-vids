export const STUDIO_PREVIEW_MARK_META = "hyperframes-studio-preview";
export const STUDIO_PREVIEW_UPCOMING_ATTR = "data-hf-upcoming";
export const STUDIO_PREVIEW_LAZY_ATTR = "data-hf-preview-lazy";

/**
 * Carries the authored `src` of a preview `<video>` whose decoder the runtime released (see
 * runtime/previewMediaBudget.ts). The element itself has no `src` while released, so everything
 * that reads a clip's source from the live preview document goes through `readPreviewMediaSrc`.
 */
export const STUDIO_PREVIEW_DETACHED_SRC_ATTR = "data-hf-detached-src";

/** A media element's `src`, also while the preview has released its decoder. */
export function readPreviewMediaSrc(el: Element): string | null {
  return el.getAttribute("src") ?? el.getAttribute(STUDIO_PREVIEW_DETACHED_SRC_ATTR);
}
