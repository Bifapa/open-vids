// @vitest-environment node
import type {
  ShotMap,
  SilenceMap,
  TakeIssue,
  TranscriptArtifact,
} from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { detectTakeIssues } from "./takes.js";
import { speak, transcriptOf } from "./testTranscript.js";
import { buildTranscript } from "./transcript.js";

function detect(
  script: string,
  extra: { shots?: ShotMap; silence?: SilenceMap; start?: number; language?: string } = {},
) {
  const transcript = transcriptOf(script, { start: extra.start, language: extra.language });
  const { issues } = detectTakeIssues({
    transcript,
    silence: extra.silence ?? null,
    shots: extra.shots ?? null,
  });
  return { transcript, issues };
}

/** The words an issue covers, as text. */
function said(transcript: TranscriptArtifact, issue: TakeIssue): string {
  return transcript.words
    .filter((word) => word.start >= issue.start - 1e-9 && word.end <= issue.end + 1e-9)
    .map((word) => word.text)
    .join(" ");
}

function kinds(issues: TakeIssue[]) {
  return issues.map((issue) => issue.kind);
}

describe("restart cues", () => {
  it("cuts the cue and the abandoned sentence when the next sentence says it again", () => {
    const { transcript, issues } = detect(
      "Welcome to the show and today we are going to talk about cats. |0.5 Sorry let me start over. |0.7 Welcome to the show and today we will talk about cats and dogs.",
    );
    expect(kinds(issues)).toEqual(["retake", "restart_cue"]);
    const [retake, cue] = issues;
    expect(retake).toMatchObject({ action: "cut", sentences: ["s1", "s3"], keep: "s3" });
    expect(said(transcript, retake as TakeIssue)).toMatch(/^Welcome to the show.*cats\.$/);
    expect(cue).toMatchObject({ action: "cut", sentences: ["s2"], keep: "s3" });
    expect(said(transcript, cue as TakeIssue)).toBe("Sorry let me start over.");
    expect(retake?.note).toContain("s1 is said again as s3");
    expect(retake?.confidence).toBeGreaterThan(0.5);
  });

  it("recognizes a Russian cue", () => {
    const { transcript, issues } = detect(
      "Всем привет и добро пожаловать на наш канал про кошек. |0.5 Давай заново. |0.7 Всем привет и добро пожаловать на наш канал про кошек и собак.",
      { language: "ru" },
    );
    expect(kinds(issues)).toEqual(["retake", "restart_cue"]);
    expect(said(transcript, issues[1] as TakeIssue)).toBe("Давай заново.");
    expect(issues[0]).toMatchObject({ action: "cut", keep: "s3" });
  });

  it("takes the fragment before the cue as the attempt when the cue is mid-sentence", () => {
    const { transcript, issues } = detect(
      "Today we are going to, let me start over, today we are going to discuss cats.",
    );
    expect(kinds(issues)).toEqual(["retake", "restart_cue"]);
    expect(said(transcript, issues[0] as TakeIssue)).toBe("Today we are going to,");
    expect(said(transcript, issues[1] as TakeIssue)).toBe("let me start over,");
    expect(issues[0]?.sentences).toEqual(["s1"]);
  });

  it("keeps a strong cue that has no matching new attempt, cut on its own", () => {
    const { transcript, issues } = detect(
      "The price is fine. Scratch that. Next topic is shipping.",
    );
    expect(kinds(issues)).toEqual(["restart_cue"]);
    expect(said(transcript, issues[0] as TakeIssue)).toBe("Scratch that.");
    expect(issues[0]?.keep).toBeNull();
  });

  it("only counts weak cues when the previous sentence is really said again", () => {
    const corroborated = detect(
      "We meet on Friday at noon. |0.5 One more time. |0.6 We meet on Friday at noon in the lobby.",
    );
    expect(kinds(corroborated.issues)).toEqual(["retake", "restart_cue"]);
    expect(corroborated.issues[1]?.confidence).toBeLessThan(0.9);

    expect(detect("Let me show you one more time how it works.").issues).toEqual([]);
    expect(
      detect("Расскажу сначала про цены. Потом про доставку.", { language: "ru" }).issues,
    ).toEqual([]);
    expect(detect("Okay so sorry, let me explain the plan properly.").issues).toEqual([]);
  });

  it("takes 'sorry, let me start over' as one cue with its lead-in", () => {
    const { transcript, issues } = detect(
      "The engine has four cylinders. |0.4 No no sorry let me start over. |0.6 The engine has four cylinders and a turbo.",
    );
    expect(said(transcript, issues.find((i) => i.kind === "restart_cue") as TakeIssue)).toBe(
      "No no sorry let me start over.",
    );
  });
});

