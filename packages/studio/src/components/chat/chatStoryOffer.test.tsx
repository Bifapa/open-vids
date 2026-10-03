// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoryOffer, TurnSummary } from "@hyperframes/agent-protocol";
import { AgentApiError } from "../../agent/agentClient";
import {
  ACTIVE,
  assistantMessage,
  chatState,
  storyOfferPart,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import { studioStoryStore } from "../../story/storyContext";
import { sampleGraph, syncReport } from "../../story/storyTestHarness";
import { useDockLayoutStore } from "../dock/dockLayoutStore";
import { buttonWithText, click, mountChat, unmountChat, type Mounted } from "./chatTestHarness";

const fileManager = vi.hoisted((): { value: { fileTree: string[] } | null } => ({ value: null }));
vi.mock("../../contexts/FileManagerContext", () => ({
  useFileManagerContextOptional: () => fileManager.value,
}));

let mounted: Mounted | undefined;
const reload = vi.fn(async () => {});
const originalReload = studioStoryStore.getState().reload;

beforeEach(() => {
  reload.mockClear();
  studioStoryStore.setState({ reload });
});

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
  fileManager.value = null;
  useDockLayoutStore.setState({ pendingWorkspace: null, pendingActivation: null });
  studioStoryStore.setState({
    reload: originalReload,
    projectId: null,
    status: "idle",
    graph: null,
    sync: null,
  });
});

/** A chat whose first reply carries one Story offer; `turns` are the chat's turns (the offer's own ended). */
function open({
  offer = {},
  turns = [turn({ status: "completed" })],
  media = false,
}: {
  offer?: Partial<StoryOffer>;
  turns?: TurnSummary[];
  media?: boolean;
} = {}) {
  const chat = chatState({
    messages: [
      userMessage(),
      assistantMessage({ status: "complete", parts: [storyOfferPart(offer)] }),
    ],
    turns,
  });
  mounted = mountChat(
    {
      view: "chat",
      chatId: "c1",
      chat,
      streamStatus: "open",
      // The project stream reports the running turn the way the runtime does.
      activeTurn: turns.some((entry) => entry.status === "running") ? ACTIVE : null,
    },
    { chat },
    { projectHasMedia: () => media },
  );
  return mounted;
}

/** The story the chat's Build reads: `chapters` chapters, and the sync report a built story would have. */
function loadStory(sync = syncReport({ state: "in_sync" }), chapters = true) {
  const graph = sampleGraph();
  studioStoryStore.setState({
    projectId: "p1",
    status: "ready",
    graph: chapters
      ? graph
      : { ...graph, nodes: graph.nodes.filter((node) => node.kind !== "chapter") },
    sync,
  });
}

