// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import { cleanupMounted, mountHost } from "../ui/mountHost.testHelpers";
import { FileTree } from "./FileTree";

afterEach(cleanupMounted);

function mountTree(locked: boolean) {
  return mountHost(
    <FileTree
      files={["index.html", "scenes/intro.html"]}
      activeFile={null}
      onSelectFile={vi.fn()}
      onCreateFile={vi.fn()}
      onCreateFolder={vi.fn()}
      onDeleteFile={vi.fn()}
      onRenameFile={vi.fn()}
      onDuplicateFile={vi.fn()}
      onMoveFile={vi.fn()}
      onImportFiles={vi.fn()}
      locked={locked}
    />,
  );
}

const newFileButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>(`[aria-label="${t("editor.fileTree.newFile")}"]`);
const indexRow = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>("[draggable]")].find((row) =>
    row.textContent?.includes("index.html"),
  );

async function rightClick(element: Element | undefined) {
  if (!element) throw new Error("nothing to right-click");
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }),
    );
  });
}

describe("file tree while an agent turn runs", () => {
  it("stops creating and changing files and says why", async () => {
    const host = mountTree(true);

    expect(newFileButton(host)?.disabled).toBe(true);
    expect(newFileButton(host)?.title).toBe(t("files.lock.agentEditing"));
    expect(host.querySelector('[data-testid="file-tree-lock"]')?.textContent).toContain(
      t("files.lock.treeNotice"),
    );

    await rightClick(indexRow(host));
    expect(host.ownerDocument.querySelector('[role="menu"]')).toBeNull();

    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    await act(async () => {
      indexRow(host)?.dispatchEvent(dragStart);
    });
    expect(dragStart.defaultPrevented).toBe(true);
  });

  it("leaves the tree alone while no turn runs", async () => {
    const host = mountTree(false);

    expect(newFileButton(host)?.disabled).toBe(false);
    expect(host.querySelector('[data-testid="file-tree-lock"]')).toBeNull();

    await rightClick(indexRow(host));
    expect(host.ownerDocument.querySelector('[role="menu"]')).not.toBeNull();
  });
});
