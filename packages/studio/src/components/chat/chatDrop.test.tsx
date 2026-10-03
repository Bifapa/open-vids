// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStoreProvider } from "../../agent/agentContext";
import { createAgentStore, type AgentStore } from "../../agent/agentStore";
import {
  CATALOG,
  chatState,
  createFakeClient,
  createSourceLog,
  flush,
  runningChatState,
  type FakeClient,
} from "../../agent/agentTestHarness";
import { useGlobalFileDrop } from "../../hooks/useStudioContextValue";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { AgentChatBody } from "./AgentChatPanel";
import { ChatDropZone } from "./ChatDropZone";
import { pressKey, type } from "./chatTestHarness";

interface FileManagerStub {
  uploadProjectFiles: (files: File[]) => Promise<string[]>;
  fileTree: string[];
}

const fileManager = vi.hoisted((): { value: FileManagerStub | null } => ({ value: null }));
vi.mock("../../contexts/FileManagerContext", () => ({
  useFileManagerContextOptional: () => fileManager.value,
}));

let store: AgentStore | undefined;

afterEach(() => {
  store?.getState().dispose();
  store = undefined;
  cleanupMounted();
  fileManager.value = null;
});

/** A drag payload the way a browser builds it: `Files` for OS files, the types the sources write otherwise. */
interface FakeTransfer {
  types: string[];
  files: File[];
  getData: (type: string) => string;
  dropEffect: string;
  effectAllowed: string;
}

function transfer(options: { files?: File[]; data?: Record<string, string> } = {}): FakeTransfer {
  const data = options.data ?? {};
  const files = options.files ?? [];
  return {
    types: [...(files.length > 0 ? ["Files"] : []), ...Object.keys(data)],
    files,
    getData: (type) => data[type] ?? "",
    dropEffect: "none",
    effectAllowed: "uninitialized",
  };
}

async function fire(target: Element, type: string, dataTransfer: FakeTransfer) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

function Shell({ onTimelineDrop }: { onTimelineDrop: (files: File[]) => void }) {
  const drop = useGlobalFileDrop(async (files) => onTimelineDrop(files));
  return (
    <div data-testid="shell" onDragOver={drop.onDragOver} onDrop={drop.onDrop}>
      <div data-testid="outside" />
      <ChatDropZone>
        <AgentChatBody />
      </ChatDropZone>
    </div>
  );
}

function mountShell(onTimelineDrop: (files: File[]) => void = vi.fn()) {
  const client: FakeClient = createFakeClient({ chat: chatState() });
  store = createAgentStore({ client, openEventSource: createSourceLog().open });
  store.setState({
    availability: "ready",
    models: CATALOG,
    view: "chat",
    chatId: "c1",
    chat: chatState(),
  });
  const host = mountHost(
    <AgentStoreProvider store={store}>
      <Shell onTimelineDrop={onTimelineDrop} />
    </AgentStoreProvider>,
  );
  return { host, client, onTimelineDrop };
}

const zone = (host: HTMLElement) => {
  const element = host.querySelector("[data-chat-drop-zone]");
  if (!element) throw new Error("no drop zone");
  return element;
};
const chips = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLElement>('[data-testid="composer-attachments"] [role="listitem"]'),
];
const field = (host: HTMLElement) => {
  const area = host.querySelector<HTMLTextAreaElement>("textarea");
  if (!area) throw new Error("no composer");
  return area;
};
const sendButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');

const picture = new File(["x"], "cat.png", { type: "image/png" });

