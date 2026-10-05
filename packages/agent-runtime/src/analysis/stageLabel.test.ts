import { describe, expect, it } from "vitest";
import { COMPUTED_STAGES } from "@hyperframes/agent-protocol";
import { isQaClosing } from "../qa/harness.js";
import { SAMPLE_SOURCE } from "../testing/analysis.js";
import { createRuntimeFixture, waitUntil } from "../testing/runtimeFixture.js";
import { stageProgressLabel } from "./stageLabel.js";

describe("stageProgressLabel", () => {
  it("has a row for every computed stage, with its own code and the file name as the parameter", () => {
    const codes = COMPUTED_STAGES.map((stage) => stageProgressLabel("talk.mp4", stage)?.labelCode);
    expect(new Set(codes).size).toBe(COMPUTED_STAGES.length);
    expect(stageProgressLabel("talk.mp4", "speakers")).toEqual({
      label: "Analyzing talk.mp4 · mapping speakers",
      labelCode: "analyzing_stage_speakers",
      labelParams: { name: "talk.mp4" },
    });
  });

  it("says nothing between stages or without a file name, so the row keeps what it shows", () => {
    expect(stageProgressLabel("talk.mp4", null)).toBeUndefined();
    expect(stageProgressLabel(null, "transcript")).toBeUndefined();
  });
});

describe("analyze_media's chat row in a turn", () => {
  it("shows the stage the job is in next to the percent, then closes without a percent", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.analysis.runningPolls = 3;
      fixture.analysis.progressScript = [10, 55, 90];
      fixture.analysis.stageScript = ["transcript", "speakers", "silence"];
      const chat = await fixture.chats.create({}, []);
      fixture.backend.promptScript = async (input, session) => {
        if (isQaClosing(input)) return "completed";
        await session.callTool("analyze_media", { source: SAMPLE_SOURCE });
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Analyze the talk" });
      await waitUntil(() => fixture.turns.activeTurn === null, "the turn to end");

      const rows = fixture.chats
        .events(chat.id)
        .flatMap((event) => (event.type === "activity.updated" ? [event.activity] : []))
        .filter((activity) => activity.labelCode?.startsWith("analyzing_"));
      const shown = rows.map((row) => `${row.labelCode}@${row.progress ?? "-"}/${row.status}`);
      expect(shown).toEqual([
        "analyzing_source@-/running",
        "analyzing_stage_transcript@40/running",
        "analyzing_stage_transcript@10/running",
        "analyzing_stage_speakers@55/running",
        "analyzing_stage_silence@90/running",
        // The poll that saw the job complete reports no stage: the row keeps the last stage's text, at 100 %.
        "analyzing_stage_silence@100/running",
        "analyzing_stage_silence@-/done",
      ]);
      expect(rows[3]?.labelParams).toEqual({ name: "raw-talk.mp4" });
      expect(rows[3]?.label).toBe("Analyzing raw-talk.mp4 · mapping speakers");
    } finally {
      await fixture.cleanup();
    }
  });
});
