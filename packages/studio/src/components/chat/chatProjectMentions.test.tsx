// @vitest-environment happy-dom

import { act } from "react";
import type { ChatState } from "@hyperframes/agent-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as StudioContextModule from "../../contexts/StudioContext";
import {
  assistantMessage,
  chatState,
  runningChatState,
  summary,
  turn,
  userMessage,
} from "../../agent/agentTestHarness";
import { projectMentionAttachment } from "../../agent/composerAttachments";
import { useComposerContextStore } from "../../agent/composerContext";
import { click, mountChat, pressKey, type, unmountChat, type Mounted } from "./chatTestHarness";

vi.mock("../../contexts/StudioContext", async (importOriginal) => ({
  ...(await importOriginal<typeof StudioContextModule>()),
  useStudioShellContextOptional: () => ({ projectId: "demo" }),
}));

const PROJECTS = [
  { key: "k-wedding", name: "Wedding", openedAt: 500 },
  { key: "k-promo", name: "Promo Reel", openedAt: 900 },
];
const PROMO_SUMMARY = {
  key: "k-promo",
  name: "Promo Reel",
  counts: { renders: 3, music: 2, audio: 0, images: 0, video: 4, story: 5 },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The Studio server's cross-project routes, answering for the open project `demo`. */
const server = {
  projects: (): Promise<Response> => Promise.reject(new Error("not set")),
  summary: (): Promise<Response> => Promise.reject(new Error("not set")),
};

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith("/cross-project/projects")) return server.projects();
  if (url.endsWith("/cross-project/projects/k-promo/summary")) return server.summary();
  return json({ error: { code: "unknown_project", message: "no such project" } }, 404);
});

let mounted: Mounted | undefined;