describe("dropping on the chat", () => {
  it("imports an OS file as a chip and never reaches the timeline handler", async () => {
    const upload = vi.fn(async () => ["cat.png"]);
    fileManager.value = { uploadProjectFiles: upload, fileTree: [] };
    const { host, onTimelineDrop } = mountShell();

    const dropped = await fire(zone(host), "drop", transfer({ files: [picture] }));

    expect(dropped.defaultPrevented).toBe(true);
    expect(upload).toHaveBeenCalledWith([picture]);
    expect(onTimelineDrop).not.toHaveBeenCalled();
    expect(chips(host).map((chip) => chip.textContent)).toEqual(["cat.png"]);
    expect(chips(host)[0]?.dataset.status).toBe("ready");
  });

  it("still puts a file dropped outside the chat on the timeline", async () => {
    fileManager.value = { uploadProjectFiles: vi.fn(async () => []), fileTree: [] };
    const onTimelineDrop = vi.fn();
    const { host } = mountShell(onTimelineDrop);
    const outside = host.querySelector('[data-testid="outside"]');
    if (!outside) throw new Error("no outside");

    await fire(outside, "drop", transfer({ files: [picture] }));

    expect(onTimelineDrop).toHaveBeenCalledWith([picture]);
    expect(chips(host)).toHaveLength(0);
  });

  it("attaches a Media tile without uploading anything", async () => {
    const upload = vi.fn(async () => []);
    fileManager.value = { uploadProjectFiles: upload, fileTree: ["assets/intro.mp4"] };
    const { host, client } = mountShell();

    await fire(
      zone(host),
      "drop",
      transfer({
        data: {
          "application/x-hyperframes-asset": JSON.stringify({
            path: "assets/intro.mp4",
            bytes: 2048,
            duration: 12.5,
          }),
          "text/plain": "assets/intro.mp4",
        },
      }),
    );
    expect(upload).not.toHaveBeenCalled();
    expect(chips(host).map((chip) => chip.textContent)).toEqual(["intro.mp4"]);

    await type(field(host), "Trim the intro");
    await pressKey(field(host), "Enter");
    expect(client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        prompt: "Trim the intro",
        references: [
          expect.objectContaining({
            kind: "video",
            label: "intro.mp4",
            source: { type: "project-path", path: "assets/intro.mp4" },
            sizeBytes: 2048,
            durationSeconds: 12.5,
          }),
        ],
      }),
    );
    // The files went with the message: the composer is clean again.
    await flush();
    expect(chips(host)).toHaveLength(0);
  });

  it("attaches a file tree row only when it names a project file", async () => {
    fileManager.value = { uploadProjectFiles: vi.fn(async () => []), fileTree: ["assets/a.png"] };
    const { host } = mountShell();

    await fire(zone(host), "drop", transfer({ data: { "text/plain": "some words from a page" } }));
    expect(chips(host)).toHaveLength(0);
    await fire(zone(host), "drop", transfer({ data: { "text/plain": "assets/a.png" } }));
    expect(chips(host).map((chip) => chip.textContent)).toEqual(["a.png"]);
  });

  it("holds Send while a file is still being imported, then sends it as a reference", async () => {
    const landing = Promise.withResolvers<string[]>();
    fileManager.value = { uploadProjectFiles: () => landing.promise, fileTree: [] };
    const { host, client } = mountShell();

    await fire(zone(host), "drop", transfer({ files: [picture] }));
    await type(field(host), "Что на этой картинке?");
    expect(chips(host)[0]?.dataset.status).toBe("uploading");
    expect(sendButton(host)?.disabled).toBe(true);
    await pressKey(field(host), "Enter");
    expect(client.startTurn).not.toHaveBeenCalled();

    await act(async () => landing.resolve(["cat.png"]));
    expect(chips(host)[0]?.dataset.status).toBe("ready");
    expect(sendButton(host)?.disabled).toBe(false);
    await pressKey(field(host), "Enter");
    expect(client.startTurn).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        references: [
          expect.objectContaining({
            kind: "image",
            source: { type: "project-path", path: "cat.png" },
            sizeBytes: 1,
          }),
        ],
      }),
    );
  });

  it("shows a failed import on its chip and sends the message without that file", async () => {
    fileManager.value = { uploadProjectFiles: vi.fn(async () => []), fileTree: [] };
    const { host, client } = mountShell();

    await fire(zone(host), "drop", transfer({ files: [picture] }));
    expect(chips(host)[0]?.dataset.status).toBe("failed");
    expect(chips(host)[0]?.textContent).toContain("Could not be imported");

    await type(field(host), "Hello");
    await pressKey(field(host), "Enter");
    const [, request] = client.startTurn.mock.calls[0] ?? [];
    expect(request).toEqual(expect.objectContaining({ prompt: "Hello" }));
    expect(request).not.toHaveProperty("references");
  });

  it("removes a chip with its × button", async () => {
    fileManager.value = { uploadProjectFiles: vi.fn(async () => ["cat.png"]), fileTree: [] };
    const { host } = mountShell();
    await fire(zone(host), "drop", transfer({ files: [picture] }));

    const remove = host.querySelector<HTMLButtonElement>('button[aria-label^="Remove cat.png"]');
    await act(async () => remove?.click());
    expect(chips(host)).toHaveLength(0);
  });

  it("steers a running turn with the attached files", async () => {
    fileManager.value = {
      uploadProjectFiles: vi.fn(async () => []),
      fileTree: ["assets/logo.png"],
    };
    const { host, client } = mountShell();
    store?.setState({ chat: runningChatState() });

    await fire(zone(host), "drop", transfer({ data: { "text/plain": "assets/logo.png" } }));
    await type(field(host), "Use this logo too");
    await pressKey(field(host), "Enter");

    expect(client.steerTurn).toHaveBeenCalledWith(
      "c1",
      expect.any(String),
      expect.objectContaining({
        text: "Use this logo too",
        references: [expect.objectContaining({ kind: "image", label: "logo.png" })],
      }),
    );
  });

  it("creates the chat from the new-chat draft and sends the attached files with its first turn", async () => {
    fileManager.value = {
      uploadProjectFiles: vi.fn(async () => []),
      fileTree: ["assets/logo.png"],
    };
    const { host, client } = mountShell();
    store?.setState({ chatId: null, chat: null });

    await fire(zone(host), "drop", transfer({ data: { "text/plain": "assets/logo.png" } }));
    await type(field(host), "Start from this logo");
    await pressKey(field(host), "Enter");
    await flush();

    expect(client.createChat).toHaveBeenCalled();
    expect(client.startTurn).toHaveBeenCalledWith(
      "new",
      expect.objectContaining({
        prompt: "Start from this logo",
        references: [expect.objectContaining({ kind: "image", label: "logo.png" })],
      }),
    );
  });
});
