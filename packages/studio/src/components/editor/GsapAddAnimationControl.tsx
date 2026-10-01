import { useTranslation } from "../../i18n";
import { ADD_METHODS, ADD_METHOD_LABELS, methodTooltip } from "./gsapAnimationConstants";

const STYLES = {
  classic: {
    method:
      "h-ctl-sm rounded-sm border border-border bg-surface-1 px-2.5 text-sm font-medium text-fg-2 transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-fg",
    cancel: "px-1.5 text-sm text-fg-3 hover:text-fg-2",
    trigger: "text-sm font-medium text-fg-2 transition-colors hover:text-fg",
  },
  flat: {
    method:
      "rounded-lg border border-border bg-surface-1 px-2.5 py-1.5 text-sm font-medium text-fg-2 transition-colors hover:border-panel-text-4 hover:text-fg",
    cancel: "px-1.5 text-sm text-fg-3 hover:text-fg",
    trigger: "text-sm font-medium text-fg-3 transition-colors hover:text-fg",
  },
};

export function GsapAddAnimationControl({
  open,
  setOpen,
  onAddAnimation,
  variant,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  onAddAnimation: (method: "to" | "from" | "set" | "fromTo") => void;
  variant: keyof typeof STYLES;
}) {
  const { t } = useTranslation();
  const styles = STYLES[variant];

  return (
    <div className="relative pt-1">
      {open ? (
        <div className="flex gap-1.5">
          {ADD_METHODS.map((method) => (
            <button
              key={method}
              type="button"
              title={methodTooltip(t, method)}
              onClick={() => {
                onAddAnimation(method);
                setOpen(false);
              }}
              className={styles.method}
            >
              {t(ADD_METHOD_LABELS[method])}
            </button>
          ))}
          <button type="button" onClick={() => setOpen(false)} className={styles.cancel}>
            {t("common.cancel")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={styles.trigger}
          title={t("editor.animation.addEffectToElementTitle")}
        >
          {t("editor.animation.addEffect")}
        </button>
      )}
    </div>
  );
}
