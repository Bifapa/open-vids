import { useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import {
  isThinkingEffort,
  type AgentModelCatalog,
  type ModelSelection,
  type SpecialistConfig,
} from "@hyperframes/agent-protocol";
import { effortChoices, findModel, resolveModel, sameModel } from "../../agent/agentSelectors";
import { useTranslation } from "../../i18n";
import { cn } from "../ui/cn";
import { Popover } from "../ui/Popover";
import { EFFORT_LABELS, type ConfigDefaults } from "./agentLabels";
import { DialogField } from "./ChatDialog";
import { ChoiceChips, type Choice } from "./ChoiceChips";
import { ModelList } from "./ModelList";
import { ModelPicker } from "./ModelPicker";

const chipButton = cn(
  "inline-flex h-ctl-sm items-center gap-1 rounded-sm border border-dashed border-border-input px-2 text-step-11 text-text-2",
  "outline-hidden transition-colors duration-hover enabled:hover:border-border-strong enabled:hover:text-text-0",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent",
  "disabled:cursor-not-allowed disabled:opacity-40",
);

/** The extra models the Director may route one task to. `bare` drops the field label and hint (Settings rows). */
export function AllowedModels({
  name,
  value,
  catalog,
  disabled,
  onChange,
  bare = false,
}: {
  name: string;
  value: readonly ModelSelection[];
  catalog: AgentModelCatalog | null;
  disabled: boolean;
  onChange: (next: ModelSelection[]) => void;
  bare?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = (model: ModelSelection) =>
    onChange(
      value.some((known) => sameModel(known, model))
        ? value.filter((known) => !sameModel(known, model))
        : [...value, model],
    );

  const list = (
    <ul
      aria-label={t("chat.allowedModels.listLabel", { name })}
      className={cn("flex flex-wrap gap-1", bare && "justify-end")}
    >
      {value.map((model) => {
        const known = findModel(catalog, model);
        const label = known?.name ?? `${model.provider}/${model.modelId}`;
        return (
          <li
            key={`${model.provider}/${model.modelId}`}
            className="inline-flex h-ctl-sm items-center gap-0.5 rounded-sm border border-border-input bg-input pl-2 pr-0.5 text-step-11 text-text-1"
            title={known ? undefined : t("chat.allowedModels.notSignedIn")}
          >
            <span className={cn("max-w-40 truncate", !known && "text-text-3")}>{label}</span>
            <button
              type="button"
              aria-label={t("chat.allowedModels.remove", { label })}
              disabled={disabled}
              onClick={() => toggle(model)}
              className="rounded-sm p-0.5 text-text-3 outline-hidden enabled:hover:text-text-0 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
            >
              <X size={10} aria-hidden />
            </button>
          </li>
        );
      })}
      <li>
        <Popover
          open={open}
          onOpenChange={setOpen}
          side="bottom"
          align="start"
          aria-label={t("chat.allowedModels.popoverLabel", { name })}
          trigger={
            <button
              type="button"
              aria-label={t("chat.allowedModels.addLabel", { name })}
              disabled={disabled || !catalog || catalog.models.length === 0}
              className={chipButton}
            >
              <Plus size={11} aria-hidden />
              {t("common.add")}
            </button>
          }
        >
          {catalog && (
            <ModelList
              models={catalog.models}
              explicit={null}
              defaultName={null}
              includeDefault={false}
              selected={value}
              onSelect={(model) => {
                if (model) toggle(model);
              }}
            />
          )}
        </Popover>
      </li>
    </ul>
  );
  if (bare) return list;
  return (
    <DialogField
      label={t("chat.allowedModels.field")}
      hint={
        value.length === 0
          ? t("chat.allowedModels.hintNone", { name })
          : t("chat.allowedModels.hintSome", { name })
      }
    >
      {list}
    </DialogField>
  );
}

interface AgentConfigFieldsProps {
  /** The agent's display name, for labels ("Editor"). */
  name: string;
  value: SpecialistConfig;
  onChange: (next: SpecialistConfig) => void;
  catalog: AgentModelCatalog | null;
  catalogFailed: boolean;
  /** What the null fields resolve to. */
  defaults: ConfigDefaults;
  /** Specialists only: the extra models the Director may route a task to. */
  withAllowedModels: boolean;
  disabled: boolean;
  disabledReason?: string;
}

/** Model, thinking effort and (for specialists) the Director's routing allowance for one agent. */
export function AgentConfigFields({
  name,
  value,
  onChange,
  catalog,
  catalogFailed,
  defaults,
  withAllowedModels,
  disabled,
  disabledReason,
}: AgentConfigFieldsProps) {
  const { t } = useTranslation();
  const { info } = resolveModel(value.model, catalog, defaults.model);
  const efforts = effortChoices(info);
  const choices: Choice<string>[] = [
    {
      value: "default",
      label: defaults.thinking
        ? t("chat.effort.defaultWith", { effort: t(EFFORT_LABELS[defaults.thinking]) })
        : t("common.default"),
    },
    ...efforts.map((effort) => ({ value: effort, label: t(EFFORT_LABELS[effort]) })),
  ];
  if (value.thinking && !efforts.includes(value.thinking)) {
    choices.push({ value: value.thinking, label: t(EFFORT_LABELS[value.thinking]) });
  }

  // A model that cannot take the current effort resets it to the default, as the header does.
  const setModel = (model: ModelSelection | null) => {
    const next = resolveModel(model, catalog, defaults.model).info;
    const effort = value.thinking;
    const drop = next && effort && effort !== "off" && !next.efforts.includes(effort);
    onChange({ ...value, model, thinking: drop ? null : effort });
  };

  return (
    <div className="flex flex-col gap-3">
      <DialogField label={t("chat.field.model")}>
        <ModelPicker
          name={t("chat.agents.modelName", { name })}
          catalog={catalog}
          catalogFailed={catalogFailed}
          explicit={value.model}
          fallback={defaults.model}
          disabled={disabled}
          disabledReason={disabledReason}
          onSelect={setModel}
        />
      </DialogField>
      <DialogField
        label={t("chat.field.thinking")}
        hint={withAllowedModels ? t("chat.field.thinkingHint") : undefined}
      >
        {efforts.length === 0 ? (
          <p className="text-step-11 text-text-3">{t("chat.effort.noneAdjustableLong")}</p>
        ) : (
          <ChoiceChips
            label={t("chat.field.thinkingGroup", { name })}
            value={value.thinking ?? "default"}
            choices={choices}
            disabled={disabled}
            onChange={(next) =>
              onChange({ ...value, thinking: isThinkingEffort(next) ? next : null })
            }
          />
        )}
      </DialogField>
      {withAllowedModels && (
        <AllowedModels
          name={name}
          value={value.allowedModels}
          catalog={catalog}
          disabled={disabled}
          onChange={(allowedModels) => onChange({ ...value, allowedModels })}
        />
      )}
    </div>
  );
}
