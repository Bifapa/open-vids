import { useCallback, useState } from "react";
import { useVoiceClipOpsContext } from "../clip/voiceClipOpsContext";
import { selectedTakeOf, type VoiceGeneration } from "../script/voiceScriptStore";
import { useVoiceScriptStoreApi } from "../voiceContext";

/**
 * What choosing or making a take does beyond the script: the clips on the timeline that speak the line follow the
 * line's selected take (file, in-point, length; the ripple per the timeline's toggle), as one undo entry that says
 * what moved. When a locked later clip makes the timeline refuse the change, the script goes back to the take the
 * clips still play, so the script and the timeline never disagree. Without Studio's timeline writes (a bare mount)
 * only the script changes.
 */
export function useVoiceTakeActions() {
  const scripts = useVoiceScriptStoreApi();
  const clips = useVoiceClipOpsContext();
  const [error, setError] = useState<string | null>(null);

  /** Switches a line to one of its takes: nothing is paid. */
  const chooseTake = useCallback(
    async (lineId: string, takeId: string) => {
      setError(null);
      const before =
        scripts.getState().view?.lines.find((entry) => entry.id === lineId)?.selectedTakeId ?? null;
      const answer = await scripts.getState().selectTake(lineId, takeId);
      if (!answer.ok) {
        setError(answer.message);
        return;
      }
      const line = answer.value.lines.find((entry) => entry.id === lineId);
      const take = line ? selectedTakeOf(line) : null;
      if (!take || !clips) return;
      const report = await clips.applyTakes([{ lineId, take }]);
      if (report.blockedLines.includes(lineId) && before !== null && before !== takeId) {
        await scripts.getState().selectTake(lineId, before);
      }
    },
    [scripts, clips],
  );

  /** The service made new takes and selected them: the clips of those lines follow. */
  const followGenerated = useCallback(
    async ({ result, previousTakeIds }: VoiceGeneration) => {
      if (!clips) return;
      const report = await clips.applyTakes(
        result.lines.map(({ lineId, take }) => ({ lineId, take })),
      );
      for (const lineId of report.blockedLines) {
        const previous = previousTakeIds[lineId];
        if (previous) await scripts.getState().selectTake(lineId, previous);
      }
    },
    [scripts, clips],
  );

  return { chooseTake, followGenerated, error, clearError: () => setError(null) };
}
