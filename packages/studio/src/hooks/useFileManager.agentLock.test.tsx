// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./useFileTree", () => ({
  useFileTree: () => ({
    projectDir: "",
    fileTree: [],
    fileTreeLoaded: true,
    refreshFileTree: vi.fn(async () => {}),
    compositions: [],
    assets: [],
    fontAssets: [],
  }),
}));

vi.mock("./useEditorSave", () => ({
  useEditorSave: () => ({
    saveRafRef: { current: null },
    handleContentChange: vi.fn(),
    getPendingCandidate: vi.fn(() => null),
    flushPendingSave: vi.fn(async () => ({ status: "clean" as const })),
    discardPendingSave: vi.fn(),
  }),
}));

import { agentTurnLockStore, setAgentTurnRunning } from "../agent/agentTurnLock";
import { t } from "../i18n";
import { useFileManager } from "./useFileManager";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Renders a hook once and hands back what it returned. */
async function renderOnce<T>(useHook: () => T): Promise<T> {
  const box: { value: T | undefined } = { value: undefined };
  function Probe() {
    box.value = useHook();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
  if (box.value === undefined) throw new Error("the hook did not render");
  return box.value;
}

async function mountFileManager(showToast = vi.fn()) {
  const manager = await renderOnce(() =>
    useFileManager({
      projectId: "project-a",
      showToast,
      recordEdit: vi.fn(async () => {}),
      setRefreshKey: vi.fn(),
    }),
  );
  return { manager, showToast };
}

describe("file changes while an agent turn runs", () => {
  afterEach(() => {
    agentTurnLockStore.setState({ projectId: null, running: false });
    vi.unstubAllGlobals();
  });

  it("refuses every tree mutation before it reaches the server, and says why", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { manager, showToast } = await mountFileManager();
    setAgentTurnRunning(true);

    await manager.handleCreateFile("scenes/new.html");
    await manager.handleCreateFolder("scenes/extra");
    await manager.handleDeleteFile("index.html");
    await manager.handleRenameFile("index.html", "main.html");
    await manager.handleMoveFile("index.html", "scenes/index.html");
    await manager.handleDuplicateFile("index.html");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(6);
    expect(showToast).toHaveBeenCalledWith(t("files.lock.agentEditing"), "error");
  });

  it("works again as soon as the turn is over", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    const { manager, showToast } = await mountFileManager();
    setAgentTurnRunning(true);
    await manager.handleDeleteFile("old.html");
    expect(fetchMock).not.toHaveBeenCalled();

    setAgentTurnRunning(false);
    await manager.handleDeleteFile("old.html");
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-a/files/old.html", {
      method: "DELETE",
    });
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("keeps importing files open: they only add new ones, and the chat attaches files mid-turn", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ files: ["assets/cat.png"] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { manager, showToast } = await mountFileManager();
    setAgentTurnRunning(true);

    const landed = await manager.uploadProjectFiles([new File(["x"], "cat.png")]);

    expect(landed).toEqual(["assets/cat.png"]);
    expect(showToast).not.toHaveBeenCalled();
  });
});
