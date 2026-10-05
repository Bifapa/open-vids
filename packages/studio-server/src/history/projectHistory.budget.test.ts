// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryWho } from "./historyLog";
import { openProjectHistory } from "./projectHistory";

const counts = vi.hoisted(() => ({ puts: 0, logRewrites: 0 }));

vi.mock("./blobStore", async (importOriginal) => {
  const original = await importOriginal<typeof import("./blobStore")>();
  return {
    ...original,
    openBlobStore: async (dir: string) => {
      const store = await original.openBlobStore(dir);
      return {
        ...store,
        put: (path: string) => {
          counts.puts++;
          return store.put(path);
        },
      };
    },
  };
});
vi.mock("./historyLog", async (importOriginal) => {
  const original = await importOriginal<typeof import("./historyLog")>();
  return {
    ...original,
    writeLog: (...args: Parameters<typeof original.writeLog>) => {
      counts.logRewrites++;
      return original.writeLog(...args);
    },
  };
});

const you: HistoryWho = { kind: "person", name: "You" };
const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function project(files: Record<string, string | Buffer>, options = {}) {
  const projectDir = tempDir("hf-history-project-");
  const historyRoot = tempDir("hf-history-root-");
  const write = (path: string, content: string | Buffer) =>
    writeFileSync(join(projectDir, path), content);
  for (const [path, content] of Object.entries(files)) write(path, content);
  const history = await openProjectHistory({ projectDir, historyRoot, ...options });
  cleanup.push(() => history.close());
  return { history, write };
}

describe("project history sweeps and budget", () => {
  it("does not copy an unchanged large media file in again on later sweeps", async () => {
    const { history } = await project({ "clip.mp4": Buffer.alloc(3 * 1024 * 1024, 5) });
    vi.useFakeTimers({ toFake: ["Date"] });
    // Past the window in which a fresh file's stat is too young to trust.
    vi.setSystemTime(Date.now() + 60_000);
    await history.flush();
    counts.puts = 0;

    vi.setSystemTime(Date.now() + 60_000);
    await history.flush();
    vi.setSystemTime(Date.now() + 60_000);
    await history.flush();

    expect(counts.puts).toBe(0);
  });

  it("rewrites the log once when one commit folds many entries", async () => {
    const { history, write } = await project(
      { "index.html": "a", "media.bin": Buffer.alloc(1000, 1) },
      { budgetBytes: 1200 },
    );
    for (let index = 0; index < 6; index++) {
      const window = await history.beginWindow(you, `Edit ${index}`);
      write("index.html", String(index).repeat(50));
      await window.close();
    }
    expect(history.list()).toHaveLength(6);

    // Replacing the big file leaves its old bytes in history: older entries fold until they are gone.
    const window = await history.beginWindow(you, "New media");
    write("media.bin", Buffer.alloc(1000, 2));
    counts.logRewrites = 0;
    await window.close();

    expect(history.list().length).toBeLessThan(6);
    expect(counts.logRewrites).toBe(1);
  });
});
