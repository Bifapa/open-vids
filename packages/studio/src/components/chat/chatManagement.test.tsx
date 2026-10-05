// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatState,
  ChatSummary,
  PermissionRequest,
  QuestionPart,
} from "@hyperframes/agent-protocol";
import { AgentApiError } from "../../agent/agentClient";
import { isProjectEvent } from "../../agent/agentStoreParsing";
import { projectAttachment } from "../../agent/composerAttachments";
import { mentionToken } from "../../agent/composerMentions";
import {
  agentRun,
  assistantMessage,
  chatState,
  permissionPart,
  qaPass,
  questionPart,
  runReply,
  runningChatState,
  summary,
  taskMessage,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import {
  buttonWithText,
  click,
  mountChat,
  type,
  unmountChat,
  type Mounted,
} from "./chatTestHarness";
import { chatSites } from "./LinkedSitesDialog";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
});

function open(chat: ChatState, extra: Partial<Parameters<typeof mountChat>[0]> = {}) {
  mounted = mountChat({ view: "chat", chatId: chat.chat.id, chat, ...extra }, { chat });
  return mounted;
}

const running = (parts: QuestionPart[]) =>
  chatState({
    chat: summary({ status: "working" }),
    messages: [userMessage(), assistantMessage({ parts })],
    turns: [turn()],
    lastSeq: 2,
  });

describe("a question from the agent", () => {
  const card = () => document.body.querySelector('[data-testid="question-card"]');

  it("offers its options as buttons and sends the chosen one", async () => {
    const { host, client } = open(running([questionPart()]));
    expect(card()?.textContent).toContain("Main has a question");
    expect(card()?.textContent).toContain("Which aspect ratio should the video have?");
    await click(buttonWithText(host, "9:16"));
    expect(client.answerQuestion).toHaveBeenCalledWith("c1", "t1", "q1", "9:16");
    expect(card()?.querySelector('[data-testid="question-status"]')?.textContent).toBe(
      "You answered: 9:16",
    );
  });

  it("takes a free-text answer, and keeps a failed one retryable", async () => {
    const { host, client } = open(running([questionPart({ options: [] })]));
    const field = card()?.querySelector("input");
    if (!field) throw new Error("no answer field");
    expect(buttonWithText(host, "Answer")?.disabled).toBe(true);
    await type(field, "Square, for a feed");
    client.answerQuestion.mockRejectedValueOnce(new AgentApiError("network", "offline"));
    await click(buttonWithText(host, "Answer"));
    expect(card()?.querySelector('[data-testid="question-error"]')?.textContent).toContain(
      "Couldn’t send your answer.",
    );
    await click(
      buttonWithText(card()?.querySelector('[data-testid="question-error"]') ?? host, "Try again"),
    );
    expect(client.answerQuestion).toHaveBeenLastCalledWith("c1", "t1", "q1", "Square, for a feed");
    expect(card()?.getAttribute("data-question-state")).toBe("answered");
  });

  it("is a one-line record once expired or answered elsewhere", () => {
    open(running([questionPart({ state: "expired" })]));
    expect(card()?.querySelector('[data-testid="question-status"]')?.textContent).toBe(
      "Not answered: the turn ended first.",
    );
    expect(card()?.querySelector("input")).toBeNull();
  });
});

describe("stopping one run", () => {
  function delegated(status: "running" | "completed") {
    const run = agentRun({ status, ...(status === "completed" ? { endedAt: 4000 } : {}) });
    return chatState({
      chat: summary({ status: "working" }),
      runs: [run],
      messages: [
        userMessage(),
        assistantMessage({ parts: [{ type: "delegation", id: "d1", runId: run.id }] }),
        taskMessage(run, "Trim the intro"),
        runReply(run),
      ],
      turns: [turn()],
      lastSeq: 3,
    });
  }

  it("stops that run only, from its row", async () => {
    const { host, client } = open(delegated("running"));
    await click(host.querySelector('[data-testid="cancel-run"]'));
    expect(client.cancelRun).toHaveBeenCalledWith("c1", "t1", "r1");
    expect(client.abortTurn).not.toHaveBeenCalled();
  });

  it("is offered in the agent's own thread too, and not for a run that ended", async () => {
    const live = open(delegated("running"), { threads: { c1: "editor" } });
    expect(buttonWithText(live.host, "Stop task")).not.toBeNull();
    unmountChat(mounted);
    mounted = undefined;

    const ended = open(delegated("completed"));
    expect(ended.host.querySelector('[data-testid="cancel-run"]')).toBeNull();
  });
});