describe("retakes without a cue", () => {
  it("cuts the earlier sentence when the later one repeats it almost verbatim", () => {
    const { transcript, issues } = detect(
      "So the main reason this works is because the pressure stays constant. |1.0 The main reason this works is because the pressure stays constant throughout the whole process.",
    );
    expect(kinds(issues)).toEqual(["retake"]);
    expect(issues[0]).toMatchObject({ action: "cut", sentences: ["s1", "s2"], keep: "s2" });
    expect(issues[0]?.note).toContain("s1 is said again as s2");
    expect(said(transcript, issues[0] as TakeIssue)).toMatch(/^So the main reason.*constant\.$/);
  });

  it("asks for a review when the similarity is only moderate", () => {
    const { issues } = detect(
      "The quick brown fox jumps over the lazy dog today. |1.0 The quick brown fox jumps over a lazy dog yesterday afternoon.",
    );
    expect(kinds(issues)).toEqual(["retake"]);
    expect(issues[0]?.action).toBe("review");
    expect(issues[0]?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(issues[0]?.confidence).toBeLessThan(0.8);
  });

  it("keeps the last of three takes", () => {
    const line = "the new engine is faster and quieter than the old one";
    const { issues } = detect(`${line}. |1.0 ${line}. |1.0 ${line} in every test.`);
    const retakes = issues.filter((issue) => issue.kind === "retake");
    expect(retakes.map((issue) => issue.sentences[0])).toEqual(["s1", "s2"]);
    expect(retakes.map((issue) => issue.keep)).toEqual(["s3", "s3"]);
  });

  it("does not compare sentences of different speakers, or sentences more than 20 s apart", () => {
    const line = "the main reason this works is because the pressure stays constant";
    const far = detect(`${line}. |25 ${line} throughout.`);
    expect(far.issues).toEqual([]);

    const transcript = transcriptOf(`${line}. |0.3 ${line}.`, {
      turns: [
        { speaker: "S1", start: 0, end: 4.3 },
        { speaker: "S2", start: 4.3, end: 10 },
      ],
    });
    expect(detectTakeIssues({ transcript, silence: null, shots: null }).issues).toEqual([]);
  });

  it("does not flag ordinary sentences that share common words", () => {
    const { issues } = detect(
      "I think that we should go there. |0.6 I think that is the right call. |0.6 The team said the team could win the game the way the coach said. |0.6 It is very very good and we had had enough. Really, really!",
    );
    expect(issues).toEqual([]);
  });

  it("does not treat a short emphatic repeat as a retake", () => {
    expect(detect("Yes. |0.5 Yes. |0.5 Thank you. |0.5 Thank you.").issues).toEqual([]);
  });
});

describe("false starts", () => {
  it("cuts a short sentence whose opening starts the next one", () => {
    const { transcript, issues } = detect("We are going to. We are going to build a rocket today.");
    expect(kinds(issues)).toEqual(["false_start"]);
    expect(said(transcript, issues[0] as TakeIssue)).toBe("We are going to.");
    expect(issues[0]).toMatchObject({ action: "cut", sentences: ["s1", "s2"], keep: "s2" });
  });

  it("finds an unfinished fragment followed by a pause inside one sentence", () => {
    const { transcript, issues } = detect("We are going |0.7 we are going to build a rocket.");
    expect(kinds(issues)).toEqual(["false_start"]);
    expect(said(transcript, issues[0] as TakeIssue)).toBe("We are going");
    expect(issues[0]?.sentences).toEqual(["s1"]);
  });

  it("uses the silence map to see a pause the word timestamps hide", () => {
    const stretched = speak("We are going");
    const going = stretched[2];
    if (going) going.end = 1.8;
    const transcript = buildTranscript(
      "media/talk.mp4",
      [...stretched, ...speak("we are going to build a rocket.", { start: 1.85 })],
      "en",
      null,
    );
    const silence: SilenceMap = {
      source: transcript.source,
      thresholdDb: -38,
      minSilence: 0.35,
      silences: [{ start: 1.0, end: 1.8 }],
      silenceSeconds: 0.8,
    };
    const without = detectTakeIssues({ transcript, silence: null, shots: null });
    const withSilence = detectTakeIssues({ transcript, silence, shots: null });
    expect(without.issues.filter((issue) => issue.kind === "false_start")).toEqual([]);
    expect(withSilence.issues.filter((issue) => issue.kind === "false_start")).toHaveLength(1);
  });

  it("leaves a long sentence alone", () => {
    const { issues } = detect(
      "We are going to the store because we need milk and eggs for the cake. We are going to bake it tonight for everyone.",
    );
    expect(issues.filter((issue) => issue.kind === "false_start")).toEqual([]);
  });
});

describe("corrections, stutters and fillers", () => {
  it("marks an in-sentence number correction for review", () => {
    const { transcript, issues } = detect("The launch was in 2019 — no, 2018 for sure.");
    expect(kinds(issues)).toEqual(["retake"]);
    expect(issues[0]).toMatchObject({ action: "review", keep: "s1" });
    expect(said(transcript, issues[0] as TakeIssue)).toBe("2019— no,");
  });

  it("cuts the first copy of a repeated word or two-word phrase", () => {
    const { transcript, issues } = detect(
      "I I think the the problem is real. We are we are ready.",
    );
    expect(issues.map((issue) => [issue.kind, said(transcript, issue)])).toEqual([
      ["stutter", "I"],
      ["stutter", "the"],
      ["stutter", "We are"],
    ]);
    expect(issues.every((issue) => issue.action === "cut" && issue.keep === null)).toBe(true);
  });

  it("cuts all but the last copy of a longer run", () => {
    const { transcript, issues } = detect("It was a a a big day.");
    expect(issues).toHaveLength(1);
    expect(said(transcript, issues[0] as TakeIssue)).toBe("a a");
  });

  it("does not call intentional doubling, grammar or list repeats a stutter", () => {
    const { issues } = detect(
      "It is very very good. I know that that is true. No, no, no. The cat and the dog and the bird had had enough. Sure. Sure.",
    );
    expect(issues).toEqual([]);
  });

  it("cuts filler sounds per word and only flags set-off discourse markers for review", () => {
    const { transcript, issues } = detect(
      "So um we are here. Uh, and hmm that is it, you know, right. I like pizza and I like pasta.",
    );
    const fillers = issues.filter((issue) => issue.kind === "filler");
    expect(fillers.map((issue) => [said(transcript, issue), issue.action])).toEqual([
      ["um", "cut"],
      ["Uh,", "cut"],
      ["hmm", "cut"],
      ["you know,", "review"],
    ]);
    expect(fillers[3]?.confidence).toBeLessThan(0.5);
  });

  it("handles Russian fillers", () => {
    const { transcript, issues } = detect("Ну, это ээ хорошо мм. Я люблю ну кофе.", {
      language: "ru",
    });
    expect(issues.map((issue) => [said(transcript, issue), issue.action])).toEqual([
      ["Ну,", "review"],
      ["ээ", "cut"],
      ["мм.", "cut"],
    ]);
  });

  it("does not report fillers again inside a cut attempt", () => {
    const { issues } = detect("Um we are going to. We are going to build a rocket today.");
    expect(kinds(issues)).toEqual(["false_start"]);
  });
});

describe("picture problems", () => {
  const shots = (problems: ShotMap["problems"]): ShotMap => ({
    source: "media/talk.mp4",
    sceneThreshold: 0.3,
    shots: [{ id: "k1", start: 0, end: 60 }],
    problems,
  });

  it("reports a black or frozen range that speech continues under, and skips silent ones", () => {
    const { issues } = detect(
      "We keep talking while the screen goes dark and then we go on talking.",
      {
        start: 9,
        shots: shots([
          { kind: "black", start: 10, end: 12 },
          { kind: "frozen", start: 50, end: 53 },
        ]),
      },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: "black",
      action: "review",
      start: 10,
      end: 12,
      sentences: ["s1"],
    });
    expect(issues[0]?.note).toContain("speech continues under it");
  });
});