const card = () => document.body.querySelector('[data-testid="story-offer-card"]');
const buttons = () => [...(card()?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
const status = () => card()?.querySelector('[data-testid="story-offer-status"]')?.textContent;
const startedTurns = () =>
  (mounted?.client.startTurn.mock.calls ?? []).map(([, request]) => request);

describe("a pending Story offer", () => {
  it("lists the chapters in order with their summary and length, and offers the two answers", () => {
    open();
    const items = [...(card()?.querySelectorAll("ol li") ?? [])].map((li) => li.textContent);
    expect(items).toEqual([
      "1.Rocket launch",
      "2.Carina Nebula — photo from the archive",
      "3.Finale with credits12s",
    ]);
    expect(buttons()).toEqual(["Open in Story", "No, edit right away"]);
  });

  it("keeps the chapters but takes the answers away while a turn runs", () => {
    open({ turns: [turn({ status: "running" })] });
    expect(card()?.querySelectorAll("ol li")).toHaveLength(3);
    expect(buttons()).toEqual([]);
  });

  it("is a quiet line once declined or expired, with no list and no answers", () => {
    open({ offer: { state: "declined" } });
    expect(status()).toBe("No Story — editing right away.");
    expect(card()?.querySelector("ol")).toBeNull();
    expect(buttons()).toEqual([]);
    unmountChat(mounted);

    open({ offer: { state: "expired" } });
    expect(status()).toBe("This offer is no longer available.");
    expect(buttons()).toEqual([]);
  });

  it("is dropped, not rendered, when the offer is not one this Studio understands", () => {
    open({ offer: { state: "mystery" as StoryOffer["state"] } });
    expect(card()).toBeNull();
  });
});

describe("accepting a Story offer", () => {
  it("opens the Story workspace on the reloaded story and starts the Review when the project has media", async () => {
    const { client, host } = open({ media: true });
    await click(buttonWithText(host, "Open in Story"));

    expect(client.answerStoryOffer).toHaveBeenCalledWith("c1", "t1", "offer1", "accept");
    expect(useDockLayoutStore.getState().pendingWorkspace).toBe("story");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(startedTurns()).toEqual([
      expect.objectContaining({ prompt: "Review the story", mode: "story", storyAction: "review" }),
    ]);
    expect(status()).toBe("The chapters are in Story.");
    expect(buttons()).toEqual(["Build the video", "Open Story"]);
  });

  it("starts no Review without media, and says what is missing", async () => {
    fileManager.value = { fileTree: ["index.html", "fonts/Inter.woff2", "renders/old.mp4"] };
    const { client, host } = open({ media: false });
    await click(buttonWithText(host, "Open in Story"));

    expect(useDockLayoutStore.getState().pendingWorkspace).toBe("story");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(card()?.querySelector('[data-testid="story-offer-hint"]')?.textContent).toContain(
      "No footage in the project yet",
    );
  });

  it("does not claim the footage is missing when the project's files can be seen to hold some", async () => {
    fileManager.value = { fileTree: ["index.html", "media/rocket.mp4"] };
    const { host } = open({ media: false });
    await click(buttonWithText(host, "Open in Story"));
    expect(card()?.querySelector('[data-testid="story-offer-hint"]')).toBeNull();
  });

  it("shows a clear error and a way to Story when the story gained chapters meanwhile", async () => {
    const { client, host } = open({ media: true });
    client.answerStoryOffer.mockRejectedValueOnce(
      new AgentApiError("story_offer_conflict", "The story gained chapters", 409),
    );
    await click(buttonWithText(host, "Open in Story"));

    const error = card()?.querySelector('[data-testid="story-offer-error"]');
    expect(error?.textContent).toContain("The story already has chapters");
    expect(useDockLayoutStore.getState().pendingWorkspace).toBeNull();
    expect(client.startTurn).not.toHaveBeenCalled();
    // The offer is still the user's to answer.
    expect(buttons()).toEqual(["Open in Story", "No, edit right away", "Open Story"]);

    await click(buttonWithText(host, "Open Story"));
    expect(useDockLayoutStore.getState().pendingWorkspace).toBe("story");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("retries a failed answer that is not a conflict", async () => {
    const { client, host } = open();
    client.answerStoryOffer.mockRejectedValueOnce(new AgentApiError("network", "offline", 0));
    await click(buttonWithText(host, "Open in Story"));
    expect(card()?.querySelector('[data-testid="story-offer-error"]')?.textContent).toContain(
      "Couldn’t send your answer.",
    );

    await click(buttonWithText(host, "Try again"));
    expect(client.answerStoryOffer).toHaveBeenCalledTimes(2);
    expect(status()).toBe("The chapters are in Story.");
  });
});

describe("declining a Story offer", () => {
  it("sends «Without Story — edit right away» as a plain Edit message in the same chat", async () => {
    const { client, host } = open({ media: true });
    await click(buttonWithText(host, "No, edit right away"));

    expect(client.answerStoryOffer).toHaveBeenCalledWith("c1", "t1", "offer1", "decline");
    expect(client.startTurn).toHaveBeenCalledTimes(1);
    const [chatId, request] = client.startTurn.mock.calls[0] ?? [];
    expect(chatId).toBe("c1");
    expect(request).toMatchObject({ prompt: "Without Story — edit right away" });
    expect(request).not.toHaveProperty("mode");
    expect(request).not.toHaveProperty("storyAction");
    expect(useDockLayoutStore.getState().pendingWorkspace).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(status()).toBe("No Story — editing right away.");
  });
});

describe("Build the video", () => {
  const acceptedCard = { offer: { state: "accepted" as const } };

  it("builds like the Story panel's Build Story: a story-mode build turn, then Chat forward", async () => {
    loadStory();
    const { client, host } = open(acceptedCard);
    await click(buttonWithText(host, "Build the video"));

    expect(client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ prompt: "Build the story", mode: "story", storyAction: "build" }),
    );
    expect(useDockLayoutStore.getState().pendingActivation).toBe("chat");
  });

  it("asks first over a story built and then edited, in a dialog over the chat panel", async () => {
    loadStory(syncReport({ state: "out_of_sync", manualEdits: 2, affected: ["b"] }));
    const { client, host } = open(acceptedCard);
    await click(buttonWithText(host, "Build the video"));

    const dialog = host.querySelector('[data-chat-overlay] > [class*="absolute"] [role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(client.startTurn).not.toHaveBeenCalled();

    await click(buttonWithText(dialog ?? host, "Build everything"));
    expect(client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ storyAction: "build" }),
    );
  });

  it("is off with nothing to build, and while any turn runs", async () => {
    loadStory(syncReport(), false);
    open(acceptedCard);
    expect(buttonWithText(document.body, "Build the video")?.disabled).toBe(true);
    unmountChat(mounted);

    loadStory();
    open({ ...acceptedCard, turns: [turn({ status: "running" })] });
    expect(buttonWithText(document.body, "Build the video")?.disabled).toBe(true);
  });

  describe("under the reply of a Review", () => {
    const review = (overrides: Partial<TurnSummary> = {}) =>
      turn({ status: "completed", storyAction: "review", ...overrides });
    const cta = () => buttonWithText(document.body, "Build the video");
    const openReview = (turns: TurnSummary[]) => {
      const chat = chatState({
        messages: [userMessage(), assistantMessage({ status: "complete" })],
        turns,
      });
      mounted = mountChat({ view: "chat", chatId: "c1", chat, streamStatus: "open" }, { chat });
    };

    it("shows for the chat's latest completed Review once the story has chapters", async () => {
      loadStory();
      openReview([review()]);
      expect(cta()?.disabled).toBe(false);
      await click(cta());
      expect(mounted?.client.startTurn).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ storyAction: "build" }),
      );
    });

    it("stays away for other turns, a story without chapters and a Review that is not the latest turn", () => {
      loadStory();
      openReview([turn({ status: "completed" })]);
      expect(cta()).toBeNull();
      unmountChat(mounted);

      openReview([review({ status: "aborted" })]);
      expect(cta()).toBeNull();
      unmountChat(mounted);

      openReview([review(), turn({ id: "t2", status: "completed" })]);
      expect(cta()).toBeNull();
      unmountChat(mounted);

      loadStory(syncReport(), false);
      openReview([review()]);
      expect(cta()).toBeNull();
    });
  });
});
