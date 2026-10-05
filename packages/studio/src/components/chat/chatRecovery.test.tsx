// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentErrorCode,
  ChatState,
  TurnSummary,
  UsageTotals,
} from "@hyperframes/agent-protocol";
import { attachmentReference, projectAttachment } from "../../agent/composerAttachments";
import {
  ACTIVE,
  assistantMessage,
  chatState,
  summary,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import { buttonWithText, click, mountChat, unmountChat, type Mounted } from "./chatTestHarness";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
});

function open(chat: ChatState, extra: Partial<Parameters<typeof mountChat>[0]> = {}) {
  mounted = mountChat({ view: "chat", chatId: chat.chat.id, chat, ...extra }, { chat });
  return mounted;
}

const USAGE: UsageTotals = {
  input: 9_000,
  output: 3_400,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12_400,
  cost: 0.08,
};

/** A chat whose newest turn ended `status`, after the user's prompt (with a file) and an answered reply. */
function endedChat(overrides: Partial<TurnSummary> = {}, status: TurnSummary["status"] = "failed") {
  const attached = attachmentReference(projectAttachment({ path: "clips/a.mp4" }));
  const prompt = userMessage("m1", "Trim the intro");
  return chatState({
    chat: summary({ status: status === "failed" ? "failed" : "completed" }),
    messages: [
      attached
        ? {
            ...prompt,
            parts: [...prompt.parts, { type: "reference", id: "r1", reference: attached }],
          }
        : prompt,
      assistantMessage({ status: "complete" }),
    ],
    turns: [turn({ status, endedAt: 9000, checkpoint: null, ...overrides })],
    lastSeq: 5,
  });
}

const failure = (code: AgentErrorCode, message = "raw provider text") =>
  endedChat({ error: { code, message } });

const footer = () => document.body.querySelector('[data-testid="turn-footer"]');