describe("ordering and boundaries", () => {
  it("sorts issues by start, numbers them t1.. and lands every speech cut on word boundaries", () => {
    const { transcript, issues } = detect(
      "Um the launch was in 2019 — no, 2018. |0.8 We are going to. We are going to build a rocket today. The the end.",
    );
    expect(issues.map((issue) => issue.id)).toEqual(issues.map((_, index) => `t${index + 1}`));
    for (let index = 1; index < issues.length; index++)
      expect(issues[index]?.start).toBeGreaterThanOrEqual(issues[index - 1]?.start ?? 0);
    for (const issue of issues) {
      expect(transcript.words.some((word) => word.start === issue.start)).toBe(true);
      expect(transcript.words.some((word) => word.end === issue.end)).toBe(true);
      expect(issue.confidence).toBeGreaterThanOrEqual(0);
      expect(issue.confidence).toBeLessThanOrEqual(1);
    }
    expect(new Set(kinds(issues))).toEqual(new Set(["filler", "retake", "false_start", "stutter"]));
  });
});

describe("restarts inside and across sentences", () => {
  it("cuts the first copy of a phrase the speaker drops, with the filler and cue words between the copies", () => {
    const { transcript, issues } = detect(
      "The very first thing you, ah, sorry, the very first thing you should do is stand in the middle of the room.",
    );
    expect(kinds(issues)).toEqual(["false_start"]);
    expect(said(transcript, issues[0] as TakeIssue)).toBe("The very first thing you, ah, sorry,");
    expect(issues[0]).toMatchObject({ action: "cut", sentences: ["s1"], keep: "s1" });
  });

  it("finds the restart when the copies are in two adjacent sentences", () => {
    const { transcript, issues } = detect(
      "And the ceiling panel goes right above your, um, no. |0.4 And the ceiling panel goes right above your head where you sit.",
    );
    expect(kinds(issues)).toEqual(["false_start"]);
    expect(said(transcript, issues[0] as TakeIssue)).toBe(
      "And the ceiling panel goes right above your, um, no.",
    );
    expect(issues[0]).toMatchObject({ action: "cut", sentences: ["s1", "s2"], keep: "s2" });
  });

  it("does not treat parallel phrasing or a second copy more than 6 s later as a restart", () => {
    expect(
      detect("The more you practice, the more you improve, and the more you enjoy it.").issues,
    ).toEqual([]);
    const late = detect(
      "The very first thing you should do. |7 The very first thing you should do is clap once.",
    );
    expect(late.issues.filter((issue) => issue.kind === "false_start")).toEqual([]);
  });

  it("cuts a broken-off sentence that the next one starts again, whatever its length", () => {
    const { transcript, issues } = detect(
      "The biggest mistake I made was that it turned out to be... |0.4 The biggest mistake I made was mixing only on headphones for two years.",
    );
    expect(kinds(issues)).toEqual(["false_start"]);
    expect(said(transcript, issues[0] as TakeIssue)).toBe(
      "The biggest mistake I made was that it turned out to be...",
    );
    expect(issues[0]).toMatchObject({ action: "cut", sentences: ["s1", "s2"], keep: "s2" });
  });

  it("leaves a finished sentence alone when the next one only begins with the same words", () => {
    const { issues } = detect(
      "The biggest mistake I made was buying gear. |0.4 The biggest mistake I made was mixing only on headphones for two years.",
    );
    expect(issues.filter((issue) => issue.kind === "false_start")).toEqual([]);
  });
});

