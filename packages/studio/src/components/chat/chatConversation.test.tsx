// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentApiError } from "../../agent/agentClient";
import type { ChatMessage, ChatState, TurnCheckpoint } from "@hyperframes/agent-protocol";
import {
  ACTIVE,
  assistantMessage,
  chatState,
  runningChatState,
  summary,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import {
  buttonWithText,
  byLabel,
  click,
  mountChat,
  pressKey,
  type,
  unmountChat,
  type Mounted,
} from "./chatTestHarness";

let mounted: Mounted | undefined;

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
});

function open(chat: ChatState, extra: Partial<Parameters<typeof mountChat>[0]> = {}) {
  mounted = mountChat({ view: "chat", chatId: chat.chat.id, chat, ...extra }, { chat });
  return mounted;
}

const textarea = (host: HTMLElement) => host.querySelector<HTMLTextAreaElement>("textarea");

describe("composer", () => {
  it("sends when idle: Send button, Enter submits, Shift+Enter does not", async () => {
    const { host, client, store } = open(chatState());
    expect(byLabel(host, "Send message")).not.toBeNull();
    expect(byLabel(host, "Stop task")).toBeNull();

    const field = textarea(host);
    if (!field) throw new Error("no composer");
    await type(field, "Trim the intro");
    await pressKey(field, "Enter", { shiftKey: true });
    expect(client.startTurn).not.toHaveBeenCalled();

    await pressKey(field, "Enter");
    expect(client.startTurn).toHaveBeenCalledWith("c1", {
      prompt: "Trim the intro",
      editorContext: undefined,
      userLanguage: "en",
      mode: "normal",
    });
    expect(store.getState().drafts.c1).toBe("");
  });

  it("turns Send into Stop while a run is live, and Enter steers that run", async () => {
    const { host, client } = open(runningChatState());
    expect(byLabel(host, "Send message")).toBeNull();
    expect(textarea(host)?.placeholder).toBe("Steer the current task…");

    const field = textarea(host);
    if (!field) throw new Error("no composer");
    await type(field, "Make it shorter");
    await pressKey(field, "Enter");
    expect(client.steerTurn).toHaveBeenCalledWith("c1", "t1", {
      text: "Make it shorter",
      editorContext: undefined,
      userLanguage: "en",
    });
    expect(client.startTurn).not.toHaveBeenCalled();

    await click(byLabel(host, "Stop task"));
    expect(client.abortTurn).toHaveBeenCalledWith("c1", "t1");
  });

  it("explains and disables itself while another chat holds the project", () => {
    const other = { ...ACTIVE, chatId: "c2" };
    const { host } = open(chatState(), {
      activeTurn: other,
      chats: [summary(), summary({ id: "c2", title: "Colour pass" })],
    });
    expect(textarea(host)?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="composer-blocked"]')?.textContent).toContain(
      "“Colour pass” is working on this project",
    );
    expect(byLabel(host, "Send message")?.hasAttribute("disabled")).toBe(true);
  });

  it("shows a failed send inline in plain language and keeps what was typed", async () => {
    const { host, client } = open(chatState());
    client.startTurn.mockRejectedValue(new AgentApiError("model_unavailable", "x", 409));
    const field = textarea(host);
    if (!field) throw new Error("no composer");
    await type(field, "Go");
    await pressKey(field, "Enter");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Pick another model");
    expect(textarea(host)?.value).toBe("Go");
  });
});

