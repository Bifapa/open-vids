import {
  PLAN_APPROVALS,
  type AutonomySettings,
  type PlanApproval,
} from "@hyperframes/agent-protocol";
import { useTranslation, type TranslationKey } from "../../i18n";
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

/** The hint says what each approval level means. */
const APPROVAL_HINTS: Record<PlanApproval, TranslationKey> = {
  big: "settings.execution.planApproval.big.hint",
  always: "settings.execution.planApproval.always.hint",
  never: "settings.execution.planApproval.never.hint",
};

const APPROVAL_LABELS: Record<PlanApproval, TranslationKey> = {
  big: "settings.execution.planApproval.big",
  always: "settings.execution.planApproval.always",
  never: "settings.execution.planApproval.never",
};

/**
 * How much the agents may do without asking (prototype "Autonomy"): when a plan must be approved first, and whether
 * they ask before touching locked or hand-edited sections and before downloading assets. Each change saves at once.
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
        label={t("settings.execution.planApproval")}
        hint={t(APPROVAL_HINTS[autonomy.planApproval])}
      >
        <SegmentedControl
          label={t("settings.execution.planApproval")}
          value={autonomy.planApproval}
          options={PLAN_APPROVALS.map((approval) => ({
            value: approval,
            label: t(APPROVAL_LABELS[approval]),
          }))}
          onChange={(planApproval) => onChange({ planApproval })}
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
