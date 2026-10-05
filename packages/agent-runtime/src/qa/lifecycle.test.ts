import { describe, expect, it } from "vitest";
import type { QaCheckRequest, QaSample } from "@hyperframes/agent-protocol";
import { FakeQaHost } from "../testing/qa.js";
import { TurnQa } from "./executor.js";
import { QaToolError } from "./host.js";
import { qaPhaseRefusal } from "./phase.js";

const REQUEST: QaCheckRequest = {
  render: "renders/final.mp4",
  framesPerMinute: 12,
  maxFrames: 24,
};
const SAMPLES: QaSample[] = [{ time: 2, reason: "cut", context: "track 0 clip c1" }];

function open() {
  const host = new FakeQaHost();
  const turn = new AbortController();
  const qa = new TurnQa({ host, turnSignal: turn.signal });
  return { host, turn, qa };
}

const signal = () => new AbortController().signal;

describe("TurnQa", () => {
  it("shutdown cancels a running check, waits until it has stopped, and refuses everything afterwards", async () => {
    const { host, qa } = open();
    host.checkGate = new Promise<void>(() => {});
    let finishCancel = () => {};
    host.cancelDelay = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    const check = qa.check(REQUEST);
    const rejected = check.then(
      () => "resolved",
      (error: unknown) => (error instanceof QaToolError ? error.code : "other"),
    );
    let stopped = false;
    const shutdown = qa.shutdown().then(() => {
      stopped = true;
    });
    for (let turns = 0; turns < 10; turns += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(host.checkCancelled).toBe(1);
    expect(stopped).toBe(false);

    finishCancel();
    await shutdown;
    expect(await rejected).toBe("aborted");
    await expect(qa.check(REQUEST)).rejects.toMatchObject({ code: "aborted" });
    await expect(qa.fingerprint()).rejects.toMatchObject({ code: "aborted" });
    expect(await qa.execute("vision", "inspect_render", { times: [1] }, signal())).toMatchObject({
      isError: true,
      text: expect.stringContaining("QA is closed"),
    });
  });

  it("aborts a call when the turn aborts", async () => {
    const { host, turn, qa } = open();
    host.checkGate = new Promise<void>(() => {});
    const check = qa.check(REQUEST);
    const outcome = check.catch((error: unknown) => error);
    await Promise.resolve();
    turn.abort();
    expect(await outcome).toMatchObject({ code: "aborted" });
    expect(host.checkSignals[0]?.aborted).toBe(true);
  });

  it("gives the review tools to Vision alone and only while a review is open", async () => {
    const { host, qa } = open();
    const inspect = (caller: "vision" | "director" | "editor") =>
      qa.execute(caller, "inspect_render", { times: [1] }, signal());

    expect(await inspect("vision")).toMatchObject({
      isError: true,
      text: expect.stringContaining("works only during a Render QA review"),
    });

    qa.openReview({
      reviewer: "vision",
      pass: 1,
      render: "renders/final.mp4",
      duration: 10,
      samples: SAMPLES,
      maxFrames: 4,
      critiqueRounds: 1,
    });
    expect(await inspect("director")).toMatchObject({
      isError: true,
      text: expect.stringContaining("not available to you"),
    });
    expect(await inspect("editor")).toMatchObject({ isError: true });
    expect(host.frameRequests).toEqual([]);

    const looked = await inspect("vision");
    expect(looked.isError).toBeUndefined();
    expect(looked.images).toHaveLength(1);
    const outcome = qa.closeReview();
    expect(outcome).toMatchObject({ frames: 1, rounds: 1, reported: false, findings: [] });

    // Closed: the tools refuse again, and an unknown tool never reaches the service.
    expect(await inspect("vision")).toMatchObject({ isError: true });
    expect(await qa.execute("vision", "rm_rf", {}, signal())).toMatchObject({
      isError: true,
      text: "Unknown QA tool rm_rf.",
    });
    expect(host.frameRequests).toHaveLength(1);
  });

  it("records findings with the source the runtime gives them, dedupes repeats, and counts an empty report as reported", async () => {
    const { qa } = open();
    qa.openReview({
      reviewer: "vision",
      pass: 2,
      render: "renders/final.mp4",
      duration: 10,
      samples: SAMPLES,
      maxFrames: 4,
      critiqueRounds: 1,
    });
    const finding = {
      kind: "caption_collision",
      severity: "warning",
      start: 3,
      end: 4,
      message: "Caption overlaps the title.",
      fixable: true,
      owner: "motion",
      source: "render",
      check: "blackdetect",
    };
    const first = await qa.execute(
      "vision",
      "report_render_findings",
      { findings: [finding, finding] },
      signal(),
    );
    expect(first.text).toContain("Recorded 1 finding (1 in total)");
    const again = await qa.execute(
      "vision",
      "report_render_findings",
      { findings: [finding] },
      signal(),
    );
    expect(again.text).toContain("Recorded 0 findings (1 in total)");
    const outcome = qa.closeReview();
    expect(outcome.reported).toBe(true);
    expect(outcome.findings).toEqual([
      expect.objectContaining({
        kind: "caption_collision",
        source: "vision",
        check: "vision",
        clipIds: [],
        subject: null,
        suggestion: null,
        owner: "motion",
      }),
    ]);

    qa.openReview({
      reviewer: "vision",
      pass: 3,
      render: "renders/final.mp4",
      duration: 10,
      samples: SAMPLES,
      maxFrames: 4,
      critiqueRounds: 1,
    });
    const empty = await qa.execute("vision", "report_render_findings", { findings: [] }, signal());
    expect(empty.text).toContain("nothing wrong found");
    expect(qa.closeReview()).toMatchObject({ reported: true, findings: [] });
  });

  it("returns a service failure to Vision as a refusal it can read", async () => {
    const { host, qa } = open();
    host.framesError = new QaToolError("failed", "ffmpeg could not seek");
    qa.openReview({
      reviewer: "vision",
      pass: 1,
      render: "renders/final.mp4",
      duration: 10,
      samples: SAMPLES,
      maxFrames: 4,
      critiqueRounds: 2,
    });
    const result = await qa.execute("vision", "inspect_render", { times: [1] }, signal());
    expect(result).toEqual({ text: "failed: ffmpeg could not seek", isError: true });
    // A failed look costs nothing.
    host.framesError = null;
    expect(
      (await qa.execute("vision", "inspect_render", { times: [1, 2, 3, 4] }, signal())).isError,
    ).toBeUndefined();
    expect(qa.closeReview()).toMatchObject({ frames: 4, rounds: 1 });
  });

  it("reserves the frame and round budget before the frames arrive, so parallel looks cannot exceed it", async () => {
    const { host, qa } = open();
    let release = () => {};
    host.framesGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    qa.openReview({
      reviewer: "vision",
      pass: 1,
      render: "renders/final.mp4",
      duration: 30,
      samples: SAMPLES,
      maxFrames: 12,
      critiqueRounds: 1,
    });
    const times = Array.from({ length: 12 }, (_, index) => index + 1);
    const first = qa.execute("vision", "inspect_render", { times }, signal());
    const second = qa.execute("vision", "inspect_render", { times }, signal());
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.isError).toBeUndefined();
    expect(two).toMatchObject({
      isError: true,
      text: expect.stringContaining("Critique rounds used"),
    });
    expect(host.frameRequests).toHaveLength(1);
    expect(qa.closeReview()).toMatchObject({ frames: 12, rounds: 1 });
  });

  it("lets parallel looks share the frame budget and refuses the one that no longer fits", async () => {
    const { host, qa } = open();
    let release = () => {};
    host.framesGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    qa.openReview({
      reviewer: "vision",
      pass: 1,
      render: "renders/final.mp4",
      duration: 30,
      samples: SAMPLES,
      maxFrames: 5,
      critiqueRounds: 3,
    });
    const first = qa.execute("vision", "inspect_render", { times: [1, 2, 3] }, signal());
    const second = qa.execute("vision", "inspect_render", { times: [4, 5, 6] }, signal());
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(one.isError).toBeUndefined();
    expect(two).toMatchObject({ isError: true, text: expect.stringContaining("only 2 of 5") });
    expect(qa.closeReview()).toMatchObject({ frames: 3, rounds: 1 });
  });

  it("opens the review tools to the Director instead of Vision when the Director is the reviewer", async () => {
    const { host, qa } = open();
    qa.openReview({
      reviewer: "director",
      pass: 1,
      render: "renders/final.mp4",
      duration: 10,
      samples: SAMPLES,
      maxFrames: 4,
      critiqueRounds: 1,
    });
    const inspect = (caller: "vision" | "director" | "editor") =>
      qa.execute(caller, "inspect_render", { times: [1] }, signal());
    expect(await inspect("vision")).toMatchObject({
      isError: true,
      text: expect.stringContaining("not available to you"),
    });
    expect(await inspect("editor")).toMatchObject({ isError: true });
    expect(host.frameRequests).toEqual([]);
    expect((await inspect("director")).images).toHaveLength(1);
    expect(qa.closeReview()).toMatchObject({ frames: 1, rounds: 1 });
  });
});

