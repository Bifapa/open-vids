import { describe, expect, it, vi } from "vitest";
import { refreshEditorAfterRevert, type RevertRefreshDeps } from "./revertRefresh";

function deps(overrides: Partial<RevertRefreshDeps> = {}) {
  const calls: string[] = [];
  const value: RevertRefreshDeps = {
    editingPath: null,
    readProjectFile: vi.fn(async () => "restored"),
    updateEditingFileContent: vi.fn(() => void calls.push("editor")),
    invalidateGsapCache: vi.fn(() => void calls.push("gsap")),
    forceReloadSdkSession: vi.fn(() => void calls.push("sdk")),
    syncHistoryPreviewAfterApply: vi.fn(async () => void calls.push("preview")),
    refreshFileTree: vi.fn(() => void calls.push("tree")),
    bumpThumbnailRevisions: vi.fn(() => void calls.push("thumbs")),
    ...overrides,
  };
  return { value, calls };
}

describe("refreshEditorAfterRevert", () => {
  it("runs undo's refresh (gsap, sdk, preview) and then refreshes tree and thumbnails", async () => {
    const { value, calls } = deps();
    await refreshEditorAfterRevert(value);
    expect(calls).toEqual(["gsap", "sdk", "preview", "tree", "thumbs"]);
    // Unknown paths: the preview sync gets no file list, which is its full-reload case.
    expect(value.syncHistoryPreviewAfterApply).toHaveBeenCalledWith({});
    expect(value.bumpThumbnailRevisions).toHaveBeenCalledWith(null);
  });

  it("re-reads the file open in the code editor", async () => {
    const { value } = deps({ editingPath: "index.html" });
    await refreshEditorAfterRevert(value);
    expect(value.readProjectFile).toHaveBeenCalledWith("index.html");
    expect(value.updateEditingFileContent).toHaveBeenCalledWith("index.html", "restored");
  });

  it("does not let one failing step stop the others or throw", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { value, calls } = deps({
      forceReloadSdkSession: () => {
        throw new Error("no session");
      },
      syncHistoryPreviewAfterApply: async () => {
        throw new Error("no iframe");
      },
    });
    await expect(refreshEditorAfterRevert(value)).resolves.toBeUndefined();
    expect(calls).toEqual(["gsap", "tree", "thumbs"]);
    error.mockRestore();
  });
});
