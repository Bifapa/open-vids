import { useEffect } from "react";
import { isThinkingEffort, type UpdateAgentSettingsRequest } from "@hyperframes/agent-protocol";
import { useAgentStore } from "../../agent/agentContext";
import { useTranslation } from "../../i18n";
import { effortChoices } from "../../agent/agentSelectors";
import { EFFORT_LABELS } from "../chat/agentLabels";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { Toggle } from "../ui/Toggle";
import { JevCredentialGroup } from "./JevCredential";
import { JevModelPicker, JevProviderPicker } from "./JevPickers";
import { ProviderFix } from "./ProviderFix";
import { providerIssue } from "./providerStatus";
import {
  SaveStatus,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsUnavailable,
} from "./settingsLayout";
import { useAgentSettingsEditor } from "./useAgentSettingsEditor";

type JevPatch = NonNullable<UpdateAgentSettingsRequest["jev"]>;

/** Jev, the shared fast worker: on/off, which model it runs, and whose credentials it uses. */
export function JevSection() {
  const { t } = useTranslation();
  // What Jev is for; the prototype's lede, kept true to a Jev that shows up as a thread in the chats it works in.
  const lede = t("settings.studio.jev.lede");
  const editor = useAgentSettingsEditor();
  const jev = editor.settings?.jev;
  const providers = useAgentStore((state) => state.providers);
  const models = useAgentStore((state) =>
    jev?.provider ? state.providerModels[jev.provider] : undefined,
  );
  const loadProviders = useAgentStore((state) => state.loadProviders);
  const loadProviderModels = useAgentStore((state) => state.loadProviderModels);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);
  useEffect(() => {
    if (jev?.provider) void loadProviderModels(jev.provider);
  }, [jev?.provider, loadProviderModels]);

  if (!jev) {
    return (
      <SettingsPage title={t("settings.section.jev")} lede={lede}>
        <SettingsUnavailable
          message={
            editor.settingsFailed ? t("settings.studio.ag.unavailable") : t("settings.loading.jev")
          }
          action={
            editor.settingsFailed ? (
              <Button size="sm" onClick={() => void editor.loadSettings()}>
                {t("common.tryAgain")}
              </Button>
            ) : undefined
          }
        />
      </SettingsPage>
    );
  }

  const onCommit = (patch: JevPatch) => editor.commit({ jev: patch });
  const provider =
    providers?.status === "ready"
      ? providers.value.find((known) => known.id === jev.provider)
      : undefined;
  const modelInfo =
    models?.status === "ready"
      ? (models.value.find((model) => model.modelId === jev.modelId) ?? null)
      : null;
  const efforts = effortChoices(modelInfo);
  // The provider's own connection only matters while Jev rides on it; with a key of its own it does not.
  const connectionIssue =
    jev.credentials === "provider-login" && provider && providerIssue(provider) !== null;

  return (
    <SettingsPage
      title={t("settings.section.jev")}
      lede={lede}
      meta={<SaveStatus status={editor.status} failed={editor.failed} />}
    >
      <SettingsGroup label={t("settings.jev.group.worker")}>
        <SettingsRow label={t("settings.jev.use")} hint={t("settings.studio.jev.useHint")}>
          <Toggle
            label={t("settings.jev.use")}
            checked={jev.enabled}
            onCommit={(enabled) => onCommit({ enabled })}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.jev.provider")}
          hint={connectionIssue ? <ProviderFix provider={provider} /> : undefined}
        >
          <JevProviderPicker
            providers={providers}
            value={jev.provider}
            warn={Boolean(connectionIssue)}
            onRetry={() => void loadProviders()}
            onSelect={(id) => onCommit({ provider: id, modelId: null, thinking: null })}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.agents.col.model")}>
          <JevModelPicker
            models={models}
            jev={jev}
            onSelect={(model) => {
              const effort = jev.thinking;
              const drop = effort && effort !== "off" && !model.efforts.includes(effort);
              onCommit({
                provider: model.provider,
                modelId: model.modelId,
                ...(drop ? { thinking: null } : {}),
              });
            }}
          />
        </SettingsRow>
        {efforts.length > 0 && (
          <SettingsRow label={t("settings.studio.jev.thinking")}>
            <Select
              size="md"
              label={t("settings.studio.jev.thinkingAria")}
              className="w-56"
              value={jev.thinking ?? "default"}
              options={[
                { value: "default", label: t("settings.agents.effort.default") },
                ...efforts.map((effort) => ({ value: effort, label: t(EFFORT_LABELS[effort]) })),
              ]}
              onCommit={(next) => onCommit({ thinking: isThinkingEffort(next) ? next : null })}
            />
          </SettingsRow>
        )}
      </SettingsGroup>
      <JevCredentialGroup jev={jev} provider={provider} onCommit={onCommit} />
    </SettingsPage>
  );
}
