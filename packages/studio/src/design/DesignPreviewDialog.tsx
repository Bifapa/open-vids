import { Dialog } from "../components/ui";
import { useTranslation } from "../i18n";
import { designPreviewUrl, type DesignPreviewTarget } from "./designClient";

/**
 * The system's `system.html` showcase in a frame that runs no script. `sandbox="allow-same-origin"` keeps scripts,
 * forms, popups and navigation off (never add `allow-scripts`), and the server sends the file with
 * `Content-Security-Policy: sandbox allow-same-origin; default-src 'none'; …` as well, so even a page that got a
 * script past the format check cannot run it. Same-origin is allowed only so the page's own font requests are
 * ordinary same-origin requests: the design routes grant no cross-origin access to anyone.
 */
export function DesignPreviewDialog({
  target,
  title,
  onClose,
}: {
  target: DesignPreviewTarget;
  title: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={t("studio.design.preview.description")}
      className="w-[min(880px,calc(100vw-2rem))]"
    >
      <iframe
        title={t("studio.design.preview.frame", { name: title })}
        sandbox="allow-same-origin"
        src={designPreviewUrl(target)}
        className="h-[min(520px,calc(100vh-10rem))] w-full rounded-md border border-border bg-white"
      />
    </Dialog>
  );
}
