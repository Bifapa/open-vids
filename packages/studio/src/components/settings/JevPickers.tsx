import { useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import type {
  AgentModelInfo,
  JevSettings as JevSettingsValue,
  ProviderInfo,
} from "@hyperframes/agent-protocol";
import type { Loadable } from "../../agent/agentSettingsSlice";
import { useTranslation, type TranslationKey } from "../../i18n";
import { ModelList } from "../chat/ModelList";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { fieldBase, fieldSizes } from "../ui/Input";
import { Popover } from "../ui/Popover";
import { splitProviders } from "./providerStatus";

/** The window-form select look (prototype `.st-win .sel`) on a popover trigger. */
const triggerClass = cn(
  fieldBase,
  fieldSizes.md,
  "w-56 cursor-pointer gap-1.5 text-left text-sm text-fg",
  "disabled:cursor-not-allowed disabled:border-border-subtle disabled:bg-transparent disabled:text-fg-disabled",
);

/** The short state of a provider in the picker's list (the full wording lives in Models & Providers). */
const STATE_LABELS: Record<ProviderInfo["status"], { label: TranslationKey; className: string }> = {
  connected: { label: "settings.providers.badge.connected", className: "text-success" },
  error: { label: "settings.providers.badge.error", className: "text-error" },
  signin_required: { label: "settings.providers.badge.signinRequired", className: "text-warning" },
  not_configured: { label: "settings.studio.st.notSetUp", className: "text-fg-3" },
};

/**
 * Any provider can be chosen, connected or not: Jev may bring its own API key, so a provider the agents are not set
 * up on is still a valid choice. `warn` puts the prototype's warning edge on the trigger.
 */
export function JevProviderPicker({
  providers,
  value,
  warn,
  onSelect,
  onRetry,
}: {
  providers: Loadable<ProviderInfo[]> | null;
  value: string | null;
  warn?: boolean;
  onSelect: (provider: string) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const list = providers?.status === "ready" ? providers.value : null;
  const ordered = list ? splitProviders(list) : null;
  const known = list?.find((provider) => provider.id === value);
  const label = known?.name ?? value ?? t("settings.jev.provider.choose");

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      aria-label={t("settings.studio.jev.providersAria")}
      className="w-64 p-1"
      trigger={
        <button
          type="button"
          aria-label={t("settings.studio.jev.providerAria", { label })}
          className={cn(triggerClass, warn && "border-warning/55")}
        >
          <span className={cn("min-w-0 flex-1 truncate", value === null && "text-fg-3")}>
            {label}
          </span>
          <CaretDown aria-hidden className="size-icon-xs shrink-0 text-fg-3" />
        </button>
      }
    >
      {providers?.status === "failed" ? (
        <div className="flex flex-col items-start gap-1.5 p-2">
          <p className="m-0 text-sm text-fg-2">{providers.message}</p>
          <Button size="sm" onClick={onRetry}>
            {t("common.tryAgain")}
          </Button>
        </div>
      ) : !list ? (
        <p className="m-0 p-2 text-sm text-fg-3">{t("settings.loading.providers")}</p>
      ) : list.length === 0 ? (
        <p className="m-0 p-2 text-sm text-fg-3">{t("settings.studio.jev.noProviders")}</p>
      ) : (
        <ul
          aria-label={t("settings.providers.group.providers")}
          className="m-0 flex max-h-64 list-none flex-col overflow-y-auto p-0"
        >
          {[...(ordered?.shown ?? []), ...(ordered?.rest ?? [])].map((provider) => (
            <li key={provider.id}>
              <button
                type="button"
                aria-pressed={provider.id === value}
                onClick={() => {
                  setOpen(false);
                  if (provider.id !== value) onSelect(provider.id);
                }}
                className="flex h-ctl-sm w-full items-center gap-2 rounded-sm px-2 text-left text-sm text-fg outline-hidden hover:bg-surface-2 focus-visible:bg-surface-2"
              >
                <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                <span className={cn("text-xs", STATE_LABELS[provider.status].className)}>
                  {t(STATE_LABELS[provider.status].label)}
                </span>
                <Check
                  aria-hidden
                  className={cn(
                    "size-icon-sm shrink-0 text-fg",
                    provider.id !== value && "invisible",
                  )}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}

export function JevModelPicker({
  models,
  jev,
  onSelect,
}: {
  models: Loadable<AgentModelInfo[]> | undefined;
  jev: JevSettingsValue;
  onSelect: (model: AgentModelInfo) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const list = models?.status === "ready" ? models.value : null;
  const current = list?.find((model) => model.modelId === jev.modelId) ?? null;
  let label = current?.name ?? jev.modelId ?? t("settings.jev.model.choose");
  if (!jev.provider) label = t("settings.jev.model.chooseProviderFirst");
  else if (models?.status === "failed") label = t("settings.jev.model.unavailable");
  else if (!list) label = t("settings.providers.models.loading");

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      aria-label={t("settings.studio.jev.modelsAria")}
      trigger={
        <button
          type="button"
          aria-label={t("settings.studio.jev.modelAria", { label })}
          disabled={!list || list.length === 0}
          className={triggerClass}
        >
          <span className={cn("min-w-0 flex-1 truncate", !current && "text-fg-3")}>{label}</span>
          <CaretDown aria-hidden className="size-icon-xs shrink-0 text-fg-3" />
        </button>
      }
    >
      {list && (
        <ModelList
          models={list}
          explicit={
            jev.provider && jev.modelId ? { provider: jev.provider, modelId: jev.modelId } : null
          }
          defaultName={null}
          includeDefault={false}
          onSelect={(selection) => {
            const model = list.find((item) => item.modelId === selection?.modelId);
            setOpen(false);
            if (model) onSelect(model);
          }}
        />
      )}
    </Popover>
  );
}
