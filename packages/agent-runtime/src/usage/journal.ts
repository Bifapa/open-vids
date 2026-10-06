import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isRecord,
  parseUsageEntry,
  usageEntryKey,
  type ChatState,
  type UsageEntry,
} from "@hyperframes/agent-protocol";
import { sameValue } from "../store/compact.js";
import { readForkedAt } from "../store/forkMarker.js";
import { usageEntriesOfTurn } from "./entries.js";

/** Where the journal reads the chat logs from when it has to be rebuilt. */
export interface UsageLogSource {
  listChatIds(): Promise<string[]>;
  /** A chat's log as it is, without repairing it (the writer may be appending). */
  peek(chatId: string): Promise<{ state: ChatState | null }>;
}

const isMissing = (error: unknown): boolean =>
  isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");

/** The lines of a journal: one entry per line, anything unreadable (a torn last line, a foreign line) skipped. */
export function parseUsageJournal(text: string): UsageEntry[] {
  const entries: UsageEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = parseUsageEntry(value);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * The project's usage journal, `<project>/.hyperframes/agent/usage.jsonl`: one line per Director and per run of every
 * turn, written when the turn ends. It is the record of what the project cost, which the chats are not: a deleted chat
 * takes its usage along, a copied chat doubles it.
 *
 * - Crash-safe: a line is one append, a half-written last line is skipped on read and cut off by a newline before the
 *   next append, and the file is replaced as a whole (temp file + rename) only when it is rebuilt.
 * - A line is identified by `turnId` + `runId`; the later line of an identity wins, so the runtime may write a turn's
 *   lines again (crash recovery closing it) without counting it twice.
 * - Recovery: with no journal (a project from before it existed, or a copied one) it is rebuilt from the chat logs;
 *   turns that started before a fork marker (`fork.json`) belong to the original project and are not counted.
 *
 * One runtime process serves a project, so the in-memory fold is the only reader and writer.
 */
export class UsageJournal {
  private readonly file: string;
  private readonly agentDir: string;
  private readonly entries = new Map<string, UsageEntry>();
  private loading: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  /** The file ends in a half-written line: the next append starts on a new line. */
  private tornTail = false;

  constructor(
    private readonly projectDir: string,
    private readonly source: UsageLogSource,
  ) {
    this.agentDir = join(projectDir, ".hyperframes", "agent");
    this.file = join(this.agentDir, "usage.jsonl");
  }

  /** Reads (or rebuilds) the journal. Shared by every caller; a failed attempt is retried by the next call. */
  ready(): Promise<void> {
    if (!this.loading) {
      this.loading = this.load().catch((error: unknown) => {
        this.loading = null;
        throw error;
      });
    }
    return this.loading;
  }

  /** Every entry of the journal, in the order they were first written. */
  async all(): Promise<UsageEntry[]> {
    await this.ready();
    return [...this.entries.values()];
  }

  /** Writes the lines of a turn that ended (or is closed by recovery), those that differ from what is recorded. */
  async recordTurn(state: ChatState, turnId: string): Promise<void> {
    await this.ready();
    const changed = usageEntriesOfTurn(state, turnId).filter((entry) => {
      const known = this.entries.get(usageEntryKey(entry));
      return !known || !sameValue(known, entry);
    });
    if (changed.length === 0) return;
    const text = changed.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    const write = this.writes.catch(() => undefined).then(() => this.append(text));
    this.writes = write;
    await write;
    for (const entry of changed) this.entries.set(usageEntryKey(entry), entry);
  }

  /** Waits for the appends in flight (shutdown and test teardown, before directories are removed). */
  async drain(): Promise<void> {
    await this.writes.catch(() => undefined);
  }

  private async append(text: string): Promise<void> {
    await mkdir(this.agentDir, { recursive: true });
    await appendFile(this.file, this.tornTail ? `\n${text}` : text, "utf8");
    this.tornTail = false;
  }

  private async load(): Promise<void> {
    let text: string | null = null;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    this.entries.clear();
    if (text !== null) {
      this.tornTail = text.length > 0 && !text.endsWith("\n");
      for (const entry of parseUsageJournal(text)) this.entries.set(usageEntryKey(entry), entry);
      return;
    }
    const rebuilt = await this.rebuild();
    for (const entry of rebuilt) this.entries.set(usageEntryKey(entry), entry);
    await this.replaceFile(rebuilt.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    this.tornTail = false;
  }

  /** The entries of every turn the chat logs hold (a turn still running counts as far as it got). */
  private async rebuild(): Promise<UsageEntry[]> {
    const forkedAt = readForkedAt(this.projectDir) ?? 0;
    const rebuilt: UsageEntry[] = [];
    for (const chatId of await this.source.listChatIds()) {
      let state: ChatState | null;
      try {
        state = (await this.source.peek(chatId)).state;
      } catch {
        continue;
      }
      if (!state) continue;
      for (const turn of state.turns) {
        if (turn.startedAt < forkedAt) continue;
        rebuilt.push(...usageEntriesOfTurn(state, turn.id));
      }
    }
    return rebuilt;
  }

  private async replaceFile(text: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const draft = `${this.file}.${process.pid}.tmp`;
    try {
      const handle = await open(draft, "w");
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(draft, this.file);
    } catch (error) {
      await rm(draft, { force: true });
      throw error;
    }
  }
}