describe("messages", () => {
  const withAssistant = (
    parts: Extract<ChatMessage, { role: "assistant" }>["parts"],
    status: "streaming" | "complete" = "streaming",
  ) =>
    chatState({
      chat: summary({ status: status === "streaming" ? "working" : "completed" }),
      messages: [userMessage(), assistantMessage({ parts, status })],
      turns: [turn({ status: status === "streaming" ? "running" : "completed" })],
      lastSeq: 3,
    });

  it("keeps thinking collapsed until it is opened, and says how long it took", async () => {
    const { host } = open(
      withAssistant(
        [
          {
            type: "thinking",
            id: "th",
            text: "SECRET chain of thought",
            done: true,
            startedAt: 1000,
            endedAt: 5000,
          },
        ],
        "complete",
      ),
    );
    expect(host.textContent).not.toContain("SECRET chain of thought");
    const toggle = buttonWithText(host, "Thinking");
    expect(toggle?.textContent).toContain("Thought for 4s");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await click(toggle);
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("SECRET chain of thought");
  });

  it("pulses 'Thinking…' while thinking streams", () => {
    const { host } = open(
      withAssistant([{ type: "thinking", id: "th", text: "hmm", done: false, startedAt: 1 }]),
    );
    const label = buttonWithText(host, "Thinking…");
    expect(label?.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("shows an activity as its product label and only lists targets on request", async () => {
    const { host } = open(
      withAssistant([
        {
          type: "activity",
          id: "a1",
          activity: {
            id: "a1",
            category: "inspect",
            status: "done",
            label: "Read 3 files",
            count: 3,
            targets: ["index.html", "styles/main.css"],
            startedAt: 1,
          },
        },
      ]),
    );
    expect(host.textContent).toContain("Read 3 files");
    expect(host.textContent).not.toContain("main.css");
    await click(
      [...host.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Read 3 files"),
      ),
    );
    expect(host.textContent).toContain("styles/main.css");
  });

  it("renders assistant text as inert: no elements from markup, no javascript: anchors", () => {
    const { host } = open(
      withAssistant(
        [
          {
            type: "text",
            id: "tx",
            text: '<img src=x onerror="window.pwned=1"> [go](javascript:window.pwned=1) [ok](https://example.com)',
          },
        ],
        "complete",
      ),
    );
    expect(host.querySelector("img")).toBeNull();
    const anchors = [...host.querySelectorAll("a")];
    expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual(["https://example.com/"]);
    expect(anchors[0]?.getAttribute("rel")).toContain("noopener");
    expect(host.textContent).toContain('<img src=x onerror="window.pwned=1">');
  });

  it("shows the streaming caret only while the text is being written", () => {
    const streaming = open(withAssistant([{ type: "text", id: "tx", text: "Working on" }]));
    expect(streaming.host.querySelector('[data-testid="streaming-caret"]')).not.toBeNull();
    unmountChat(streaming);
    const done = open(withAssistant([{ type: "text", id: "tx", text: "Done." }], "complete"));
    expect(done.host.querySelector('[data-testid="streaming-caret"]')).toBeNull();
  });

  it("labels an interim text part as a note before render QA and leaves the final report plain", () => {
    const { host } = open(
      withAssistant(
        [
          { type: "text", id: "a", text: "Edited the intro.", interim: true },
          { type: "text", id: "b", text: "All checked: the render is ready." },
        ],
        "complete",
      ),
    );
    const notes = [...host.querySelectorAll('[data-testid="interim-note"]')];
    expect(notes).toHaveLength(1);
    expect(notes[0]?.textContent).toContain("Before render QA");
    expect(notes[0]?.textContent).toContain("Edited the intro.");
    const final = host.textContent?.indexOf("All checked");
    expect(final).toBeGreaterThan(host.textContent?.indexOf("Edited the intro.") ?? Infinity);
    expect(host.textContent?.match(/Before render QA/g)).toHaveLength(1);
  });

  it("marks steering messages and shows unknown references as neutral chips", () => {
    const steer: ChatMessage = {
      ...userMessage("m3", "Also add a title"),
      steering: true,
      parts: [
        { type: "text", id: "s", text: "Also add a title" },
        {
          type: "reference",
          id: "r1",
          reference: { id: "r1", kind: "timeline-range", start: 1, end: 2.5 },
        },
        {
          type: "reference",
          id: "r2",
          reference: { id: "r2", kind: "image", source: { type: "project-path", path: "a.png" } },
        },
      ],
    };
    const { host } = open(
      chatState({
        messages: [userMessage(), assistantMessage({ status: "complete" }), steer],
        turns: [turn({ status: "completed" })],
        lastSeq: 4,
      }),
    );
    expect(host.querySelector('[data-testid="steering-tag"]')?.textContent).toBe("Steering");
    expect(host.textContent).toContain("Timeline 1s–2.5s");
    expect(host.textContent).toContain("a.png");
  });
});

describe("scrolling", () => {
  function fakeLayout(
    scroller: HTMLElement,
    layout: { scrollHeight: number; clientHeight: number },
  ) {
    Object.defineProperty(scroller, "scrollHeight", {
      value: layout.scrollHeight,
      configurable: true,
    });
    Object.defineProperty(scroller, "clientHeight", {
      value: layout.clientHeight,
      configurable: true,
    });
  }

  it("stops following the stream when the user scrolls up, and jumps back on request", async () => {
    const { host } = open(runningChatState());
    const scroller = host.querySelector<HTMLElement>('[role="log"]');
    if (!scroller) throw new Error("no message list");
    fakeLayout(scroller, { scrollHeight: 1000, clientHeight: 200 });
    expect(buttonWithText(host, "Jump to latest")).toBeNull();

    scroller.scrollTop = 100;
    await pressScroll(scroller);
    const pill = buttonWithText(host, "Jump to latest");
    expect(pill).not.toBeNull();

    await click(pill);
    expect(scroller.scrollTop).toBe(1000);
    expect(buttonWithText(host, "Jump to latest")).toBeNull();
  });
});

async function pressScroll(element: HTMLElement) {
  // Studio's scroller only reacts to the scroll event; happy-dom does not fire one for scrollTop.
  await act(async () => {
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

describe("turn footer", () => {
  const finished = (
    checkpoint: TurnCheckpoint | null,
    status: "completed" | "failed" = "completed",
  ) =>
    chatState({
      chat: summary({ status: "completed" }),
      messages: [userMessage(), assistantMessage({ status: "complete" })],
      turns: [
        turn({
          status,
          checkpoint,
          ...(status === "failed"
            ? { error: { code: "model_unavailable" as const, message: "raw provider error" } }
            : {}),
        }),
      ],
      lastSeq: 5,
    });
  const ready = (entryIds: string[]): TurnCheckpoint => ({
    status: "ready",
    entryIds,
    createdAt: 1,
  });

  it("offers Revert only for a ready checkpoint that changed something", () => {
    const withChanges = open(finished(ready(["e1"])));
    expect(buttonWithText(withChanges.host, "Revert this turn")).not.toBeNull();
    unmountChat(withChanges);

    const noChanges = open(finished(ready([])));
    expect(buttonWithText(noChanges.host, "Revert this turn")).toBeNull();
    expect(noChanges.host.textContent).toContain("No project changes");
    unmountChat(noChanges);

    // A checkpoint that is still closing has its own row (disabled Revert with the reason); one that was never
    // made offers nothing.
    const unavailable = open(finished({ status: "unavailable", entryIds: [], createdAt: 1 }));
    expect(buttonWithText(unavailable.host, "Revert this turn")).toBeNull();
    unmountChat(unavailable);
  });

  it("shows a reverted turn as Reverted, without a second revert button", () => {
    const { host } = open(finished({ ...ready(["e1"]), status: "reverted", revertedAt: 2 }));
    expect(host.textContent).toContain("Reverted");
    expect(buttonWithText(host, "Revert this turn")).toBeNull();
  });

  it("offers Undo only when the revert can be undone, and puts the turn back through the server", async () => {
    const plain = open(finished({ ...ready(["e1"]), status: "reverted", revertedAt: 2 }));
    expect(byLabel(plain.host, "Undo revert")).toBeNull();
    unmountChat(plain);

    const reverted: TurnCheckpoint = {
      ...ready(["e1"]),
      status: "reverted",
      revertedAt: 2,
      revertEntryIds: ["r1"],
      keptFiles: ["captions.html"],
    };
    const { host, client } = open(finished(reverted));
    expect(host.textContent).toContain("Kept later edits to 1 file");
    client.unrevertTurn.mockResolvedValueOnce({
      ok: true,
      turn: turn({ status: "completed", checkpoint: { ...ready(["e1"]), files: ["index.html"] } }),
    });
    await click(byLabel(host, "Undo revert"));
    expect(client.unrevertTurn).toHaveBeenLastCalledWith("c1", "t1", {});
    expect(buttonWithText(host, "Revert this turn")).not.toBeNull();
    expect(host.querySelector('[data-testid="turn-files"]')?.textContent).toContain(
      "1 file changed",
    );
  });

  it("has no footer while the turn is still running", () => {
    const { host } = open(runningChatState());
    expect(host.querySelector('[data-testid="turn-footer"]')).toBeNull();
  });

  it("locks Revert while another run is active", () => {
    const { host } = open(finished(ready(["e1"])), { activeTurn: { ...ACTIVE, chatId: "c2" } });
    expect(buttonWithText(host, "Revert this turn")?.disabled).toBe(true);
  });

  it("walks through a conflict: files listed, two explicit choices, each with its own mode", async () => {
    const { host, client } = open(finished(ready(["e1"])));
    client.revertTurn.mockResolvedValueOnce({
      ok: false,
      conflict: { files: ["index.html", "styles.css"] },
    });

    await click(buttonWithText(host, "Revert this turn"));
    expect(host.textContent).toContain("index.html");
    expect(host.textContent).toContain("styles.css");
    expect(client.revertTurn).toHaveBeenLastCalledWith("c1", "t1", {});

    client.revertTurn.mockResolvedValueOnce({ ok: false, conflict: { files: ["index.html"] } });
    await click(buttonWithText(host, "Revert untouched files"));
    expect(client.revertTurn).toHaveBeenLastCalledWith("c1", "t1", { mode: "keep-later-edits" });

    await click(buttonWithText(host, "Revert anyway"));
    expect(client.revertTurn).toHaveBeenLastCalledWith("c1", "t1", { mode: "just-this" });
  });

  it("explains a failed turn in plain language, never the raw provider text", () => {
    const { host } = open(finished(ready([]), "failed"));
    const alert = host.querySelector('[data-testid="turn-footer"] [role="alert"]');
    expect(alert?.textContent).toContain("Pick another model");
    expect(host.textContent).not.toContain("raw provider error");
  });
});
