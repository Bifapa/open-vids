import type { PlanStep, VoiceDialect } from "@hyperframes/agent-protocol";
import { useStudioShellContextOptional } from "../../contexts/StudioContext";
import { useProjectVoice } from "../../voice/useProjectVoice";

/** Plain titles never carry a tag; only a bracket or a chevron can, so only those are worth asking the server about. */
const MAY_HAVE_TAG = /[<[]/;

/**
 * The dialect whose tags a plan's step titles may carry (the project's voice), for `VoiceTaggedText`. Read once from
 * the project's `GET /voice/script`, and only when a step title could hold a tag: a plan with plain titles never
 * asks. Null without a voice, and the titles stay plain text.
 */
export function usePlanVoiceDialect(steps: readonly PlanStep[]): VoiceDialect | null {
  const projectId = useStudioShellContextOptional()?.projectId;
  const wanted = steps.some((step) => MAY_HAVE_TAG.test(step.title));
  const project = useProjectVoice(projectId, wanted);
  return project.script?.voice ? project.script.dialect : null;
}
