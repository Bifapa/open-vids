import { CHAT_INTENTS, type AutonomySettings } from "@hyperframes/agent-protocol";
import { useTranslation, type TranslationKey } from "../../i18n";
import { INTENT_LABELS } from "../chat/ModeMenu";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Toggle } from "../ui/Toggle";
import { SettingsGroup, SettingsRow } from "./settingsLayout";

/** The hint says what the switch does in its current position; locked material is never changed either way. */
const LOCKED_HINTS = {
  on: "settings.studio.au.lockedOn",
  off: "settings.studio.au.lockedOff",
} as const satisfies Record<string, TranslationKey>;

const DOWNLOAD_HINTS = {
  on: "settings.studio.au.dlOn",
  off: "settings.studio.au.dlOff",
} as const satisfies Record<string, TranslationKey>;

/**
 * How much the agents may do without asking (prototype "Autonomy"): the mode a new chat starts in, and whether they
 * ask before touching locked or hand-edited sections and before downloading assets. Each change saves at once.
 */
export function AutonomyGroup({
  autonomy,
  onChange,
}: {
  autonomy: AutonomySettings;
  onChange: (patch: Partial<AutonomySettings>) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsGroup label={t("settings.execution.group.autonomy")}>
      <SettingsRow
        label={t("settings.execution.chatMode")}
        hint={t(INTENT_LABELS[autonomy.defaultIntent].description)}
      >
        <SegmentedControl
          label={t("settings.execution.chatMode")}
          value={autonomy.defaultIntent}
          options={CHAT_INTENTS.map((intent) => ({
            value: intent,
            label: t(INTENT_LABELS[intent].name),
          }))}
          onChange={(defaultIntent) => onChange({ defaultIntent })}
        />
      </SettingsRow>
      <SettingsRow
        label={t("settings.execution.askLocked")}
        hint={t(LOCKED_HINTS[autonomy.askBeforeLockedEdits ? "on" : "off"])}
      >
        <Toggle
          label={t("settings.execution.askLocked")}
          checked={autonomy.askBeforeLockedEdits}
          onCommit={(askBeforeLockedEdits) => onChange({ askBeforeLockedEdits })}
        />
      </SettingsRow>
      <SettingsRow
        label={t("settings.execution.askDownloads")}
        hint={t(DOWNLOAD_HINTS[autonomy.askBeforeDownloads ? "on" : "off"])}
      >
        <Toggle
          label={t("settings.execution.askDownloads")}
          checked={autonomy.askBeforeDownloads}
          onCommit={(askBeforeDownloads) => onChange({ askBeforeDownloads })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