beforeEach(() => {
  server.projects = async () => json({ projects: PROJECTS });
  server.summary = async () => json(PROMO_SUMMARY);
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  unmountChat(mounted);
  mounted = undefined;
  useComposerContextStore.getState().clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

/** The server answers in a task or two; the popup follows. */
async function settle() {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
}

const textarea = (host: HTMLElement) => {
  const field = host.querySelector<HTMLTextAreaElement>("textarea");
  if (!field) throw new Error("no composer");
  return field;
};

/** Types `text` with the caret at its end, as a user does. */
async function typeText(field: HTMLTextAreaElement, text: string) {
  await type(field, text);
  await act(async () => field.setSelectionRange(text.length, text.length));
}

async function open(chat: ChatState = chatState()) {
  mounted = mountChat({ view: "chat", chatId: "c1", chat }, { chat });
  const field = textarea(mounted.host);
  await act(async () => field.focus());
  return { host: mounted.host, field, store: mounted.store, client: mounted.client };
}

const listMenu = (host: HTMLElement) => host.querySelector('[data-testid="composer-project-menu"]');
const partsMenu = (host: HTMLElement) =>
  host.querySelector('[data-testid="composer-project-parts"]');
const options = (host: HTMLElement) =>
  [...host.querySelectorAll('[role="option"]')].map((option) =>
    (option.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
const chipText = (host: HTMLElement) =>
  host.querySelector('[data-testid="composer-attachments"]')?.textContent ?? "";
const confirmButton = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Attach",
  );

describe("# project mentions", () => {
  it("lists the other projects, then their parts with counts, and attaches one chip", async () => {
    const { host, field, client } = await open();

    await typeText(field, "use #");
    await settle();

    expect(fetchMock).toHaveBeenCalledWith("/api/projects/demo/cross-project/projects", {
      signal: expect.any(AbortSignal),
    });
    expect(listMenu(host)?.getAttribute("role")).toBe("listbox");
    expect(options(host)).toEqual(["Promo Reel#promo-reel", "Wedding#wedding"]);
    expect(field.getAttribute("role")).toBe("combobox");
    expect(field.getAttribute("aria-controls")).toBe(listMenu(host)?.id);
    expect(field.getAttribute("aria-activedescendant")).toBe(
      host.querySelector('[role="option"]')?.id,
    );

    await pressKey(field, "Enter");
    await settle();

    // Step 2: every part with its count, the empty ones disabled, nothing to attach yet.
    expect(partsMenu(host)).not.toBeNull();
    expect(options(host)).toEqual([
      "Everything",
      "Renders3 files",
      "Music2 files",
      "Other audio0 files",
      "Images0 files",
      "Video4 files",
      "Story5 chapters",
    ]);
    const disabled = [...host.querySelectorAll('[role="option"][aria-disabled="true"]')].map(
      (option) => option.textContent,
    );
    expect(disabled).toEqual(["Other audio0 files", "Images0 files"]);
    expect(confirmButton(host)?.disabled).toBe(true);
    expect(field.value).toBe("use #");

    await pressKey(field, "ArrowDown");
    await pressKey(field, " ");
    await pressKey(field, "ArrowDown");
    await pressKey(field, " ");
    expect(confirmButton(host)?.disabled).toBe(false);
    await pressKey(field, "Enter");

    expect(field.value).toBe("use #promo-reel ");
    expect(field.selectionStart).toBe(16);
    expect(listMenu(host)).toBeNull();
    expect(partsMenu(host)).toBeNull();
    expect(chipText(host)).toContain("Promo Reel · renders, music");
    expect(client.startTurn).not.toHaveBeenCalled();

    await pressKey(field, "Enter");
    expect(client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        prompt: "use #promo-reel",
        references: [
          {
            id: expect.any(String),
            kind: "project",
            projectKey: "k-promo",
            name: "Promo Reel",
            parts: ["renders", "music"],
          },
        ],
      }),
    );
  });

  it("attaches everything with the All row, and a click does what the keys do", async () => {
    const { host, field, client } = await open();
    await typeText(field, "#pro");
    await settle();

    const row = host.querySelector('[role="option"]');
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await settle();
    const all = host.querySelector('[role="option"]');
    await act(async () => {
      all?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await click(confirmButton(host));

    expect(field.value).toBe("#promo-reel ");
    expect(chipText(host)).toContain("Promo Reel · everything");
    await pressKey(field, "Enter");
    expect(client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        references: [expect.objectContaining({ kind: "project", parts: ["all"] })],
      }),
    );
  });

  it("does not tick a part with nothing in it", async () => {
    const { host, field } = await open();
    await typeText(field, "#");
    await settle();
    await pressKey(field, "Enter");
    await settle();

    // Everything, Renders, Music, Other audio (empty)
    for (let step = 0; step < 3; step += 1) await pressKey(field, "ArrowDown");
    await pressKey(field, " ");

    expect(confirmButton(host)?.disabled).toBe(true);
    await pressKey(field, "Enter");
    expect(chipText(host)).toBe("");
    expect(field.value).toBe("#");
  });

  it("does not pick a project on the Enter that commits an input method composition", async () => {
    const { host, field, client } = await open();
    await typeText(field, "#");
    await settle();

    await pressKey(field, "Enter", { keyCode: 229 });

    expect(listMenu(host)).not.toBeNull();
    expect(partsMenu(host)).toBeNull();
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it("keeps one chip per project: picking it again changes its parts", async () => {
    const { host, field, store } = await open();
    await typeText(field, "#");
    await settle();
    await pressKey(field, "Enter");
    await settle();
    await pressKey(field, " "); // Everything
    await pressKey(field, "Enter");

    await typeText(field, "#promo-reel and #");
    await settle();
    await pressKey(field, "Enter");
    await settle();
    await pressKey(field, "ArrowDown");
    await pressKey(field, " "); // Renders only
    await pressKey(field, "Enter");

    expect(store.getState().attachments.c1).toHaveLength(1);
    expect(chipText(host)).toContain("Promo Reel · renders");
    expect(chipText(host)).not.toContain("everything");
  });

  it("steps back with Escape from the parts, then closes, and the draft stays as typed", async () => {
    const { host, field } = await open();
    await typeText(field, "use #");
    await settle();
    await pressKey(field, "Enter");
    await settle();
    expect(partsMenu(host)).not.toBeNull();

    await pressKey(field, "Escape");
    expect(partsMenu(host)).toBeNull();
    expect(listMenu(host)).not.toBeNull();

    await pressKey(field, "Escape");
    expect(listMenu(host)).toBeNull();
    expect(field.value).toBe("use #");
    expect(field.getAttribute("role")).toBeNull();
  });

  it("ends the checklist when the user types on in the token", async () => {
    const { host, field } = await open();
    await typeText(field, "#pro");
    await settle();
    await pressKey(field, "Enter");
    await settle();
    expect(partsMenu(host)).not.toBeNull();

    await typeText(field, "#prox");
    expect(partsMenu(host)).toBeNull();
    await typeText(field, "#pro");
    expect(partsMenu(host)).toBeNull();
    expect(listMenu(host)).not.toBeNull();
  });

  it("says so inside the checklist when the project cannot be read", async () => {
    server.summary = async () => json({ error: { code: "unknown_project", message: "gone" } }, 404);
    const { host, field } = await open();
    await typeText(field, "#");
    await settle();
    await pressKey(field, "Enter");
    await settle();

    expect(partsMenu(host)).not.toBeNull();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Could not read");
    await pressKey(field, "Enter");
    expect(chipText(host)).toBe("");
    await pressKey(field, "Escape");
    expect(listMenu(host)).not.toBeNull();
  });

  it("drops the chip when its token is deleted, and the token when the chip is removed", async () => {
    const { host, field, store } = await open();
    await typeText(field, "use #");
    await settle();
    await pressKey(field, "Enter");
    await settle();
    await pressKey(field, " ");
    await pressKey(field, "Enter");
    expect(store.getState().attachments.c1).toHaveLength(1);

    await type(field, "use ");
    expect(store.getState().attachments.c1).toEqual([]);

    await typeText(field, "use #");
    await settle();
    await pressKey(field, "Enter");
    await settle();
    await pressKey(field, " ");
    await pressKey(field, "Enter");
    const remove = host.querySelector<HTMLButtonElement>(
      '[data-testid="composer-attachments"] button',
    );
    await click(remove);
    expect(store.getState().drafts.c1).toBe("use ");
    expect(store.getState().attachments.c1).toEqual([]);
  });
});

describe("# that is not a project mention", () => {
  it.each(["#ff0000", "#fff", "#1", "#12", "# Title", "see issue#7 and https://x.dev/#top"])(
    "opens no popup for %s and Enter sends the message",
    async (text) => {
      const { host, field, client } = await open();
      // The list is loaded, so only the query decides.
      await typeText(field, "#");
      await settle();
      expect(listMenu(host)).not.toBeNull();

      await typeText(field, text);
      await settle();
      expect(host.querySelector('[role="listbox"]')).toBeNull();
      expect(field.getAttribute("role")).toBeNull();

      await pressKey(field, "Enter");
      expect(client.startTurn).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ prompt: text }),
      );
    },
  );

  it("renders nothing while the list loads", async () => {
    server.projects = () => new Promise<Response>(() => {});
    const { host, field } = await open();
    await typeText(field, "#");
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(field.getAttribute("role")).toBeNull();
  });

  it.each([
    ["the server fails", async () => json({ error: { code: "x", message: "boom" } }, 500)],
    ["the answer is not a list", async () => json({ nope: true })],
    ["the network is down", () => Promise.reject(new Error("offline"))],
  ])("renders nothing when %s", async (_name, answer) => {
    server.projects = answer;
    const { host, field, client } = await open();
    await typeText(field, "#");
    await settle();
    expect(host.querySelector('[role="listbox"]')).toBeNull();

    await pressKey(field, "Enter");
    expect(client.startTurn).toHaveBeenCalledWith("c1", expect.objectContaining({ prompt: "#" }));
  });

  it("shows what was cached at once when # opens again, and asks the server again", async () => {
    const { host, field } = await open();
    await typeText(field, "#");
    await settle();
    await pressKey(field, "Escape");
    expect(listMenu(host)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await typeText(field, "hello");
    await typeText(field, "hello #");
    // The cached list shows before the server has answered.
    server.projects = () => new Promise<Response>(() => {});
    expect(listMenu(host)).not.toBeNull();
    await settle();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/projects"))).toHaveLength(
      2,
    );
  });

  it("leaves the @ popup as it was", async () => {
    const { host, field } = await open();
    await typeText(field, "@");
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listMenu(host)).toBeNull();
  });
});

