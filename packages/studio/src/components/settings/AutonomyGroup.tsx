import { CHAT_INTENTS, type AutonomySettings } from "@hyperframes/agent-protocol";
import { INTENT_LABELS } from "../chat/ModeMenu";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Toggle } from "../ui/Toggle";
import { SettingsGroup, SettingsRow } from "./settingsLayout";

const MODE_OPTIONS = CHAT_INTENTS.map((intent) => ({
  value: intent,
  label: INTENT_LABELS[intent].name,
}));

/** The hint says what the switch does in its current position; locked material is never changed either way. */
const LOCKED_HINTS = {
  on: "Agents stop and ask first. They never change locked sections on their own.",
  off: "Agents skip locked or hand-edited items, carry on, and tell you afterwards.",
} as const;

const DOWNLOAD_HINTS = {
  on: "Agents list what they found and wait for approval",
  off: "Agents add the assets that fit without asking",
} as const;

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
  return (
    <SettingsGroup label="Autonomy">
      <SettingsRow
        label="Default chat mode"
        hint={INTENT_LABELS[autonomy.defaultIntent].description}
      >
        <SegmentedControl
          label="Default chat mode"
          value={autonomy.defaultIntent}
          options={MODE_OPTIONS}
          onChange={(defaultIntent) => onChange({ defaultIntent })}
        />
      </SettingsRow>
      <SettingsRow
        label="Ask before changing locked or hand-edited sections"
        hint={LOCKED_HINTS[autonomy.askBeforeLockedEdits ? "on" : "off"]}
      >
        <Toggle
          label="Ask before changing locked or hand-edited sections"
          checked={autonomy.askBeforeLockedEdits}
          onCommit={(askBeforeLockedEdits) => onChange({ askBeforeLockedEdits })}
        />
      </SettingsRow>
      <SettingsRow
        label="Ask before downloading assets"
        hint={DOWNLOAD_HINTS[autonomy.askBeforeDownloads ? "on" : "off"]}
      >
        <Toggle
          label="Ask before downloading assets"
          checked={autonomy.askBeforeDownloads}
          onCommit={(askBeforeDownloads) => onChange({ askBeforeDownloads })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
