import { Dialog } from "../components/ui";
import { useTranslation } from "../i18n";
import { designPreviewUrl, type DesignPreviewTarget } from "./designClient";

/**
 * The system's `system.html` showcase in a frame that runs nothing: `sandbox=""` blocks scripts, forms, popups and
 * same-origin access, and the server sends the file with its own sandbox CSP as well. The page is a static sheet
 * (live samples are CSS-only), so no scripts are needed to read it.
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
        sandbox=""
        src={designPreviewUrl(target)}
        className="h-[min(520px,calc(100vh-10rem))] w-full rounded-md border border-border bg-white"
      />
    </Dialog>
  );
}
