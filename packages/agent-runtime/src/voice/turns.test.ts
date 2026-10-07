import { describe, expect, it } from "vitest";
import {
  VOICE_DIALECTS,
  type AssistantPart,
  type PermissionPart,
  type VoicePilotPart,
  type VoiceSetupPart,
} from "@hyperframes/agent-protocol";
import type { HostToolResult } from "../backend.js";
import { FakeVoiceHost, sampleProvider } from "../testing/voice.js";
import { createRuntimeFixture, waitUntil, type RuntimeFixture } from "../testing/runtimeFixture.js";
import { toolNames } from "../testing/usable.js";
import { VoiceToolError } from "./host.js";

const GEMINI = VOICE_DIALECTS["gemini-tts"];
/** A tag in the syntax the dialect does NOT use: the check refuses it. */
const FOREIGN_TAG = GEMINI.tags.syntax === "angle" ? "[sighs]" : "<sigh>";
/** A tag in the dialect's own syntax. */
const OWN_TAG = GEMINI.tags.syntax === "angle" ? "<sigh>" : "[sighs]";

async function setup(options: { voice?: boolean; team?: Array<"audio" | "editor"> } = {}) {
  const voice = new FakeVoiceHost();
  const fixture = await createRuntimeFixture(options.voice === false ? {} : { voice: () => voice });
  // Audio is off by default: the Director inherits generate_voiceover.
  const chat = await fixture.chats.create({}, options.team ?? ["editor"]);
  return { fixture, voice, chat };
}

/** The parts of the turn's main assistant message. */
function partsOf(fixture: RuntimeFixture, chatId: string): AssistantPart[] {
  const state = fixture.chats.get(chatId);
  const turn = state?.turns.at(-1);
  const message = state?.messages.find((entry) => entry.id === turn?.assistantMessageId);
  return message?.role === "assistant" ? message.parts : [];
}

function setupCard(fixture: RuntimeFixture, chatId: string): VoiceSetupPart | undefined {
  return partsOf(fixture, chatId).find(
    (part): part is VoiceSetupPart => part.type === "voice-setup",
  );
}

function pilotCard(fixture: RuntimeFixture, chatId: string): VoicePilotPart | undefined {
  return partsOf(fixture, chatId).find(
    (part): part is VoicePilotPart => part.type === "voice-pilot",
  );
}

function permissionCard(fixture: RuntimeFixture, chatId: string): PermissionPart | undefined {
  return partsOf(fixture, chatId).find(
    (part): part is PermissionPart =>
      part.type === "permission" && part.permission.kind === "voice_generation",
  );
}

async function ended(fixture: RuntimeFixture, chatId: string): Promise<void> {
  await waitUntil(
    () =>
      fixture.chats.get(chatId)?.turns.at(-1)?.status !== "running" &&
      fixture.turns.activeTurn === null,
    "the turn to end",
  );
}

const SCRIPT = [
  { id: "l1", text: "Welcome to the show.", speakerText: `Welcome ${OWN_TAG} to the show.` },
  { id: "l2", text: "Today we talk about voices." },
  { id: "l3", text: "Thanks for listening." },
];

/** The Director's script of a whole flow: choose the voice, then generate; results are collected for the test. */
function directorFlow(
  fixture: RuntimeFixture,
  results: { setup?: HostToolResult; generate?: HostToolResult },
  lines: unknown = SCRIPT,
): void {
  fixture.backend.promptScript = async (_input, session) => {
    if (session.input.agent !== "director" || results.setup) return "completed";
    results.setup = await session.callTool("request_voice_setup", {
      language: "en-US",
      sampleText: "Welcome to the show.",
      suggestion: "warm, calm",
    });
    if (results.setup.isError) return "completed";
    results.generate = await session.callTool("generate_voiceover", { lines });
    return "completed";
  };
}