describe("a failed turn", () => {
  it.each<[AgentErrorCode, string]>([
    ["provider_auth", "rejected your credentials"],
    ["rate_limited", "limiting requests"],
    ["provider_overloaded", "is overloaded"],
    ["context_overflow", "no longer fits the model’s context window"],
    ["runtime_restarting", "restarting"],
  ])(
    "says what happened for %s in plain language, keeping the raw text one hover away",
    (code, phrase) => {
      open(failure(code, "429 raw provider text (still failing after 3 retries)"));
      const alert = footer()?.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(phrase);
      expect(alert?.textContent).not.toContain("raw provider text");
      expect(alert?.querySelector("[title]")?.getAttribute("title")).toContain("raw provider text");
    },
  );

  it("puts the way to reconnect next to a rejected-credentials failure", () => {
    const { host } = open(failure("provider_auth"));
    expect(buttonWithText(host, "Connect a model")).not.toBeNull();
    unmountChat(mounted);
    mounted = undefined;
    const other = open(failure("rate_limited"));
    expect(buttonWithText(other.host, "Connect a model")).toBeNull();
  });

  it("retries the turn with the same prompt and files", async () => {
    const { host, client } = open(failure("rate_limited"));
    await click(buttonWithText(host, "Retry this turn"));
    expect(client.startTurn).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledWith("c1", {
      prompt: "Trim the intro",
      references: [expect.objectContaining({ kind: "video", label: "a.mp4" })],
      editorContext: undefined,
      userLanguage: "en",
    });
  });

  it("retries a plan execution as the same plan, and a Story action as the same action", async () => {
    const proposal = turn({
      id: "t0",
      status: "completed",
      promptMessageId: "m0",
      assistantMessageId: "m0r",
      checkpoint: null,
      plan: {
        steps: [{ id: "s1", title: "Cut", status: "pending", agent: null }],
        updatedAt: 1,
        proposal: true,
      },
    });
    const carrying = open(
      chatState({
        chat: summary({ status: "failed" }),
        messages: [
          userMessage("m0", "Plan it", "t0"),
          assistantMessage({ id: "m0r", turnId: "t0", status: "complete" }),
          userMessage("m1", "Carry out the plan", "t1"),
          assistantMessage({ id: "m2", turnId: "t1", status: "complete" }),
        ],
        turns: [
          proposal,
          turn({
            id: "t1",
            status: "failed",
            checkpoint: null,
            executedPlanTurnId: "t0",
            error: { code: "rate_limited", message: "429" },
          }),
        ],
      }),
    );
    await click(buttonWithText(carrying.host, "Retry this turn"));
    expect(carrying.client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ prompt: "Carry out the plan", executePlan: { turnId: "t0" } }),
    );
    unmountChat(mounted);

    const story = open(
      endedChat({
        mode: "story",
        storyAction: "build",
        storyOptions: { chapters: ["ch1"] },
        error: { code: "provider_overloaded", message: "529" },
      }),
    );
    await click(buttonWithText(story.host, "Retry this turn"));
    expect(story.client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        mode: "story",
        storyAction: "build",
        storyOptions: { chapters: ["ch1"] },
      }),
    );
  });

  it("retries the plan the failed turn named, even when a newer proposal sits between them", async () => {
    const plan = {
      steps: [{ id: "s1", title: "Cut", status: "pending" as const, agent: null }],
      updatedAt: 1,
      proposal: true,
    };
    const proposed = (id: string, prompt: string, reply: string) =>
      turn({
        id,
        status: "completed",
        promptMessageId: prompt,
        assistantMessageId: reply,
        checkpoint: null,
        plan,
      });
    const carrying = open(
      chatState({
        chat: summary({ status: "failed" }),
        messages: [
          userMessage("m1", "Plan A", "t1"),
          assistantMessage({ id: "m2", turnId: "t1", status: "complete" }),
          userMessage("m3", "Plan B instead", "t2"),
          assistantMessage({ id: "m4", turnId: "t2", status: "complete" }),
          userMessage("m5", "Carry out the plan", "t3"),
          assistantMessage({ id: "m6", turnId: "t3", status: "complete" }),
        ],
        turns: [
          proposed("t1", "m1", "m2"),
          proposed("t2", "m3", "m4"),
          turn({
            id: "t3",
            status: "failed",
            promptMessageId: "m5",
            assistantMessageId: "m6",
            checkpoint: null,
            executedPlanTurnId: "t1",
            error: { code: "rate_limited", message: "429" },
          }),
        ],
      }),
    );
    await click(buttonWithText(carrying.host, "Retry this turn"));
    expect(carrying.client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ executePlan: { turnId: "t1" } }),
    );
  });

  it("retries a hand-typed 'Carry out the plan' as the plain message it was", async () => {
    const typed = open(
      chatState({
        chat: summary({ status: "failed" }),
        messages: [
          userMessage("m0", "Plan it", "t0"),
          assistantMessage({ id: "m0r", turnId: "t0", status: "complete" }),
          userMessage("m1", "Carry out the plan", "t1"),
          assistantMessage({ id: "m2", turnId: "t1", status: "complete" }),
        ],
        turns: [
          turn({
            id: "t0",
            status: "completed",
            promptMessageId: "m0",
            assistantMessageId: "m0r",
            checkpoint: null,
            plan: {
              steps: [{ id: "s1", title: "Cut", status: "pending", agent: null }],
              updatedAt: 1,
              proposal: true,
            },
          }),
          turn({
            id: "t1",
            status: "failed",
            checkpoint: null,
            error: { code: "rate_limited", message: "429" },
          }),
        ],
      }),
    );
    await click(buttonWithText(typed.host, "Retry this turn"));
    const [, request] = typed.client.startTurn.mock.calls[0] ?? [];
    expect(request?.prompt).toBe("Carry out the plan");
    expect(request).not.toHaveProperty("executePlan");
  });

  it("offers the retry on the newest turn only", () => {
    const older = endedChat({ error: { code: "rate_limited", message: "429" } });
    const newer = {
      ...older,
      messages: [
        ...older.messages,
        userMessage("m3", "Never mind, trim it", "t2"),
        assistantMessage({ id: "m4", turnId: "t2", status: "complete" }),
      ],
      turns: [
        ...older.turns,
        turn({ id: "t2", status: "completed", promptMessageId: "m3", assistantMessageId: "m4" }),
      ],
    };
    const { host } = open(newer);
    expect(buttonWithText(host, "Retry this turn")).toBeNull();
  });

  it("disables the retry with its reason shown while another run is active", async () => {
    const { host, client } = open(failure("rate_limited"), {
      activeTurn: { ...ACTIVE, chatId: "c2" },
    });
    const button = buttonWithText(host, "Retry this turn");
    expect(button?.disabled).toBe(true);
    expect(footer()?.querySelector('[data-testid="blocked-reason"]')?.textContent).toBe(
      "Wait for the agent to finish before retrying.",
    );
    await click(button);
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it("shows a refused retry as the chat's notice", async () => {
    const { host, client } = open(failure("rate_limited"));
    client.startTurn.mockRejectedValueOnce(new Error("offline"));
    await click(buttonWithText(host, "Retry this turn"));
    expect(host.querySelector('[data-testid="chat-composer"] [role="alert"]')).not.toBeNull();
  });
});

