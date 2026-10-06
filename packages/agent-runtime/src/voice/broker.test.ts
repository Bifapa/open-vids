import { describe, expect, it } from "vitest";
import type { VoicePilotRequest, VoiceSetupRequest } from "@hyperframes/agent-protocol";
import { RuntimeError } from "../errors.js";
import { samplePreset } from "../testing/voice.js";
import { VoiceBroker, type VoicePilotAsk } from "./broker.js";

function broker(options: { failPublish?: boolean } = {}) {
  const setups: VoiceSetupRequest[] = [];
  const pilots: VoicePilotRequest[] = [];
  const lookups: string[] = [];
  let id = 0;
  const instance = new VoiceBroker({
    getPreset: async (presetId) => {
      lookups.push(presetId);
      return presetId === "preset-1" ? samplePreset() : null;
    },
    publishSetup: async (setup) => {
      if (options.failPublish) throw new Error("append failed");
      setups.push(setup);
    },
    publishPilot: async (pilot) => {
      pilots.push(pilot);
    },
    now: () => 1_700_000_000_000 + setups.length + pilots.length,
    ids: () => `v-${++id}`,
  });
  const askSetup = (signal?: AbortSignal) =>
    instance.askSetup(
      { agent: "audio", language: "en-US", sampleText: "Hello.", suggestion: "warm" },
      signal,
    );
  const pilotAsk: VoicePilotAsk = {
    agent: "audio",
    lineId: "l1",
    text: "Hello <sigh>",
    file: "assets/voice/l1.wav",
    start: 0,
    end: 2,
    remainingLines: 3,
    remainingUsdCost: 0.01,
  };
  return {
    setups,
    pilots,
    lookups,
    instance,
    askSetup,
    askPilot: () => instance.askPilot(pilotAsk),
  };
}

const rejection = async (promise: Promise<unknown>): Promise<RuntimeError> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof RuntimeError)) throw new Error("expected a RuntimeError");
  return error;
};

