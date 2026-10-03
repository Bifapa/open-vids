import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropOnStory, type StoryDropDeps } from "./storyDrop";
import {
  createFakeStoryServer,
  sampleGraph,
  settle,
  type FakeStoryServer,
} from "./storyTestHarness";
import { createStoryStore, type StoryStore } from "./storyStore";

let server: FakeStoryServer;
let store: StoryStore;

async function openStore() {
  server = createFakeStoryServer(sampleGraph());
  store = createStoryStore({ client: server.client, saveDelayMs: 400 });
  await store.getState().open("p1");
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  store.getState().dispose();
  vi.useRealTimers();
});

interface Payload {
  files?: File[];
  data?: Record<string, string>;
}

const payload = ({ files = [], data = {} }: Payload) => ({
  files,
  getData: (type: string) => data[type] ?? "",
});

const deps = (overrides: Partial<StoryDropDeps> = {}): StoryDropDeps => ({
  upload: vi.fn(async () => []),
  projectFiles: new Set(),
  ...overrides,
});

const asset = (path: string) => ({
  "application/x-hyperframes-asset": JSON.stringify({ path }),
});

const nodeWithAsset = (path: string) =>
  store.getState().graph?.nodes.find((node) => "asset" in node && node.asset === path);

describe("dropping on the Story graph", () => {
  it("imports an OS file and creates a material node at the drop point on empty canvas", async () => {
    await openStore();
    const upload = vi.fn(async () => ["cat.png"]);
    const before = store.getState().graph;

    await dropOnStory(
      store,
      payload({ files: [new File(["x"], "cat.png", { type: "image/png" })] }),
      { point: { x: 1000, y: 500 }, chapterId: null },
      deps({ upload }),
    );

    expect(upload).toHaveBeenCalledTimes(1);
    const node = nodeWithAsset("cat.png");
    expect(node).toMatchObject({
      kind: "picture",
      title: "cat",
      createdBy: "user",
      position: { x: 884, y: 440 },
    });
    // Nothing is attached to a chapter when it landed on empty canvas.
    expect(store.getState().graph?.attachments).toHaveLength(before?.attachments.length ?? -1);

    // It is a user edit saved through the Story service, and one undo takes it back.
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    expect(server.saves.at(-1)?.graph.updatedBy).toBe("user");
    expect(server.saves.at(-1)?.graph.nodes.some((candidate) => candidate.id === node?.id)).toBe(
      true,
    );
    expect(store.getState().undo()).toBe(true);
    expect(nodeWithAsset("cat.png")).toBeUndefined();
  });

  it("attaches a Media drag to the chapter it was dropped on, in the middle of it", async () => {
    await openStore();

    await dropOnStory(
      store,
      payload({ data: asset("assets/b-roll.mp4") }),
      { point: { x: 650, y: 100 }, chapterId: "c" },
      deps(),
    );

    const graph = store.getState().graph;
    const node = nodeWithAsset("assets/b-roll.mp4");
    expect(node).toMatchObject({ kind: "video" });
    expect(graph?.attachments).toContainEqual(
      expect.objectContaining({
        node: node?.id,
        chapter: "c",
        placement: "middle",
        createdBy: "user",
      }),
    );
  });

  it("lays music under the whole chapter", async () => {
    await openStore();

    await dropOnStory(
      store,
      payload({ data: asset("assets/theme.mp3") }),
      { point: { x: 0, y: 0 }, chapterId: "a" },
      deps(),
    );

    const node = nodeWithAsset("assets/theme.mp3");
    expect(store.getState().graph?.attachments).toContainEqual(
      expect.objectContaining({ node: node?.id, chapter: "a", placement: "throughout" }),
    );
  });

  it("takes a file tree row only when it names a project file", async () => {
    await openStore();
    const projectFiles = new Set(["assets/logo.png"]);

    await dropOnStory(
      store,
      payload({ data: { "text/plain": "just some words" } }),
      { point: { x: 0, y: 0 }, chapterId: null },
      deps({ projectFiles }),
    );
    expect(store.getState().graph?.nodes).toHaveLength(sampleGraph().nodes.length);

    await dropOnStory(
      store,
      payload({ data: { "text/plain": "assets/logo.png" } }),
      { point: { x: 0, y: 0 }, chapterId: null },
      deps({ projectFiles }),
    );
    expect(nodeWithAsset("assets/logo.png")).toMatchObject({ kind: "picture" });
  });

  it("refuses other file types with a message and imports nothing", async () => {
    await openStore();
    const upload = vi.fn(async () => ["notes.pdf"]);

    await dropOnStory(
      store,
      payload({ files: [new File(["x"], "notes.pdf", { type: "application/pdf" })] }),
      { point: { x: 0, y: 0 }, chapterId: null },
      deps({ upload }),
    );

    expect(upload).not.toHaveBeenCalled();
    expect(store.getState().graph?.nodes).toHaveLength(sampleGraph().nodes.length);
    expect(store.getState().notice).toContain("notes.pdf");
  });

  it("says so when the import fails and leaves the graph alone", async () => {
    await openStore();

    await dropOnStory(
      store,
      payload({ files: [new File(["x"], "clip.mp4", { type: "video/mp4" })] }),
      { point: { x: 0, y: 0 }, chapterId: null },
      deps({ upload: vi.fn(async () => []) }),
    );

    expect(store.getState().graph?.nodes).toHaveLength(sampleGraph().nodes.length);
    expect(store.getState().notice).toContain("clip.mp4");
  });

  it("cascades several files dropped together", async () => {
    await openStore();
    const upload = vi.fn(async ([file]: File[]) => [file?.name ?? ""]);

    await dropOnStory(
      store,
      payload({
        files: [
          new File(["x"], "one.png", { type: "image/png" }),
          new File(["x"], "two.png", { type: "image/png" }),
        ],
      }),
      { point: { x: 300, y: 300 }, chapterId: null },
      deps({ upload }),
    );

    const first = nodeWithAsset("one.png")?.position;
    const second = nodeWithAsset("two.png")?.position;
    expect(second).toEqual({ x: (first?.x ?? 0) + 36, y: (first?.y ?? 0) + 28 });
  });

  it("does not edit while an agent turn holds the graph", async () => {
    await openStore();
    store.getState().setAgentBusy(true);

    await dropOnStory(
      store,
      payload({ data: asset("assets/b-roll.mp4") }),
      { point: { x: 0, y: 0 }, chapterId: null },
      deps(),
    );

    expect(nodeWithAsset("assets/b-roll.mp4")).toBeUndefined();
    expect(store.getState().notice).not.toBeNull();
  });
});
