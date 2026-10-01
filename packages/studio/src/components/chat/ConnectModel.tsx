import { Button } from "../ui/Button";
import { openSettings } from "../settings/settingsStore";

export const NO_MODEL_TITLE = "Connect a model to use the agents";

/** What to say next to it: the agents need a model, and the editor does not. */
export const NO_MODEL_DETAIL =
  "Agents run on a model from a provider. Sign in or add an API key and they are ready.";

export const MANUAL_EDITOR_NOTE = "The manual editor works without a model.";

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
  return (
    <Button size="sm" variant={variant} className={className} onClick={openModelSettings}>
      Connect a model
    </Button>
  );
}

/**
 * The empty chat of a user with no usable model, in place of the starting prompts: calm, with the one action that
 * fixes it, and a line that the manual editor does not need a model. Sits where `EmptyChat` does, above the composer.
 */
export function NoModelState() {
  return (
    <div
      role="status"
      data-testid="no-model-state"
      className="flex min-h-full flex-1 flex-col justify-end gap-2.5 pt-4 pb-2.5 @min-[440px]/chat:px-1"
    >
      <p className="text-sm leading-[17px] font-medium text-fg-2">{NO_MODEL_TITLE}</p>
      <p className="max-w-[36ch] text-sm leading-[17px] text-pretty text-fg-3">
        {NO_MODEL_DETAIL} {MANUAL_EDITOR_NOTE}
      </p>
      <ConnectModelButton variant="primary" className="self-start" />
    </div>
  );
}