describe("the voice broker: setup cards", () => {
  it("resolves with the chosen preset, named, once the user answers", async () => {
    const { setups, instance, askSetup, lookups } = broker();
    const waiting = askSetup();
    await Promise.resolve();
    expect(setups).toMatchObject([
      {
        id: "v-1",
        agent: "audio",
        language: "en-US",
        sampleText: "Hello.",
        suggestion: "warm",
        state: "pending",
      },
    ]);

    await instance.answerSetup("v-1", { presetId: "preset-1" });
    await expect(waiting).resolves.toMatchObject({
      state: "answered",
      presetId: "preset-1",
      presetName: "Warm narrator",
    });
    expect(lookups).toEqual(["preset-1"]);
    expect(setups.map((setup) => setup.state)).toEqual(["pending", "answered"]);
  });

  it("records a decline", async () => {
    const { instance, askSetup } = broker();
    const waiting = askSetup();
    await Promise.resolve();
    await instance.answerSetup("v-1", { decline: true });
    await expect(waiting).resolves.toMatchObject({ state: "declined" });
  });

  it("refuses a preset that does not exist and keeps the card pending so the user can pick again", async () => {
    const { setups, instance, askSetup } = broker();
    const waiting = askSetup();
    await Promise.resolve();

    const error = await rejection(instance.answerSetup("v-1", { presetId: "ghost" }));
    expect(error).toMatchObject({ code: "invalid_request", status: 400 });
    expect(setups.map((setup) => setup.state)).toEqual(["pending"]);

    await instance.answerSetup("v-1", { presetId: "preset-1" });
    await expect(waiting).resolves.toMatchObject({ state: "answered" });
  });

  it("answers a card that is unknown with invalid_request and one answered already with turn_not_active", async () => {
    const { instance, askSetup } = broker();
    const waiting = askSetup();
    await Promise.resolve();
    expect(await rejection(instance.answerSetup("nope", { decline: true }))).toMatchObject({
      code: "invalid_request",
    });
    await instance.answerSetup("v-1", { decline: true });
    await waiting;
    expect(await rejection(instance.answerSetup("v-1", { decline: true }))).toMatchObject({
      code: "turn_not_active",
      status: 409,
    });
  });

  it("expires every pending card at the turn's end, returns the waiting calls and expires cards asked later at once", async () => {
    const { setups, pilots, instance, askSetup, askPilot } = broker();
    const setup = askSetup();
    const pilot = askPilot();
    await Promise.resolve();

    await instance.expireAll();
    await expect(setup).resolves.toMatchObject({ state: "expired" });
    await expect(pilot).resolves.toMatchObject({ state: "expired" });
    expect(setups.map((entry) => entry.state)).toEqual(["pending", "expired"]);
    expect(pilots.map((entry) => entry.state)).toEqual(["pending", "expired"]);
    // Repeating it is harmless, and a card asked after the end never stays pending.
    await instance.expireAll();
    await expect(askSetup()).resolves.toMatchObject({ state: "expired" });
    expect(setups).toHaveLength(2);
  });

  it("expires only the card whose asking call is cancelled", async () => {
    const { setups, instance, askSetup } = broker();
    const cancel = new AbortController();
    const cancelled = askSetup(cancel.signal);
    const staying = askSetup();
    await Promise.resolve();

    cancel.abort();
    await expect(cancelled).resolves.toMatchObject({ id: "v-1", state: "expired" });
    expect(setups.filter((setup) => setup.state === "expired")).toMatchObject([{ id: "v-1" }]);

    await instance.answerSetup("v-2", { decline: true });
    await expect(staying).resolves.toMatchObject({ id: "v-2", state: "declined" });
  });

  it("fails the asking call when the card cannot be shown in the chat", async () => {
    const { askSetup } = broker({ failPublish: true });
    expect(await rejection(askSetup())).toMatchObject({ code: "runtime_unavailable" });
  });

  it("settles the waiting call with the answer even when the chat cannot show it", async () => {
    let failNext = false;
    const instance = new VoiceBroker({
      getPreset: async () => samplePreset(),
      publishSetup: async () => {
        if (failNext) throw new Error("append failed");
      },
      publishPilot: async () => undefined,
      ids: () => "v-1",
    });
    const waiting = instance.askSetup({
      agent: "director",
      language: null,
      sampleText: "Hi.",
      suggestion: "",
    });
    await Promise.resolve();
    failNext = true;
    await instance.answerSetup("v-1", { presetId: "preset-1" }).catch(() => undefined);
    await expect(waiting).resolves.toMatchObject({ state: "answered" });
  });
});

describe("the voice broker: pilot cards", () => {
  it("resolves approved when the user continues", async () => {
    const { pilots, instance, askPilot } = broker();
    const waiting = askPilot();
    await Promise.resolve();
    expect(pilots).toMatchObject([
      { id: "v-1", lineId: "l1", remainingLines: 3, remainingUsdCost: 0.01, state: "pending" },
    ]);
    await instance.answerPilot("v-1", { decision: "approve" });
    await expect(waiting).resolves.toMatchObject({ state: "approved" });
  });

  it("carries the user's note when they ask for changes", async () => {
    const { instance, askPilot } = broker();
    const waiting = askPilot();
    await Promise.resolve();
    await instance.answerPilot("v-1", { decision: "change", feedback: "slower, please" });
    await expect(waiting).resolves.toMatchObject({ state: "changes", feedback: "slower, please" });
  });

  it("refuses a second answer", async () => {
    const { instance, askPilot } = broker();
    const waiting = askPilot();
    await Promise.resolve();
    await instance.answerPilot("v-1", { decision: "approve" });
    await waiting;
    expect(await rejection(instance.answerPilot("v-1", { decision: "approve" }))).toMatchObject({
      code: "turn_not_active",
    });
  });
});