describe("a voiceover turn", () => {
  it("chooses the voice, asks the cost, plays the pilot and generates the rest, then lists where each line is", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      const results: { setup?: HostToolResult; generate?: HostToolResult } = {};
      directorFlow(fixture, results);
      const turn = await fixture.turns.start(chat.id, { prompt: "Add a narration" });

      // 1. The voice card: the user picks a saved voice.
      await waitUntil(
        () => setupCard(fixture, chat.id)?.setup.state === "pending",
        "the voice card",
      );
      const card = setupCard(fixture, chat.id);
      expect(card?.setup).toMatchObject({
        agent: "director",
        language: "en-US",
        sampleText: "Welcome to the show.",
        suggestion: "warm, calm",
      });
      const answered = await fixture.turns.answerVoiceSetup(chat.id, turn.id, card?.id ?? "", {
        presetId: "preset-1",
      });
      expect(answered.setup).toMatchObject({
        state: "answered",
        presetId: "preset-1",
        presetName: "Warm narrator",
      });
      // The script takes the language the agent named, so the catalog and the providers get it.
      await waitUntil(() => voice.language === "en-US", "the script language");

      // 2. The permission card carries the estimate; nothing was generated yet.
      await waitUntil(
        () => permissionCard(fixture, chat.id)?.permission.state === "pending",
        "the cost card",
      );
      expect(voice.callsOf("synthesize")).toEqual([]);
      const permission = permissionCard(fixture, chat.id);
      expect(permission?.permission).toMatchObject({
        kind: "voice_generation",
        action: "render",
        agent: "director",
        voice: { provider: "gemini", model: "gemini-3.8-flash-tts", lines: 3, seconds: 8 },
      });
      expect(permission?.permission.voice?.usdCost).toBeCloseTo(0.006);
      expect(
        (await fixture.turns.answerPermission(chat.id, turn.id, permission?.id ?? "", "once"))
          .permission.state,
      ).toBe("allowed_once");
      // "Always" is not offered for it.
      // 3. The pilot: only the first line was generated and it is on the card.
      await waitUntil(
        () => pilotCard(fixture, chat.id)?.pilot.state === "pending",
        "the pilot card",
      );
      expect(voice.callsOf("synthesize")).toMatchObject([{ lineIds: ["l1"], agent: "director" }]);
      const pilot = pilotCard(fixture, chat.id);
      expect(pilot?.pilot).toMatchObject({
        agent: "director",
        lineId: "l1",
        text: `Welcome ${OWN_TAG} to the show.`,
        file: "assets/voice/l1-abcd1234.wav",
        start: 0,
        end: 2.5,
        remainingLines: 2,
      });
      expect(pilot?.pilot.remainingUsdCost).toBeCloseTo(0.004);
      await fixture.turns.answerVoicePilot(chat.id, turn.id, pilot?.id ?? "", {
        decision: "approve",
      });

      // 4. The rest is generated in the same call, and the result says where everything is.
      await ended(fixture, chat.id);
      expect(voice.callsOf("synthesize")).toMatchObject([
        { lineIds: ["l1"] },
        { lineIds: ["l2", "l3"], agent: "director", turnId: turn.id },
      ]);
      const text = results.generate?.text ?? "";
      expect(results.generate?.isError).not.toBe(true);
      expect(text).toContain("Voiceover ready: 3 lines generated");
      expect(text).toContain(
        'l1 "Welcome to the show.": assets/voice/l1-abcd1234.wav, 0.00–2.50 s',
      );
      expect(text).toContain('l3 "Thanks for listening."');
      expect(text).toContain("edit_timeline add_clip");
      expect(text).toContain("voiceLine");
      expect(text).toContain("duck_audio");
      expect(text).toContain("cost about $0.0060");

      // The setup answer set the project's voice and carried the dialect to the agent.
      expect(voice.callsOf("setProjectVoice")).toEqual(["preset-1"]);
      expect(results.setup?.text).toContain('The user chose the voice "Warm narrator"');
      expect(results.setup?.text).toContain("Voice dialect: ");
      expect(results.setup?.text).toContain("call generate_voiceover");

      // All three cards stay in the message, in their final states.
      expect(setupCard(fixture, chat.id)?.setup.state).toBe("answered");
      expect(permissionCard(fixture, chat.id)?.permission.state).toBe("allowed_once");
      expect(pilotCard(fixture, chat.id)?.pilot.state).toBe("approved");
    } finally {
      await fixture.cleanup();
    }
  });

  it("appends the user's own rules for the provider to the dialect the agent gets", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      voice.providerList = [sampleProvider({ agentRules: "Never use sound tags." })];
      const results: { setup?: HostToolResult } = {};
      directorFlow(fixture, results);
      const turn = await fixture.turns.start(chat.id, { prompt: "Add a narration" });
      await waitUntil(
        () => setupCard(fixture, chat.id)?.setup.state === "pending",
        "the voice card",
      );
      await fixture.turns.answerVoiceSetup(
        chat.id,
        turn.id,
        setupCard(fixture, chat.id)?.id ?? "",
        {
          presetId: "preset-1",
        },
      );
      await waitUntil(
        () => permissionCard(fixture, chat.id)?.permission.state === "pending",
        "the cost card",
      );
      await fixture.turns.answerPermission(
        chat.id,
        turn.id,
        permissionCard(fixture, chat.id)?.id ?? "",
        "deny",
      );
      await ended(fixture, chat.id);
      expect(results.setup?.text).toContain("The user's rules for this provider");
      expect(results.setup?.text).toContain("Never use sound tags.");
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns the dialect's problems to the agent, with nothing paid, asked or generated", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      voice.voice = voice.presetList[0] ?? null;
      const results: { setup?: HostToolResult; generate?: HostToolResult } = {};
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent !== "director" || results.generate) return "completed";
        results.generate = await session.callTool("generate_voiceover", {
          lines: [
            { id: "l1", text: "Hello.", speakerText: `Hello ${FOREIGN_TAG} there.` },
            { id: "l2", text: "Fine line." },
          ],
        });
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Narrate this" });
      await ended(fixture, chat.id);

      expect(results.generate?.isError).toBe(true);
      const text = results.generate?.text ?? "";
      expect(text).toContain("NOTHING was generated or paid");
      expect(text).toContain("line l1 [error] foreign_tag_syntax");
      expect(text).toContain("Voice dialect: ");
      expect(voice.callsOf("synthesize")).toEqual([]);
      expect(permissionCard(fixture, chat.id)).toBeUndefined();
      expect(pilotCard(fixture, chat.id)).toBeUndefined();
      // The script itself was saved, so the agent only fixes the lines.
      expect(voice.lines.map((line) => line.id)).toEqual(["l1", "l2"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("tells the agent there is no voiceover when the user declines to choose a voice", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      const results: { setup?: HostToolResult; generate?: HostToolResult } = {};
      directorFlow(fixture, results);
      const turn = await fixture.turns.start(chat.id, { prompt: "Add a narration" });
      await waitUntil(
        () => setupCard(fixture, chat.id)?.setup.state === "pending",
        "the voice card",
      );
      await fixture.turns.answerVoiceSetup(
        chat.id,
        turn.id,
        setupCard(fixture, chat.id)?.id ?? "",
        {
          decline: true,
        },
      );
      await ended(fixture, chat.id);

      expect(setupCard(fixture, chat.id)?.setup.state).toBe("declined");
      expect(results.setup?.isError).toBe(true);
      expect(results.setup?.text).toContain("no voiceover");
      expect(results.generate).toBeUndefined();
      expect(voice.callsOf("setProjectVoice")).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses a voice that does not exist and lets the user pick again", async () => {
    const { fixture, chat } = await setup();
    try {
      const results: { setup?: HostToolResult } = {};
      directorFlow(fixture, results);
      const turn = await fixture.turns.start(chat.id, { prompt: "Add a narration" });
      await waitUntil(
        () => setupCard(fixture, chat.id)?.setup.state === "pending",
        "the voice card",
      );
      const id = setupCard(fixture, chat.id)?.id ?? "";
      await expect(
        fixture.turns.answerVoiceSetup(chat.id, turn.id, id, { presetId: "ghost" }),
      ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
      expect(setupCard(fixture, chat.id)?.setup.state).toBe("pending");
      await fixture.turns.answerVoiceSetup(chat.id, turn.id, id, { decline: true });
      await ended(fixture, chat.id);
    } finally {
      await fixture.cleanup();
    }
  });

  it("expires the cards and returns the calls when the turn ends before the user answers", async () => {
    const { fixture, chat } = await setup();
    try {
      const results: { setup?: HostToolResult } = {};
      directorFlow(fixture, results);
      const turn = await fixture.turns.start(chat.id, { prompt: "Add a narration" });
      await waitUntil(
        () => setupCard(fixture, chat.id)?.setup.state === "pending",
        "the voice card",
      );
      fixture.turns.abort(chat.id, turn.id);
      await ended(fixture, chat.id);
      expect(setupCard(fixture, chat.id)?.setup.state).toBe("expired");
      expect(results.setup?.isError).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("generates nothing when the user does not allow the cost", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      voice.voice = voice.presetList[0] ?? null;
      const results: { generate?: HostToolResult } = {};
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent !== "director" || results.generate) return "completed";
        results.generate = await session.callTool("generate_voiceover", { lines: SCRIPT });
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Narrate this" });
      await waitUntil(
        () => permissionCard(fixture, chat.id)?.permission.state === "pending",
        "the cost card",
      );
      await fixture.turns.answerPermission(
        chat.id,
        turn.id,
        permissionCard(fixture, chat.id)?.id ?? "",
        "deny",
      );
      await ended(fixture, chat.id);
      expect(results.generate?.isError).toBe(true);
      expect(results.generate?.text).toContain("did not allow generating the voiceover");
      expect(voice.callsOf("synthesize")).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("offers only 'Allow once' for the cost: 'always' is refused", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      voice.voice = voice.presetList[0] ?? null;
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent === "director")
          await session.callTool("generate_voiceover", { lines: SCRIPT });
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Narrate this" });
      await waitUntil(
        () => permissionCard(fixture, chat.id)?.permission.state === "pending",
        "the cost card",
      );
      const id = permissionCard(fixture, chat.id)?.id ?? "";
      await expect(
        fixture.turns.answerPermission(chat.id, turn.id, id, "always"),
      ).rejects.toMatchObject({
        code: "invalid_request",
      });
      await fixture.turns.answerPermission(chat.id, turn.id, id, "deny");
      await ended(fixture, chat.id);
    } finally {
      await fixture.cleanup();
    }
  });

  it("hands the user's note back to the agent when they ask for changes to the pilot, and generates nothing more", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      voice.voice = voice.presetList[0] ?? null;
      const results: { generate?: HostToolResult } = {};
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent !== "director" || results.generate) return "completed";
        results.generate = await session.callTool("generate_voiceover", { lines: SCRIPT });
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Narrate this" });
      await waitUntil(
        () => permissionCard(fixture, chat.id)?.permission.state === "pending",
        "the cost card",
      );
      await fixture.turns.answerPermission(
        chat.id,
        turn.id,
        permissionCard(fixture, chat.id)?.id ?? "",
        "once",
      );
      await waitUntil(
        () => pilotCard(fixture, chat.id)?.pilot.state === "pending",
        "the pilot card",
      );
      await fixture.turns.answerVoicePilot(
        chat.id,
        turn.id,
        pilotCard(fixture, chat.id)?.id ?? "",
        {
          decision: "change",
          feedback: "Slower and warmer, please",
        },
      );
      await ended(fixture, chat.id);

      expect(pilotCard(fixture, chat.id)?.pilot).toMatchObject({
        state: "changes",
        feedback: "Slower and warmer, please",
      });
      expect(results.generate?.isError).not.toBe(true);
      expect(results.generate?.text).toContain("Slower and warmer, please");
      expect(results.generate?.text).toContain("call generate_voiceover again");
      expect(voice.callsOf("synthesize")).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("skips the cost card when every line already has a take, and says so", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      voice.voice = voice.presetList[0] ?? null;
      await voice.saveScript({ lines: SCRIPT.map((line) => ({ ...line })) });
      for (const line of voice.lines)
        await voice.synthesize({ lineIds: [line.id] }, new AbortController().signal);
      voice.calls.length = 0;
      const results: { generate?: HostToolResult } = {};
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent !== "director" || results.generate) return "completed";
        results.generate = await session.callTool("generate_voiceover", {
          lines: SCRIPT.map((line) => ({ ...line })),
        });
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Narrate this" });
      await ended(fixture, chat.id);
      expect(results.generate?.text).toContain("nothing was generated");
      expect(results.generate?.text).toContain("l2");
      expect(voice.callsOf("synthesize")).toEqual([]);
      expect(permissionCard(fixture, chat.id)).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses a generation when the project has no voice yet", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      const results: { generate?: HostToolResult } = {};
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent === "director" && !results.generate)
          results.generate = await session.callTool("generate_voiceover", { lines: SCRIPT });
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Narrate this" });
      await ended(fixture, chat.id);
      expect(results.generate?.isError).toBe(true);
      expect(results.generate?.text).toContain("request_voice_setup first");
      expect(voice.callsOf("check")).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("explains a rejected key, a rate limit with its retry time and an exhausted quota, without retrying", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      voice.voice = voice.presetList[0] ?? null;
      voice.usdPerLine = 0;
      const texts: string[] = [];
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent !== "director" || texts.length > 0) return "completed";
        const lines = [{ id: "l1", text: "One." }];
        voice.failNext("synthesize", new VoiceToolError("invalid_key", "API key not valid"));
        texts.push((await session.callTool("generate_voiceover", { lines })).text);
        voice.failNext(
          "synthesize",
          new VoiceToolError("rate_limited", "429", { retryAfterSeconds: 42 }),
        );
        texts.push((await session.callTool("generate_voiceover", { lines })).text);
        voice.failNext("synthesize", new VoiceToolError("quota_exhausted", "billing"));
        texts.push((await session.callTool("generate_voiceover", { lines })).text);
        voice.failNext(
          "synthesize",
          new VoiceToolError("not_audio", "wrong type", {
            contentType: "text/html",
            body: "<h1>nope</h1>",
          }),
        );
        texts.push((await session.callTool("generate_voiceover", { lines })).text);
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Narrate this" });
      await waitUntil(
        () => permissionCard(fixture, chat.id)?.permission.state === "pending",
        "the cost card",
      );
      await fixture.turns.answerPermission(
        chat.id,
        turn.id,
        permissionCard(fixture, chat.id)?.id ?? "",
        "once",
      );
      await ended(fixture, chat.id);
      expect(texts[0]).toContain("rejected the API key");
      expect(texts[0]).toContain("Settings › Voice");
      expect(texts[1]).toContain("Retry in about 42 seconds");
      expect(texts[2]).toContain("no quota or credit left");
      expect(texts[3]).toContain("not audio");
      expect(texts[3]).toContain("text/html");
      expect(texts[3]).toContain("<h1>nope</h1>");
      expect(voice.callsOf("synthesize")).toHaveLength(4);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the pilot when generating the rest fails and says so", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      voice.voice = voice.presetList[0] ?? null;
      const results: { generate?: HostToolResult } = {};
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent !== "director" || results.generate) return "completed";
        results.generate = await session.callTool("generate_voiceover", { lines: SCRIPT });
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Narrate this" });
      await waitUntil(
        () => permissionCard(fixture, chat.id)?.permission.state === "pending",
        "the cost card",
      );
      await fixture.turns.answerPermission(
        chat.id,
        turn.id,
        permissionCard(fixture, chat.id)?.id ?? "",
        "once",
      );
      await waitUntil(
        () => pilotCard(fixture, chat.id)?.pilot.state === "pending",
        "the pilot card",
      );
      voice.failNext(
        "synthesize",
        new VoiceToolError("rate_limited", "429", { retryAfterSeconds: 9, daily: 1 }),
      );
      await fixture.turns.answerVoicePilot(
        chat.id,
        turn.id,
        pilotCard(fixture, chat.id)?.id ?? "",
        {
          decision: "approve",
        },
      );
      await ended(fixture, chat.id);
      expect(results.generate?.isError).toBe(true);
      expect(results.generate?.text).toContain("The pilot line l1 was generated and kept");
      expect(results.generate?.text).toContain("daily limit");
    } finally {
      await fixture.cleanup();
    }
  });

  it("cancels a running generation when the turn is stopped and waits for the server's answer", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      voice.voice = voice.presetList[0] ?? null;
      const started = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      voice.onSynthesize = async (_request, signal) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        aborted.resolve();
      };
      const results: { generate?: HostToolResult } = {};
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent !== "director" || results.generate) return "completed";
        results.generate = await session.callTool("generate_voiceover", { lines: SCRIPT });
        return "completed";
      };
      const turn = await fixture.turns.start(chat.id, { prompt: "Narrate this" });
      await waitUntil(
        () => permissionCard(fixture, chat.id)?.permission.state === "pending",
        "the cost card",
      );
      await fixture.turns.answerPermission(
        chat.id,
        turn.id,
        permissionCard(fixture, chat.id)?.id ?? "",
        "once",
      );
      await started.promise;
      fixture.turns.abort(chat.id, turn.id);
      await aborted.promise;
      await ended(fixture, chat.id);
      expect(results.generate?.isError).toBe(true);
      expect(results.generate?.text).toContain("cancelled");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("who gets the voice tools in a turn", () => {
  it("gives them to Audio and the Director's setup tool to the Director when Audio is on", async () => {
    const { fixture, chat } = await setup({ team: ["audio"] });
    try {
      let directorTools: string[] = [];
      let audioTools: string[] = [];
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent === "director") {
          directorTools = toolNames(session);
          await session.callTool("delegate", { agent: "audio", title: "Narrate", task: "Narrate" });
          await session.callTool("wait_for_agents", {});
        } else audioTools = toolNames(session);
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Add a narration" });
      await ended(fixture, chat.id);
      expect(directorTools).toContain("request_voice_setup");
      expect(directorTools).not.toContain("generate_voiceover");
      expect(audioTools).toEqual(
        expect.arrayContaining(["request_voice_setup", "generate_voiceover"]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("offers nothing and says nothing about voiceover when the runtime has no voice host", async () => {
    const { fixture, chat } = await setup({ voice: false });
    try {
      let director: string[] = [];
      let prompt = "";
      fixture.backend.promptScript = async (input, session) => {
        if (session.input.agent === "director") {
          director = toolNames(session);
          prompt = session.input.instructions;
          void input;
        }
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "Add a narration" });
      await ended(fixture, chat.id);
      expect(director.filter((name) => name.includes("voice"))).toEqual([]);
      expect(prompt).not.toContain("request_voice_setup");
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses the voice tools in an Ask turn and after a plan proposal", async () => {
    const { fixture, voice, chat } = await setup();
    try {
      voice.voice = voice.presetList[0] ?? null;
      const answers: HostToolResult[] = [];
      fixture.backend.promptScript = async (_input, session) => {
        if (session.input.agent !== "director" || answers.length > 0) return "completed";
        answers.push(await session.callTool("request_voice_setup", { sampleText: "Hello." }));
        answers.push(await session.callTool("generate_voiceover", { lines: SCRIPT }));
        return "completed";
      };
      await fixture.turns.start(chat.id, { prompt: "What would a narration cost?", intent: "ask" });
      await ended(fixture, chat.id);
      expect(answers.map((answer) => answer.isError)).toEqual([true, true]);
      expect(answers[0]?.text).toContain("Ask turn");
      expect(voice.callsOf("saveScript")).toEqual([]);
      expect(setupCard(fixture, chat.id)).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });
});
