import type { ComputedStage } from "@hyperframes/agent-protocol";
import type { ProgressLabel } from "../backend.js";

/**
 * What the chat row of a running `analyze_media` says about the stage the job is in, next to the percent. One locale
 * code per stage (`activity.<labelCode>`, parameter `name`), written out so the code scan sees each of them.
 */
const STAGE_ROWS: Record<ComputedStage, { text: string; labelCode: string }> = {
  transcript: { text: "transcribing speech", labelCode: "analyzing_stage_transcript" },
  speakers: { text: "mapping speakers", labelCode: "analyzing_stage_speakers" },
  silence: { text: "measuring pauses", labelCode: "analyzing_stage_silence" },
  shots: { text: "finding shots", labelCode: "analyzing_stage_shots" },
  takes: { text: "checking takes", labelCode: "analyzing_stage_takes" },
  segments: { text: "drafting segments", labelCode: "analyzing_stage_segments" },
};

/** The row label for `name` while the job runs `stage`; undefined between stages (the row keeps what it shows). */
export function stageProgressLabel(
  name: string | null,
  stage: ComputedStage | null,
): ProgressLabel | undefined {
  if (name === null || stage === null) return undefined;
  const row = STAGE_ROWS[stage];
  return {
    label: `Analyzing ${name} · ${row.text}`,
    labelCode: row.labelCode,
    labelParams: { name },
  };
}
