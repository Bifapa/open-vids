import { useCallback, useMemo, useState } from "react";
import type { VoiceLineInput } from "@hyperframes/agent-protocol";
import { useVoiceScriptStoreApi } from "../voiceContext";

/**
 * The script's text edits. Every one is `PUT /voice/script` with the whole script and the line's id, so the line keeps
 * its takes; the line then reads "Text changed" until it is generated again. A refusal is kept in `error`.
 */
export function useVoiceLineEdits() {
  const scripts = useVoiceScriptStoreApi();
  const [error, setError] = useState<string | null>(null);

  const change = useCallback(
    async (transform: (lines: VoiceLineInput[]) => VoiceLineInput[], language?: string | null) => {
      const answer = await scripts.getState().save(transform, language);
      setError(answer.ok ? null : answer.message);
      return answer.ok;
    },
    [scripts],
  );

  const edit = useCallback(
    (lineId: string, patch: (line: VoiceLineInput) => VoiceLineInput) =>
      change((lines) => lines.map((line) => (line.id === lineId ? patch(line) : line))),
    [change],
  );

  return useMemo(
    () => ({
      error,
      clearError: () => setError(null),
      /** What the narrator reads, tags included. */
      setSpeakerText: (lineId: string, speakerText: string) =>
        edit(lineId, (line) => ({ ...line, speakerText })),
      /**
       * The source text (the captions). A speaker text that was the same words follows it: the two start equal and
       * most edits mean to change both.
       */
      setCaption: (lineId: string, text: string) =>
        edit(lineId, (line) => ({
          ...line,
          text,
          speakerText: line.speakerText === line.text ? text : line.speakerText,
        })),
      setStyle: (lineId: string, style: string) => edit(lineId, (line) => ({ ...line, style })),
      setLanguage: (language: string | null) => change((lines) => lines, language),
      addLine: (text: string) => change((lines) => [...lines, { text }]),
      removeLine: (lineId: string) => change((lines) => lines.filter((line) => line.id !== lineId)),
      moveLine: (lineId: string, by: -1 | 1) =>
        change((lines) => {
          const from = lines.findIndex((line) => line.id === lineId);
          const to = from + by;
          if (from < 0 || to < 0 || to >= lines.length) return lines;
          const next = [...lines];
          const [moved] = next.splice(from, 1);
          if (moved) next.splice(to, 0, moved);
          return next;
        }),
    }),
    [change, edit, error],
  );
}
