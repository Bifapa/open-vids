import { PROJECT_MANIFEST_LIMITS, type ChatMessage } from "@hyperframes/agent-protocol";
import { describe, expect, it } from "vitest";
import { setImmediate as tick } from "node:timers/promises";
import { ResearchToolError } from "../research/host.js";
import {
  FakeCrossProjectHost,
  manifestFile,
  projectReference,
  userMessage,
} from "../testing/crossProject.js";
import { sampleProvenance } from "../testing/research.js";
import { waitUntil } from "../testing/runtimeFixture.js";
import { TurnCrossProject } from "./executor.js";

const REEL = "aaaaaaaaaaaaaaaa";
const PROMO = "bbbbbbbbbbbbbbbb";

function setup(messages: ChatMessage[], overrides: { turn?: "rebuild" } = {}) {
  const host = new FakeCrossProjectHost();
  host.projects.set(REEL, {
    name: "Summer reel",
    files: [
      manifestFile("renders/final.mp4", "renders", { bytes: 12_400_000 }),
      manifestFile("assets/music/theme.mp3", "music", { license: "CC BY 4.0" }),
      manifestFile("assets/sfx/whoosh.wav", "audio"),
    ],
    story: "1. Opening\n2. Beach",
  });
  host.projects.set(PROMO, {
    name: "Promo",
    files: [manifestFile("assets/logo.png", "images")],
    story: null,
  });
  const turn = new AbortController();
  const executor = new TurnCrossProject({
    host,
    turnId: "turn-1",
    turnSignal: turn.signal,
    enabled: ["editor", "audio"],
    turn: { mode: "normal", action: overrides.turn === "rebuild" ? "rebuild" : null },
    messages: () => messages,
    model: (agent) => (agent === "editor" ? "p/m" : null),
  });
  return { host, executor, turn, messages };
}

const signal = () => new AbortController().signal;

