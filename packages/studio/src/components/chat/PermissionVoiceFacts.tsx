import type { PermissionVoice } from "@hyperframes/agent-protocol";
import { formatDuration, useTranslation } from "../../i18n";
import { usdOrUnknown } from "../../voice/voiceLabels";
import { voiceProviderName } from "../../voice/voiceProviderNames";

/**
 * What a `voice_generation` request is about, in numbers the user can weigh before paying: the service and model,
 * how many lines, how long the speech will be and what it will cost. The cost reads "unknown" when the provider's
 * price is not known, never a guessed figure.
 */
export function PermissionVoiceFacts({ voice }: { voice: PermissionVoice }) {
  const { t } = useTranslation();
  const rows: Array<[label: string, value: string, testId: string]> = [
    [
      t("chat.permission.voice.service"),
      `${voiceProviderName(voice.provider)} · ${voice.model}`,
      "service",
    ],
    [t("chat.permission.voice.lines"), String(voice.lines), "lines"],
    [t("chat.permission.voice.length"), formatDuration(voice.seconds), "seconds"],
    [t("chat.permission.voice.cost"), usdOrUnknown(voice.usdCost), "cost"],
  ];
  return (
    <dl
      data-testid="permission-voice"
      className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-sm bg-surface-1 px-2 py-1.5 text-xs leading-[15px]"
    >
      {rows.map(([label, value, testId]) => (
        <div key={testId} className="contents">
          <dt className="text-fg-3">{label}</dt>
          <dd
            data-testid={`permission-voice-${testId}`}
            className="m-0 min-w-0 [overflow-wrap:anywhere] text-fg tabular-nums"
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
