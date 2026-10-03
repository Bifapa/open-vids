import { describe, expect, it, vi } from "vitest";
import { createAgentClient } from "./agentClient";
import { storyOffer, storyOfferPart } from "./agentTestHarness";
import { isAnswerStoryOfferResponse, isStoryOfferPart } from "./storyOfferGuards";

describe("isStoryOfferPart", () => {
  it("accepts an offer in any state, with or without chapter details", () => {
    for (const state of ["pending", "accepted", "declined", "expired"] as const) {
      expect(isStoryOfferPart(storyOfferPart({ state }))).toBe(true);
    }
    expect(isStoryOfferPart(storyOfferPart({ chapters: [{ title: "Only" }] }))).toBe(true);
  });

  it("drops an offer this Studio cannot read instead of crashing the chat on it", () => {
    for (const broken of [
      { state: "mystery" },
      { chapters: [{ summary: "no title" }] },
      { chapters: [{ title: "x", durationSeconds: "12" }] },
      { chapters: "none" },
      { requestedAt: "now" },
    ]) {
      expect(isStoryOfferPart({ ...storyOfferPart(), offer: { ...storyOffer(), ...broken } })).toBe(
        false,
      );
    }
    expect(isStoryOfferPart({ type: "text", id: "t", text: "hi" })).toBe(false);
  });
});

describe("answerStoryOffer", () => {
  it("posts the decision through the agent proxy and reads the offer in its new state", async () => {
    const answered = storyOffer({ state: "accepted", answeredAt: 9 });
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ offer: answered })),
    );
    const client = createAgentClient("my project", { fetchImpl });

    await expect(client.answerStoryOffer("c 1", "t1", "o/1", "accept")).resolves.toEqual({
      offer: answered,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/projects/my%20project/agent/chats/c%201/turns/t1/story-offers/o%2F1");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ decision: "accept" }));
  });

  it("keeps the runtime's conflict code and reports a response without an offer as bad", async () => {
    const conflict = createAgentClient("p", {
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: "story_offer_conflict", message: "no" } }), {
          status: 409,
        }),
    });
    await expect(conflict.answerStoryOffer("c1", "t1", "o", "accept")).rejects.toMatchObject({
      code: "story_offer_conflict",
      status: 409,
    });

    const bad = createAgentClient("p", {
      fetchImpl: async () => new Response(JSON.stringify({ offer: { id: "o" } })),
    });
    await expect(bad.answerStoryOffer("c1", "t1", "o", "decline")).rejects.toMatchObject({
      code: "bad_response",
    });
    expect(isAnswerStoryOfferResponse({})).toBe(false);
  });
});
