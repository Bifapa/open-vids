import { useTranslation, type TranslationKey } from "../../i18n";
import { Button } from "../ui/Button";
import { openSettings } from "../settings/settingsStore";

/** "Connect a model to use the agents" (no full stop). */
export const NO_MODEL_TITLE: TranslationKey = "chat.noModel.title";

/** "Connect a model to use the agents." as a sentence of its own, ahead of the manual-editor note. */
export const NO_MODEL_SENTENCE: TranslationKey = "chat.noModel.sentence";

export const MANUAL_EDITOR_NOTE: TranslationKey = "chat.noModel.manualEditor";

/** Settings → Models & Providers, where a model is connected (a sign-in or an API key). */
export function openModelSettings(): void {
  openSettings("providers");
}

/** The way to connect a model, next to whatever says one is missing. */
export function ConnectModelButton({
  variant = "secondary",
  className,
}: {
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Button size="sm" variant={variant} className={className} onClick={openModelSettings}>
      {t("chat.noModel.connect")}
    </Button>
  );
}

/**
 * The empty chat of a user with no usable model, in place of the starting prompts: calm, with the one action that
 * fixes it, and a line that the manual editor does not need a model. Sits where `EmptyChat` does, above the composer.
 */
export function NoModelState() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-testid="no-model-state"
      className="flex min-h-full flex-1 flex-col justify-end gap-2.5 pt-4 pb-2.5 @min-[440px]/chat:px-1"
    >
      <p className="text-sm leading-[17px] font-medium text-fg-2">{t(NO_MODEL_TITLE)}</p>
      <p className="max-w-[36ch] text-sm leading-[17px] text-pretty text-fg-3">
        {t("chat.noModel.detail")}
      </p>
      <ConnectModelButton variant="primary" className="self-start" />
    </div>
  );
}
