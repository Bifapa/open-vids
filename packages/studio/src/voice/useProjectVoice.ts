import { useEffect, useState } from "react";
import type { VoiceScriptView } from "@hyperframes/agent-protocol";
import { useVoiceClient } from "./voiceContext";

/** What a project's `GET /voice/script` said, once. */
export interface ProjectVoice {
  /** False until the first answer (or failure) arrived. */
  loaded: boolean;
  script: VoiceScriptView | null;
}

/**
 * The project's voice script (its voice, dialect and language), read once when `enabled`. A failed read is "no
 * voice": the callers only ever add to what they show, so nothing breaks while it is unknown.
 */
export function useProjectVoice(projectId: string | undefined, enabled: boolean): ProjectVoice {
  const client = useVoiceClient();
  const [state, setState] = useState<ProjectVoice & { projectId: string | null }>({
    loaded: false,
    script: null,
    projectId: null,
  });
  const wanted = enabled && projectId !== undefined && projectId !== "" ? projectId : null;

  useEffect(() => {
    if (wanted === null) return;
    const controller = new AbortController();
    client
      .script(wanted, controller.signal)
      .then((script) => {
        if (!controller.signal.aborted) setState({ loaded: true, script, projectId: wanted });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ loaded: true, script: null, projectId: wanted });
      });
    return () => controller.abort();
  }, [client, wanted]);

  if (wanted === null || state.projectId !== wanted) return { loaded: false, script: null };
  return { loaded: state.loaded, script: state.script };
}
