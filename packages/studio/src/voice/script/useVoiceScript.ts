import { useEffect, useMemo, useRef } from "react";
import { useAgentTurnRunning } from "../../agent/agentTurnLock";
import { useTranslation } from "../../i18n";
import { usePlayerStore } from "../../player";
import { useVoiceScriptStore, useVoiceScriptStoreApi } from "../voiceContext";
import type { VoiceScriptState } from "./voiceScriptStore";

/**
 * Why a voiceover write is refused right now, or null while writing is allowed. While an agent turn runs it may be
 * rewriting the script, its takes and the timeline, so every control that changes one of them stops, the same lock
 * the timeline and the file tree answer to.
 */
export function useVoiceEditLock(): { locked: boolean; reason: string | null } {
  const { t } = useTranslation();
  const locked = useAgentTurnRunning();
  return { locked, reason: locked ? t("timeline.toast.agentEditing") : null };
}

/** The ids of the timeline clips that speak a line, folded to a string: it changes when one is added or removed. */
function voiceClipSignature(elements: readonly { voiceLine?: string; key?: string; id: string }[]) {
  return elements
    .filter((element) => element.voiceLine !== undefined)
    .map((element) => `${element.voiceLine}:${element.key ?? element.id}`)
    .join("|");
}

/**
 * Keeps the script store on the open project and fresh: it is read when the project opens, again when a clip that
 * speaks a line appears or goes (the line's "on the timeline" state), and when an agent turn ends (it may have
 * changed the script); the dialect check follows every change of the spoken text. Returns the store's state.
 */
export function useVoiceScript(projectId: string | undefined): VoiceScriptState {
  const store = useVoiceScriptStoreApi();
  const state = useVoiceScriptStore((current) => current);
  const agentRunning = useAgentTurnRunning();
  const clipSignature = usePlayerStore((current) => voiceClipSignature(current.elements));
  const wasRunning = useRef(agentRunning);
  const lastSignature = useRef(clipSignature);

  useEffect(() => {
    store.getState().open(projectId ?? null);
  }, [store, projectId]);

  useEffect(() => {
    if (wasRunning.current && !agentRunning) void store.getState().reload();
    wasRunning.current = agentRunning;
  }, [store, agentRunning]);

  useEffect(() => {
    if (lastSignature.current === clipSignature) return;
    lastSignature.current = clipSignature;
    void store.getState().reload();
  }, [store, clipSignature]);

  useEffect(() => {
    store.getState().scheduleCheck();
  }, [store, state.view]);

  return state;
}

/** The issues of one line from the last check, errors first. */
export function useLineIssues(lineId: string) {
  const check = useVoiceScriptStore((state) => state.check);
  return useMemo(
    () =>
      (check?.issues ?? [])
        .filter((issue) => issue.lineId === lineId)
        .sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error")),
    [check, lineId],
  );
}