describe("usage", () => {
  it("shows what a finished turn used, with the split on hover", () => {
    open(endedChat({ status: "completed", usage: USAGE }, "completed"));
    const line = footer()?.querySelector('[data-testid="turn-usage"]');
    expect(line?.textContent).toContain("Tokens: 12.4K · Cost: $0.08");
    expect(line?.querySelector("[title]")?.getAttribute("title")).toBe(
      "Input 9K · Output 3.4K · Cached 0",
    );
  });

  it("leaves the cost out when the provider reported none, and shows nothing before any usage", () => {
    open(endedChat({ usage: { ...USAGE, cost: null } }, "completed"));
    expect(footer()?.textContent).toContain("Tokens: 12.4K");
    expect(footer()?.textContent).not.toContain("Cost");
    unmountChat(mounted);
    mounted = undefined;

    open(endedChat({}, "completed"));
    expect(footer()?.querySelector('[data-testid="turn-usage"]')).toBeNull();
  });

  it("warns near the end of the context window", () => {
    open(
      endedChat(
        { usage: USAGE, directorContext: { tokens: 170_000, window: 200_000 } },
        "completed",
      ),
    );
    const context = footer()?.querySelector('[data-testid="turn-context"]');
    expect(context?.textContent).toBe("Context 85% (170K of 200K)");
    expect(context?.getAttribute("data-context-high")).toBe("true");
    unmountChat(mounted);
    mounted = undefined;

    open(
      endedChat(
        { usage: USAGE, directorContext: { tokens: 40_000, window: 200_000 } },
        "completed",
      ),
    );
    expect(
      footer()?.querySelector('[data-testid="turn-context"]')?.getAttribute("data-context-high"),
    ).toBeNull();
  });

  it("totals the chat in the header, and says so to screen readers in full", () => {
    const chat = endedChat(
      { usage: USAGE, directorContext: { tokens: 100_000, window: 200_000 } },
      "completed",
    );
    open({ ...chat, chat: { ...chat.chat, usage: { ...USAGE, totalTokens: 31_000, cost: 0.4 } } });
    const total = document.body.querySelector('[data-testid="chat-usage"]');
    expect(total?.textContent).toContain("31K · $0.40");
    expect(total?.textContent).toContain("Context 50%");
    expect(total?.textContent).toContain("Tokens: 31K · Cost: $0.40");
  });
});

describe("inline reasons", () => {
  it("says in words why Revert is disabled, not only in a tooltip", () => {
    const chat = endedChat(
      { checkpoint: { status: "ready", entryIds: ["e1"], createdAt: 1 } },
      "completed",
    );
    open(chat, { activeTurn: { ...ACTIVE, chatId: "c2" } });
    expect(buttonWithText(document.body, "Revert this turn")?.disabled).toBe(true);
    expect(footer()?.querySelector('[data-testid="blocked-reason"]')?.textContent).toBe(
      "Wait for the agent to finish before reverting.",
    );
  });

  it("says why Undo is disabled while another run is active", () => {
    const chat = endedChat(
      {
        checkpoint: {
          status: "reverted",
          entryIds: ["e1"],
          createdAt: 1,
          revertedAt: 2,
          revertEntryIds: ["r1"],
        },
      },
      "completed",
    );
    open(chat, { activeTurn: ACTIVE });
    expect(footer()?.querySelector('[data-testid="blocked-reason"]')?.textContent).toContain(
      "Wait for the agent",
    );
  });
});

describe("the model list", () => {
  it("warns above the composer when the list could not be loaded, and Retry reads it again", async () => {
    const { host, client, store } = open(chatState(), { models: null, modelsFailed: true });
    expect(host.querySelector('[data-testid="composer-models-failed"]')?.textContent).toContain(
      "Couldn’t load the model list",
    );
    await click(
      buttonWithText(host.querySelector('[data-testid="composer-models-failed"]') ?? host, "Retry"),
    );
    expect(client.listModels).toHaveBeenCalled();
    expect(store.getState().modelsFailed).toBe(false);
    expect(host.querySelector('[data-testid="composer-models-failed"]')).toBeNull();
  });
});

describe("files that were not imported", () => {
  it("names them in a notice when the message goes out without them", async () => {
    const { store, host } = open(chatState());
    store.setState({
      drafts: { c1: "Use this" },
      attachments: {
        c1: [{ id: "a1", name: "cat.png", kind: "image", status: "failed", path: null }],
      },
    });
    await store.getState().send();
    expect(store.getState().notice?.message).toBe(
      "cat.png was not imported and was not sent with your message.",
    );
    expect(store.getState().attachments.c1).toEqual([]);
    expect(
      host.querySelector('[data-testid="chat-composer"] [role="alert"]')?.textContent,
    ).toContain("cat.png was not imported");
  });

  it("stays quiet when every file went along", async () => {
    const { store } = open(chatState());
    store.setState({
      drafts: { c1: "Use this" },
      attachments: { c1: [projectAttachment({ path: "clips/a.mp4" })] },
    });
    await store.getState().send();
    expect(store.getState().notice).toBeNull();
  });
});