describe("the chat history", () => {
  const chats = (count: number): ChatSummary[] =>
    Array.from({ length: count }, (_, index) =>
      summary({
        id: `c${index + 1}`,
        title: index === 2 ? "Podcast teaser" : `Chat ${index + 1}`,
        updatedAt: 9000 - index,
        status: index === 0 ? "working" : "idle",
      }),
    );

  it("searches by title once the list is long, and says when nothing matches", async () => {
    const { host } = mountChat({ view: "history", chats: chats(6) });
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search chats"]');
    if (!search) throw new Error("no search field");
    await type(search, "podcast");
    expect([...host.querySelectorAll("ul[aria-label] li")].map((row) => row.textContent)).toEqual([
      expect.stringContaining("Podcast teaser"),
    ]);
    await type(search, "zzz");
    expect(host.querySelector('[data-testid="history-no-match"]')?.textContent).toContain("zzz");
    await click(buttonWithText(host, "Clear search"));
    expect(host.querySelectorAll("ul[aria-label] li").length).toBe(6);
  });

  it("needs no search box for a short list", () => {
    const { host } = mountChat({ view: "history", chats: chats(3) });
    expect(host.querySelector('input[aria-label="Search chats"]')).toBeNull();
  });

  it("keeps the search box while it filters, when deleting chats drops the list below the threshold", async () => {
    const { host, store } = mountChat({ view: "history", chats: chats(5) });
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search chats"]');
    if (!search) throw new Error("no search field");
    await type(search, "teaser");
    await act(async () => store.getState().forgetChat("c5"));
    // Four chats are left, below the box's threshold, but the list is still filtered: the box must stay to clear it.
    expect(host.querySelectorAll("ul[aria-label] li").length).toBe(1);
    expect(host.querySelector('input[aria-label="Search chats"]')).not.toBeNull();
    await type(search, "");
    expect(host.querySelector('input[aria-label="Search chats"]')).toBeNull();
    expect(host.querySelectorAll("ul[aria-label] li").length).toBe(4);
  });

  it("asks before deleting, then removes the chat", async () => {
    const { host, client, store } = mountChat({ view: "history", chats: chats(3) });
    await click(host.querySelector('button[aria-label="Delete chat “Podcast teaser”"]'));
    expect(client.deleteChat).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Delete this chat?");
    await click(document.body.querySelector('[data-testid="confirm-delete-chat"]'));
    expect(client.deleteChat).toHaveBeenCalledWith("c3");
    expect(store.getState().chats.map((chat) => chat.id)).toEqual(["c1", "c2"]);
    expect(document.body.textContent).not.toContain("Delete this chat?");
  });

  it("cannot delete a chat that is working", async () => {
    const { host, client } = mountChat({ view: "history", chats: chats(3) });
    await click(host.querySelector('button[aria-label="Delete chat “Chat 1”"]'));
    expect(document.body.textContent).not.toContain("Delete this chat?");
    expect(client.deleteChat).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with the reason when the runtime refuses", async () => {
    const { host, client } = mountChat({ view: "history", chats: chats(3) });
    client.deleteChat.mockRejectedValueOnce(new AgentApiError("chat_busy", "busy", 409));
    await click(host.querySelector('button[aria-label="Delete chat “Chat 2”"]'));
    await click(document.body.querySelector('[data-testid="confirm-delete-chat"]'));
    expect(document.body.querySelector('[data-testid="delete-chat-error"]')?.textContent).toBe(
      "A chat that is working can’t be deleted. Stop it first.",
    );
  });

  it("drops a deleted chat the user has open, and understands the project's chat.deleted event", () => {
    expect(isProjectEvent({ type: "chat.deleted", chatId: "c1" })).toBe(true);
    expect(isProjectEvent({ type: "chat.deleted" })).toBe(false);
    const { store } = open(chatState(), { chats: [summary()] });
    store.getState().forgetChat("c1");
    expect(store.getState().chats).toEqual([]);
    expect(store.getState().view).toBe("history");
    expect(store.getState().chatId).toBeNull();
  });
});

describe("linked sites", () => {
  it("lists the runtime's sites without the ones the user removed", () => {
    expect(
      chatSites({ linkedSites: ["a.com", "b.com"], excludedSites: ["b.com", "c.com"] }),
    ).toEqual({ linked: ["a.com"], excluded: ["b.com", "c.com"] });
    expect(chatSites({})).toEqual({ linked: [], excluded: [] });
  });

  it("sends the new list of removed sites for the open chat", async () => {
    const { store, client } = open(chatState({ chat: summary({ linkedSites: ["a.com"] }) }));
    expect(await store.getState().setExcludedSites(["a.com"])).toEqual({ ok: true });
    expect(client.updateChat).toHaveBeenCalledWith("c1", { excludedSites: ["a.com"] });
    expect(store.getState().chat?.chat.excludedSites).toEqual(["a.com"]);
  });
});