describe("a project chip in a running chat and in the thread", () => {
  it("goes out with a steering message too", async () => {
    const { field, store, client } = await open(runningChatState());
    await act(async () => {
      store.getState().attachProject(
        "c1",
        projectMentionAttachment({
          projectKey: "k-promo",
          name: "Promo Reel",
          parts: ["music"],
          mentionToken: "#promo-reel",
        }),
      );
    });
    await typeText(field, "also use #promo-reel for the outro");
    await pressKey(field, "Enter");

    expect(client.steerTurn).toHaveBeenCalledWith(
      "c1",
      expect.any(String),
      expect.objectContaining({
        text: "also use #promo-reel for the outro",
        references: [expect.objectContaining({ kind: "project", projectKey: "k-promo" })],
      }),
    );
  });

  it("shows a sent project reference as a chip with the project and its parts", async () => {
    const prompt = userMessage("m1", "use the music");
    mounted = mountChat({
      view: "chat",
      chatId: "c1",
      chat: chatState({
        chat: summary({ status: "completed" }),
        messages: [
          {
            ...prompt,
            parts: [
              ...prompt.parts,
              {
                type: "reference",
                id: "r1",
                reference: {
                  id: "ref1",
                  kind: "project",
                  projectKey: "k-promo",
                  name: "Promo Reel",
                  parts: ["renders", "music"],
                },
              },
            ],
          },
          assistantMessage({ status: "complete" }),
        ],
        turns: [turn({ status: "completed", endedAt: 9000, checkpoint: null })],
        lastSeq: 3,
      }),
    });
    const chip = mounted.host.querySelector('article[data-role="user"] [role="listitem"]');
    expect(chip?.textContent).toContain("Promo Reel · renders, music");
    expect(chip?.getAttribute("title")).toBe("Promo Reel · renders, music — Project");
  });
});