describe("a correction sentence", () => {
  it("cuts a short 'Sorry, …' sentence and the sentence it takes back, keeping the one after", () => {
    const { transcript, issues } = detect(
      "That record took us about three weeks to mix on the little desktop speakers. |0.4 Sorry, three months. |0.4 It took about three months to mix that record on the little desktop speakers and by the end I knew them.",
    );
    expect(kinds(issues)).toEqual(["retake", "restart_cue"]);
    const [retake, cue] = issues;
    expect(retake).toMatchObject({ action: "cut", keep: "s3", sentences: ["s1", "s2", "s3"] });
    expect(said(transcript, retake as TakeIssue)).toMatch(/^That record took.*speakers\.$/);
    expect(cue).toMatchObject({ action: "cut", keep: "s3", sentences: ["s2"] });
    expect(said(transcript, cue as TakeIssue)).toBe("Sorry, three months.");
  });

  it("recognizes a Russian correction cue", () => {
    const { transcript, issues } = detect(
      "Мы записали альбом за три недели на маленьких колонках. |0.4 Простите, три месяца. |0.4 Мы записали альбом за три месяца на маленьких колонках дома.",
      { language: "ru" },
    );
    expect(kinds(issues)).toEqual(["retake", "restart_cue"]);
    expect(said(transcript, issues[1] as TakeIssue)).toBe("Простите, три месяца.");
    expect(issues[0]).toMatchObject({ action: "cut", keep: "s3" });
  });

  it("leaves a short answer that opens with 'No' or 'Sorry' alone when nothing is said again", () => {
    const { issues } = detect(
      "I like pizza and pasta with extra cheese. |0.4 No, thanks. |0.4 We drove home along the coast road.",
    );
    expect(issues).toEqual([]);
  });

  it("does not take back the sentence of another speaker", () => {
    const line = "Would you like the blue microphone for the studio room";
    const transcript = transcriptOf(`${line}? |0.4 No, thanks. |0.4 ${line} on sale today.`, {
      turns: [
        { speaker: "S1", start: 0, end: 4 },
        { speaker: "S2", start: 4, end: 5.5 },
        { speaker: "S1", start: 5.5, end: 12 },
      ],
    });
    const { issues } = detectTakeIssues({ transcript, silence: null, shots: null });
    expect(issues.filter((issue) => issue.kind === "restart_cue")).toEqual([]);
  });
});

