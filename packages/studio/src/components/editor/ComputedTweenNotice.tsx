import { editabilityForProvenance, type GsapProvenance } from "@hyperframes/core/gsap-parser-acorn";
import { useTranslation } from "../../i18n";

/**
 * Notice shown for computed tweens: helper/loop tweens offer an "unroll to
 * edit" action; runtime-computed values point to the Code tab. Literal tweens
 * render nothing.
 */
export function ComputedTweenNotice({
  provenance,
  onUnroll,
}: {
  provenance?: GsapProvenance;
  onUnroll?: () => void;
}) {
  const { t } = useTranslation();
  const editability = editabilityForProvenance(provenance);
  if (editability === "direct") return null;
  if (editability === "source") {
    return (
      <div className="rounded-md border border-border bg-surface-1/50 px-2 py-1.5 text-2xs text-fg-2">
        {t("editor.computedTween.source")}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-1/50 px-2 py-1.5 text-2xs text-fg-2">
      <span>
        {provenance?.fn
          ? t("editor.computedTween.generatedByFn", { source: `${provenance.fn}()` })
          : t("editor.computedTween.generatedByLoop")}
      </span>
      {onUnroll && (
        <button
          type="button"
          onClick={onUnroll}
          className="shrink-0 rounded-sm px-1.5 py-0.5 text-2xs font-medium text-fg hover:bg-surface-2"
          title={t("editor.computedTween.unrollTitle")}
        >
          {t("editor.computedTween.unroll")}
        </button>
      )}
    </div>
  );
}