describe("TurnCrossProject access", () => {
  it("refuses a project that was not attached in this chat, without asking Studio anything", async () => {
    const { host, executor } = setup([
      userMessage("use it", [projectReference(REEL, "Summer reel", ["renders"])]),
    ]);
    for (const project of [PROMO, "Promo", "0123456789abcdef"]) {
      const result = await executor.execute(
        "editor",
        "import_from_project",
        { project, files: ["assets/logo.png"] },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not a project the user attached in this chat");
      expect(result.text).toContain(REEL);
    }
    expect(host.manifestRequests).toEqual([]);
    expect(host.importRequests).toEqual([]);
  });

  it("refuses a file of a part the user did not attach, even in an attached project, and sends no import", async () => {
    const { host, executor } = setup([
      userMessage("use the renders", [projectReference(REEL, "Summer reel", ["renders"])]),
    ]);
    const result = await executor.execute(
      "editor",
      "import_from_project",
      { project: REEL, files: ["renders/final.mp4", "assets/music/theme.mp3"] },
      signal(),
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Nothing was copied");
    expect(result.text).toContain('"assets/music/theme.mp3"');
    expect(result.text).not.toContain('"renders/final.mp4"');
    // Studio was only asked about the attached part.
    expect(host.manifestRequests).toEqual([{ key: REEL, parts: ["renders"] }]);
    expect(host.importRequests).toEqual([]);
  });

  it("refuses a path that is nowhere in the manifest and a project with only its story attached", async () => {
    const { host, executor } = setup([
      userMessage("x", [projectReference(REEL, "Summer reel", ["renders", "music"])]),
      userMessage("y", [projectReference(PROMO, "Promo", ["story"])], true),
    ]);
    const missing = await executor.execute(
      "editor",
      "import_from_project",
      { project: "Summer reel", files: ["../../etc/passwd"] },
      signal(),
    );
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("misspelled");
    const storyOnly = await executor.execute(
      "editor",
      "import_from_project",
      { project: PROMO, files: ["assets/logo.png"] },
      signal(),
    );
    expect(storyOnly.isError).toBe(true);
    expect(storyOnly.text).toContain("only the story");
    expect(host.importRequests).toEqual([]);
  });

  it("copies attached files, stamping turn, agent and model itself and dropping what the model sent", async () => {
    const { host, executor } = setup([
      userMessage("music and renders", [
        projectReference(REEL, "Summer reel", ["music", "renders"]),
      ]),
    ]);
    const result = await executor.execute(
      "editor",
      "import_from_project",
      {
        project: "summer-reel",
        files: ["assets/music/theme.mp3", "renders/final.mp4"],
        turnId: "forged",
        agent: "user",
        model: "evil/model",
        projectKey: PROMO,
        requestId: "mine",
      },
      signal(),
    );
    expect(result.isError).toBeUndefined();
    expect(host.importRequests).toEqual([
      {
        projectKey: REEL,
        files: ["assets/music/theme.mp3", "renders/final.mp4"],
        turnId: "turn-1",
        agent: "editor",
        model: "p/m",
      },
    ]);
  });

  it("works for a project attached by steering in the middle of the turn", async () => {
    const messages: ChatMessage[] = [userMessage("start", [])];
    const { executor } = setup(messages);
    const before = await executor.execute(
      "audio",
      "import_from_project",
      { project: REEL, files: ["assets/music/theme.mp3"] },
      signal(),
    );
    expect(before.isError).toBe(true);
    messages.push(
      userMessage("also its music", [projectReference(REEL, "Summer reel", ["music"])], true),
    );
    const after = await executor.execute(
      "audio",
      "import_from_project",
      { project: REEL, files: ["assets/music/theme.mp3"] },
      signal(),
    );
    expect(after.isError).toBeUndefined();
    expect(after.text).toContain("assets/from/Summer reel/assets/music/theme.mp3");
  });

  it("caps the files of one call and rejects malformed arguments before anything is sent", async () => {
    const { host, executor } = setup([
      userMessage("x", [projectReference(REEL, "Summer reel", ["all"])]),
    ]);
    const tooMany = Array.from(
      { length: PROJECT_MANIFEST_LIMITS.importFiles + 1 },
      (_, index) => `renders/${index}.mp4`,
    );
    const capped = await executor.execute(
      "editor",
      "import_from_project",
      { project: REEL, files: tooMany },
      signal(),
    );
    expect(capped.isError).toBe(true);
    expect(capped.text).toContain(`At most ${PROJECT_MANIFEST_LIMITS.importFiles} files per call`);
    for (const args of [
      { project: REEL },
      { project: REEL, files: [] },
      { project: REEL, files: [3] },
      { files: ["renders/final.mp4"] },
      "nonsense",
    ]) {
      const bad = await executor.execute("editor", "import_from_project", args, signal());
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("invalid_request");
    }
    expect(host.manifestRequests).toEqual([]);
    expect(host.importRequests).toEqual([]);
  });

  it("is not available to agents without it, and not in a story rebuild", async () => {
    const attached = [userMessage("x", [projectReference(REEL, "Summer reel", ["renders"])])];
    const { host, executor } = setup(attached);
    for (const caller of ["research", "vision", "jev"] as const) {
      const result = await executor.execute(
        caller,
        "import_from_project",
        { project: REEL, files: ["renders/final.mp4"] },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not available to you");
    }
    const rebuild = setup(attached, { turn: "rebuild" });
    const refused = await rebuild.executor.execute(
      "director",
      "import_from_project",
      { project: REEL, files: ["renders/final.mp4"] },
      signal(),
    );
    expect(refused.isError).toBe(true);
    expect(host.importRequests).toEqual([]);
    expect(rebuild.host.importRequests).toEqual([]);
  });
});

describe("what the model reads after a copy", () => {
  it("lists source → asset with size, license notes, existing files, files with no license record, and the skipped", async () => {
    const { host, executor } = setup([
      userMessage("x", [projectReference(REEL, "Summer reel", ["all"])]),
    ]);
    host.importResult = {
      imported: [
        {
          source: "assets/music/theme.mp3",
          asset: "assets/from/summer-reel/assets/music/theme.mp3",
          bytes: 3_100_000,
          status: "copied",
          provenance: sampleProvenance({
            title: "Theme",
            license: "CC BY 4.0",
            licenseStatus: "attribution",
            attribution: "“Theme” by Jane, CC BY 4.0",
          }),
        },
        {
          source: "renders/final.mp4",
          asset: "assets/from/summer-reel/renders/final.mp4",
          bytes: 12_400_000,
          status: "existing",
          provenance: null,
        },
      ],
      skipped: [{ source: "assets/sfx/whoosh.wav", reason: "too large" }],
    };
    const result = await executor.execute(
      "audio",
      "import_from_project",
      {
        project: REEL,
        files: ["assets/music/theme.mp3", "renders/final.mp4", "assets/sfx/whoosh.wav"],
      },
      signal(),
    );
    expect(result.text).toContain("Copied 2 of 3 files");
    expect(result.text).toContain(
      "assets/music/theme.mp3 → assets/from/summer-reel/assets/music/theme.mp3 (3.1 MB; copied)",
    );
    expect(result.text).toContain("license CC BY 4.0");
    expect(result.text).toContain("Credit line: “Theme” by Jane, CC BY 4.0");
    expect(result.text).toContain("existing: this project already held the same bytes");
    expect(result.text).toContain("NO license record");
    expect(result.text).toContain("assets/sfx/whoosh.wav: too large");
  });

  it("turns Studio's failures into refusals with the service's code", async () => {
    const { host, executor } = setup([
      userMessage("x", [projectReference(REEL, "Summer reel", ["renders"])]),
    ]);
    host.nextManifestError = new ResearchToolError("unknown_project", "The project is gone.");
    const gone = await executor.execute(
      "editor",
      "import_from_project",
      { project: REEL, files: ["renders/final.mp4"] },
      signal(),
    );
    expect(gone).toEqual({ text: "unknown_project: The project is gone.", isError: true });
    host.nextImportError = new ResearchToolError("too_large", "Too big.");
    const big = await executor.execute(
      "editor",
      "import_from_project",
      { project: REEL, files: ["renders/final.mp4"] },
      signal(),
    );
    expect(big.text).toBe("too_large: Too big.");
  });
});

describe("TurnCrossProject shutdown", () => {
  const attached = () => [userMessage("x", [projectReference(REEL, "Summer reel", ["renders"])])];

  it("waits for an import in flight and accepts no call afterwards", async () => {
    const { host, executor } = setup(attached());
    const gate = Promise.withResolvers<void>();
    host.importGate = gate.promise;
    const call = executor.execute(
      "editor",
      "import_from_project",
      { project: REEL, files: ["renders/final.mp4"] },
      signal(),
    );
    await waitUntil(() => host.importRequests.length > 0, "the import to reach Studio");
    let closed = false;
    const closing = executor.shutdown().then((report) => {
      closed = true;
      return report;
    });
    // Nothing can end the import but the gate: a few turns of the event loop show shutdown is still waiting.
    for (let turns = 0; turns < 5; turns += 1) await tick();
    expect(closed).toBe(false);
    gate.resolve();
    await expect(closing).resolves.toEqual({ unsettledWrites: [] });
    await call;
    const late = await executor.execute(
      "editor",
      "import_from_project",
      { project: REEL, files: ["renders/final.mp4"] },
      signal(),
    );
    expect(late.text).toContain("copying from projects is closed");
    expect(host.importRequests).toHaveLength(1);
  });

  it("writes nothing when the turn stops before the import commits", async () => {
    const { host, executor, turn } = setup(attached());
    const gate = Promise.withResolvers<void>();
    host.importGate = gate.promise;
    const call = executor.execute(
      "editor",
      "import_from_project",
      { project: REEL, files: ["renders/final.mp4"] },
      signal(),
    );
    await waitUntil(() => host.importRequests.length > 0, "the import to reach Studio");
    turn.abort();
    gate.resolve();
    const result = await call;
    expect(result.isError).toBe(true);
    expect(result.text).toContain("cancelled");
    expect(host.committed).toEqual([]);
    await expect(executor.shutdown()).resolves.toEqual({ unsettledWrites: [] });
  });

  it("reports an import Studio could not settle, like a research import", async () => {
    const { host, executor } = setup(attached());
    host.nextImportError = new ResearchToolError(
      "write_unsettled",
      "The project import was cancelled but Studio did not say whether it wrote anything.",
    );
    const result = await executor.execute(
      "editor",
      "import_from_project",
      { project: REEL, files: ["renders/final.mp4"] },
      signal(),
    );
    expect(result.isError).toBe(true);
    const { unsettledWrites } = await executor.shutdown();
    expect(unsettledWrites).toHaveLength(1);
    expect(unsettledWrites[0]).toContain("import_from_project");
  });
});
