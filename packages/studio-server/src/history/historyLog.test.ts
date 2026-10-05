// @vitest-environment node
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLog, saveRecord, writeLog, type HistoryEntry, type LogRecord } from "./historyLog";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function logFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "hf-history-log-"));
  dirs.push(dir);
  return join(dir, "log.jsonl");
}

function entry(id: string): HistoryEntry {
  return {
    id,
    who: { kind: "person", name: "You" },
    label: id,
    startedAt: 1,
    endedAt: 2,
    files: [{ path: "index.html", before: null, after: "a".repeat(64) }],
  };
}

function seeded(): { file: string; heard: number[] } {
  const file = logFile();
  writeLog(file, { baseline: new Map(), entries: [entry("e1")], pins: new Set() });
  return { file, heard: [] };
}

describe("readLog", () => {
  it("returns null for a log that is not there", () => {
    expect(readLog(logFile(), () => undefined)).toBeNull();
  });

  it("throws for a log it cannot read, so the caller never mistakes it for a first open", () => {
    const file = logFile();
    mkdirSync(file);
    expect(() => readLog(file, () => undefined)).toThrow(/EISDIR/);
  });
});

describe("saveRecord", () => {
  it("cuts a torn last line off, so the record appended next is neither fused with it nor lost", () => {
    const { file, heard } = seeded();
    appendFileSync(file, '{"type":"entry","entry":{"id":"e2","who"');
    const log = readLog(file, (line) => heard.push(line))!;
    expect(log.entries.map((e) => e.id)).toEqual(["e1"]);

    const third: LogRecord = { type: "entry", entry: entry("e3") };
    saveRecord(file, log, third);

    const reopened = readLog(file, (line) => heard.push(line))!;
    expect(reopened.entries.map((e) => e.id)).toEqual(["e1", "e3"]);
    expect(heard).toEqual([]);
  });

  it("keeps a last record that only lacks its newline", () => {
    const { file, heard } = seeded();
    const complete = JSON.stringify({ type: "entry", entry: entry("e2") });
    appendFileSync(file, complete);

    const log = readLog(file, (line) => heard.push(line))!;
    expect(log.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
    saveRecord(file, log, { type: "entry", entry: entry("e3") });

    expect(readLog(file, (line) => heard.push(line))!.entries.map((e) => e.id)).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
    expect(heard).toEqual([]);
    expect(readFileSync(file, "utf-8").endsWith("\n")).toBe(true);
  });

  it("appends to a log that ends cleanly without touching what is there", () => {
    const { file } = seeded();
    const before = readFileSync(file, "utf-8");
    const log = readLog(file, () => undefined)!;
    saveRecord(file, log, { type: "pin", id: "e1", pinned: true });
    const pin = `${JSON.stringify({ type: "pin", id: "e1", pinned: true })}\n`;
    expect(readFileSync(file, "utf-8")).toBe(before + pin);
  });

  it("writes a missing log whole", () => {
    const file = logFile();
    const log = { baseline: new Map(), entries: [entry("e1")], pins: new Set<string>() };
    saveRecord(file, log, { type: "entry", entry: entry("e1") });
    expect(readLog(file, () => undefined)!.entries.map((e) => e.id)).toEqual(["e1"]);
  });
});
