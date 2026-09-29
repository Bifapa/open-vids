// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openProjectHistory } from "./projectHistory";
import type { HistoryWho } from "./historyLog";

const director: HistoryWho = { kind: "agent", name: "Director" };
const LEASE_MS = 120_000;
const RENEW_MS = 20_000;
const GAP_MS = 11 * 60_000;
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

async function project() {
  const projectDir = tempDir("hf-history-lease-");
  writeFileSync(join(projectDir, "a.html"), "A0");
  writeFileSync(join(projectDir, "b.html"), "B0");
  const history = await openProjectHistory({
    projectDir,
    historyRoot: tempDir("hf-history-lease-root-"),
  });
  cleanup.push(() => history.close());
  /** Writes `path` as if at `at` (ms): the engine dates a write by its file's mtime. */
  const writeAt = (path: string, content: string, at: number) => {
    writeFileSync(join(projectDir, path), content);
    utimesSync(join(projectDir, path), at / 1000, at / 1000);
  };
  const read = (path: string) => readFileSync(join(projectDir, path), "utf-8");
  return { history, writeAt, read };
}

/**
 * One agent turn: a write, an 11-minute pause (longer than the route's 10-minute idle cap), then a second write. The
 * clock is moved by hand; file mtimes carry the write times. `renewing` models the runtime's heartbeat.
 */
async function turnWithLongPause(renewing: boolean) {
  const { history, writeAt, read } = await project();
  // Ahead of the real clock, so no real ctime is newer than the faked mtimes.
  const t0 = Date.now() + 86_400_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t0);
  const window = await history.beginWindow(director, "Director: tighten the intro", {
    idleMs: LEASE_MS,
  });
  writeAt("a.html", "A1", t0 + 1_000);
  for (let at = t0 + RENEW_MS; at <= t0 + GAP_MS; at += RENEW_MS) {
    vi.setSystemTime(at);
    if (renewing) expect(window.renew()).toBe(true);
  }
  writeAt("b.html", "B1", t0 + GAP_MS);
  vi.setSystemTime(t0 + GAP_MS + 5_000);
  const entry = await window.close();
  vi.useRealTimers();
  return { history, entry, read };
}

describe("a history window its owner keeps renewing", () => {
  it("keeps a write made 11 minutes after the previous one in the same entry, and one undo reverts both", async () => {
    const { history, entry, read } = await turnWithLongPause(true);

    expect(history.list()).toHaveLength(1);
    expect(entry).toMatchObject({ who: director, label: "Director: tighten the intro" });
    expect(entry!.files.map((file) => file.path)).toEqual(["a.html", "b.html"]);

    const undone = await history.undo(entry!.id, { who: director, mode: "keep-later-edits" });
    expect(undone.ok).toBe(true);
    expect([read("a.html"), read("b.html")]).toEqual(["A0", "B0"]);
  });

  it("without renewals still ends at its idle limit, so the late write is someone else's (unchanged semantics)", async () => {
    const { history, entry } = await turnWithLongPause(false);

    expect(entry!.files.map((file) => file.path)).toEqual(["a.html"]);
    await history.flush();
    const late = history.list().find((listed) => listed.id !== entry!.id);
    expect(late).toMatchObject({ who: { kind: "outside" } });
    expect(late!.files.map((file) => file.path)).toEqual(["b.html"]);
  });

  it("reports false to a renewal once it idled out or was closed, so its owner can stop writing", async () => {
    const { history, writeAt } = await project();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const idled = await history.beginWindow(director, "Idled", { idleMs: 50 });
    expect(idled.renew()).toBe(true);
    vi.advanceTimersByTime(49);
    expect(idled.renew()).toBe(true);
    vi.advanceTimersByTime(60);
    expect(idled.renew()).toBe(false);
    vi.useRealTimers();
    await history.flush();

    const closed = await history.beginWindow(director, "Closed", { idleMs: LEASE_MS });
    writeAt("a.html", "A2", Date.now());
    await closed.close();
    expect(closed.renew()).toBe(false);
  });
});