describe("the whole abandoned attempt", () => {
  it("cuts a wrong attempt that the 'start over' cue announces, even when the new one is worded differently", () => {
    const { transcript, issues } = detect(
      "The first upgrade is definitely a more expensive microphone, and then, um, some monitors, and the room maybe. |1.0 Sorry, let me start over. |0.3 The first upgrade is always the room, more treatment, then bass traps.",
    );
    expect(kinds(issues)).toEqual(["retake", "restart_cue"]);
    expect(issues[0]).toMatchObject({ action: "cut", keep: "s3" });
    expect(said(transcript, issues[0] as TakeIssue)).toMatch(
      /^The first upgrade is definitely.*maybe\.$/,
    );
    expect(issues[0]?.note).toContain("abandoned");
  });

  it("widens the cut over the earlier sentences of the same delivery that say the same thing", () => {
    const { transcript, issues } = detect(
      "Thanks for watching everybody, that is all for today's news. |0.3 Here is the fix for a muddy mix, boost the lows. |0.3 The fix for a muddy mix is to boost the low end until it sounds powerful. |0.5 Let me start that again. |0.4 The fix for a muddy mix is to cut, not boost, roll off everything below eighty hertz on the instruments that do not need it.",
    );
    const retake = issues.find((issue) => issue.kind === "retake");
    expect(retake).toMatchObject({ action: "cut", keep: "s5" });
    expect(said(transcript, retake as TakeIssue)).toMatch(/^Here is the fix.*powerful\.$/);
    expect(retake?.sentences).toEqual(["s2", "s3", "s5"]);
  });

  it("does not widen over a pause of a second", () => {
    const { transcript, issues } = detect(
      "Here is the fix for a muddy mix, boost the lows. |1.0 The fix for a muddy mix is to boost the low end until it sounds powerful. |0.5 Let me start that again. |0.4 The fix for a muddy mix is to cut, not boost, roll off everything below eighty hertz.",
    );
    const retake = issues.find((issue) => issue.kind === "retake");
    expect(said(transcript, retake as TakeIssue)).toMatch(/^The fix for a muddy mix is to boost/);
    expect(retake?.sentences).toEqual(["s2", "s4"]);
  });
});

describe("a later take that contains the earlier one", () => {
  it("cuts the earlier sentence when the later one says all of it and adds a clause", () => {
    const { issues } = detect(
      "I bought my first audio interface at the little shop downtown. |1.0 I bought my first audio interface at the little shop downtown, and it cost about a hundred and twenty dollars.",
    );
    expect(kinds(issues)).toEqual(["retake"]);
    expect(issues[0]).toMatchObject({ action: "cut", sentences: ["s1", "s2"], keep: "s2" });
  });
});