describe("qaPhaseRefusal", () => {
  const CHANGES = [
    "edit_timeline",
    "render_video",
    "build_rough_cut",
    "edit_story",
    "build_story",
    "rebuild_story",
    "import_asset",
    "resolve_missing_asset",
    "delegate",
    "message_agent",
    "jev",
    "record_website",
  ];
  const READS = [
    "inspect_project",
    "inspect_timeline",
    "read_story",
    "read_sources",
    "read_analysis",
    "wait_for_agents",
    "update_plan",
    "cancel_agent",
  ];

  it("closes every tool that changes the project once QA is over, and reading stays open", () => {
    for (const name of CHANGES) expect(qaPhaseRefusal("final", name)).toContain(name);
    for (const name of READS) expect(qaPhaseRefusal("final", name)).toBeNull();
  });

  it("refuses only rendering during a correction, and nothing outside QA", () => {
    expect(qaPhaseRefusal("correction", "render_video")).toContain(
      "refused during a Render QA correction",
    );
    for (const name of [...CHANGES.filter((tool) => tool !== "render_video"), ...READS])
      expect(qaPhaseRefusal("correction", name)).toBeNull();
    for (const name of [...CHANGES, ...READS]) expect(qaPhaseRefusal(null, name)).toBeNull();
  });

  it("closes the website save modes in the final prompt, and leaves reading them open", () => {
    for (const [name, args] of [
      ["read_website", { url: "https://linear.app", save: true }],
      ["get_website_file", { url: "https://linear.app/a.svg", mode: "save" }],
    ] as const) {
      expect(qaPhaseRefusal("final", name, args)).toContain(name);
      expect(qaPhaseRefusal("correction", name, args)).toBeNull();
      expect(qaPhaseRefusal(null, name, args)).toBeNull();
    }
    for (const [name, args] of [
      ["read_website", { url: "https://linear.app" }],
      ["read_website", { url: "https://linear.app", save: false }],
      ["get_website_file", { url: "https://linear.app/a.css", mode: "read" }],
    ] as const) {
      expect(qaPhaseRefusal("final", name, args)).toBeNull();
    }
  });

  it("closes a whitespace-padded save mode in the final prompt", () => {
    for (const mode of ["save ", " save"]) {
      expect(
        qaPhaseRefusal("final", "get_website_file", { url: "https://linear.app/a.svg", mode }),
      ).toContain("get_website_file");
    }
  });
});