describe("permission cards for a long render and a restricted import", () => {
  const card = () => document.body.querySelector('[data-testid="permission-card"]');
  const buttons = () => [...(card()?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
  const withPermission = (overrides: Partial<PermissionRequest>) =>
    open(
      chatState({
        chat: summary({ status: "working" }),
        messages: [userMessage(), assistantMessage({ parts: [permissionPart(overrides)] })],
        turns: [turn()],
      }),
    );

  it("asks once, with no always: the composition, its length, Render or not", async () => {
    const { client, host } = withPermission({
      kind: "long_render",
      action: "render",
      site: null,
      agent: "director",
      render: { composition: "index.html", seconds: 252 },
    });
    expect(card()?.textContent).toContain("A long render needs your OK");
    expect(card()?.querySelector('[data-testid="permission-sentence"]')?.textContent).toContain(
      "index.html",
    );
    expect(card()?.querySelector('[data-testid="permission-setting"]')).toBeNull();
    expect(buttons()).toEqual(["Render", "Don't render"]);
    await click(buttonWithText(host, "Render"));
    expect(client.answerPermission).toHaveBeenCalledWith("c1", "t1", "perm1", "once");
    expect(card()?.querySelector('[data-testid="permission-status"]')?.textContent).toBe(
      "Rendering allowed",
    );
  });

  it("words a refused long render", async () => {
    const { host } = withPermission({
      kind: "long_render",
      action: "render",
      site: null,
      render: { composition: "index.html", seconds: 252 },
    });
    await click(buttonWithText(host, "Don't render"));
    expect(card()?.querySelector('[data-testid="permission-status"]')?.textContent).toBe(
      "Not rendered",
    );
  });

  it("names the restricted material and its license, once per file", async () => {
    const { client, host } = withPermission({
      kind: "restricted_asset",
      action: "download",
      site: "freesound.org",
      asset: { title: "Rain loop", source: "Freesound", license: "CC BY-NC 4.0" },
    });
    expect(card()?.textContent).toContain("This material has a restricted license");
    expect(card()?.querySelector('[data-testid="permission-sentence"]')?.textContent).toContain(
      "Rain loop",
    );
    expect(card()?.querySelector('[data-testid="permission-license"]')?.textContent).toBe(
      "License: CC BY-NC 4.0",
    );
    expect(buttons()).toEqual(["Import this file", "Don't import"]);
    await click(buttonWithText(host, "Import this file"));
    expect(client.answerPermission).toHaveBeenCalledWith("c1", "t1", "perm1", "once");
  });

  it("tells a website's Allow once covers that site only", () => {
    withPermission({ kind: "read_linked_pages", action: "read", site: "linear.app" });
    expect(buttons()).toEqual(["Allow once", "Turn on", "Don't allow"]);
  });
});

describe("the phase line in the header", () => {
  const phase = () => document.body.querySelector('[data-testid="chat-phase"]')?.textContent;

  it("names the Render QA pass while it runs", () => {
    const base = runningChatState();
    open({
      ...base,
      turns: [
        turn({
          qa: {
            status: "running",
            preset: "balanced",
            passLimit: 2,
            passes: [qaPass({ phase: "rendering", endedAt: undefined })],
            reason: null,
          },
        }),
      ],
    });
    expect(phase()).toBe("Render QA · pass 1/2 · Rendering");
  });

  it("shows the plan step that is running, and just Working when there is no more to say", () => {
    open({
      ...runningChatState(),
      turns: [
        turn({
          plan: {
            steps: [
              { id: "a", title: "Cut the intro", status: "done", agent: null },
              { id: "b", title: "Add captions", status: "running", agent: null },
              { id: "c", title: "Render", status: "pending", agent: null },
            ],
            updatedAt: 1,
          },
        }),
      ],
    });
    expect(phase()).toBe("Step 2 of 3 · Add captions");
    unmountChat(mounted);
    mounted = undefined;

    open(runningChatState());
    expect(phase()).toBe("Working");
  });

  it("shows the progress of a running render or analysis", () => {
    open(
      runningChatState({
        parts: [
          {
            type: "activity",
            id: "act1",
            activity: {
              id: "act1",
              category: "other",
              status: "running",
              label: "Analyzing the media",
              labelCode: "analyzing_media",
              count: 1,
              targets: [],
              progress: 40,
              startedAt: 3500,
            },
          },
        ],
      }),
    );
    expect(phase()).toBe("Analyzing the media · 40%");
  });
});

describe("an @ mention and its chip", () => {
  it("removes the token from the prompt when the chip is removed", () => {
    const { store } = open(chatState());
    const chip = {
      ...projectAttachment({ path: "clips/a.mp4" }),
      mentionToken: mentionToken("clips/a.mp4"),
    };
    store.getState().addAttachments("c1", [chip]);
    store.getState().setDraft("Trim @a.mp4 and add music");
    store.getState().removeAttachment("c1", chip.id);
    expect(store.getState().drafts.c1).toBe("Trim and add music");
  });

  it("drops the chip when the token is deleted from the prompt, and keeps it while it is there", () => {
    const { store } = open(chatState());
    const chip = {
      ...projectAttachment({ path: "clips/a.mp4" }),
      mentionToken: mentionToken("clips/a.mp4"),
    };
    store.getState().addAttachments("c1", [chip]);
    store.getState().setDraft("Trim @a.mp4 ");
    expect(store.getState().attachments.c1).toHaveLength(1);
    store.getState().setDraft("Trim ");
    expect(store.getState().attachments.c1).toEqual([]);
  });

  it("leaves a dragged-in file alone when the text never mentioned it", () => {
    const { store } = open(chatState());
    store.getState().addAttachments("c1", [projectAttachment({ path: "clips/a.mp4" })]);
    store.getState().setDraft("Trim the intro");
    expect(store.getState().attachments.c1).toHaveLength(1);
  });
});
