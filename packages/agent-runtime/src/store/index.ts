import { randomUUID } from "node:crypto";
import { readFileSync, truncateSync } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ChatEvent, ChatState, ChatSummary, SpecialistId } from "@hyperframes/agent-protocol";
import { foldChatEvents, isRecord, isStoryOffer } from "@hyperframes/agent-protocol";
import { RuntimeError } from "../errors.js";
import { LockBusyError, takeLock } from "../processLock.js";
import { readForkedAt, retireCheckpointsBefore } from "./forkMarker.js";

const agentRoot = (projectDir: string) => join(projectDir, ".hyperframes", "agent", "chats");
const chatDirectory = (projectDir: string, chatId: string) => {
  if (
    !chatId ||
    chatId === "." ||
    chatId === ".." ||
    chatId.includes(sep) ||
    chatId.includes("/")
  ) {
    throw new Error("Invalid chat id");
  }
  return join(agentRoot(projectDir), chatId);
};

/** What a chat's log folded to; `state` is null for a log that does not start with `chat.created`. */
export interface LoadedChat {
  events: ChatEvent[];
  state: ChatState | null;
  /** Size of the complete part of the log in bytes. */
  bytes: number;
}

/** Last chat summary of a log, kept beside it so the project's chats can be listed without reading every log. */
interface SummaryFile {
  bytes: number;
  event: ChatEvent;
  /** The chat has a running turn or an unclosed checkpoint: crash recovery has to read its log. */
  recoverable: boolean;
}

/** Project-scoped chat event storage: an append-only log per chat, rewritten (compacted) when a turn ends. */
export class FileChatStore {
  private readonly appendTails = new Map<string, Promise<void>>();
  /** Bytes of each chat's log as this store last read or wrote it. */
  private readonly sizes = new Map<string, number>();

  constructor(readonly projectDir: string) {}

  async listChatIds(): Promise<string[]> {
    const root = agentRoot(this.projectDir);
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  async load(chatId: string): Promise<LoadedChat> {
    const file = join(chatDirectory(this.projectDir, chatId), "events.jsonl");
    const contents = await readFile(file, "utf8").catch((error: unknown) => {
      if (isMissing(error)) return "";
      throw error;
    });
    const parsed = parseLog(file, contents, readForkedAt(this.projectDir));
    if (parsed.torn) await truncate(file, parsed.bytes);
    this.sizes.set(chatId, parsed.bytes);
    return parsed.loaded;
  }

  /**
   * A chat's log read as it is, without repairing it: a torn tail is ignored rather than truncated and the store's size
   * bookkeeping is left alone. For readers that run beside the writer (usage recovery), which must never cut a line
   * the writer is still appending.
   */
  async peek(chatId: string): Promise<LoadedChat> {
    const file = join(chatDirectory(this.projectDir, chatId), "events.jsonl");
    const contents = await readFile(file, "utf8").catch((error: unknown) => {
      if (isMissing(error)) return "";
      throw error;
    });
    return parseLog(file, contents, readForkedAt(this.projectDir)).loaded;
  }

  /** {@link load} without yielding: one chat's (compacted) log, read when something first asks for that chat. */
  loadSync(chatId: string): LoadedChat {
    const file = join(chatDirectory(this.projectDir, chatId), "events.jsonl");
    let contents = "";
    try {
      contents = readFileSync(file, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parsed = parseLog(file, contents, readForkedAt(this.projectDir));
    if (parsed.torn) truncateSync(file, parsed.bytes);
    this.sizes.set(chatId, parsed.bytes);
    return parsed.loaded;
  }

  async append(event: ChatEvent): Promise<void> {
    const directory = chatDirectory(this.projectDir, event.chatId);
    const file = join(directory, "events.jsonl");
    const line = `${JSON.stringify(event)}\n`;
    await this.queued(event.chatId, async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, line, "utf8");
      this.sizes.set(event.chatId, (this.sizes.get(event.chatId) ?? 0) + Buffer.byteLength(line));
    });
  }

  /**
   * Replaces the chat's log by `events` (its compacted form). Crash-safe: the new log is written beside the old one,
   * flushed, and renamed over it, so a crash leaves either whole log. Queued behind the appends in flight.
   */
  async replace(chatId: string, events: readonly ChatEvent[]): Promise<void> {
    const directory = chatDirectory(this.projectDir, chatId);
    const file = join(directory, "events.jsonl");
    const text = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    await this.queued(chatId, async () => {
      await mkdir(directory, { recursive: true });
      await writeFileAtomic(file, text, true);
      this.sizes.set(chatId, Buffer.byteLength(text));
    });
  }

  /**
   * Records the chat's summary with the log size it describes. A summary only counts while the log is still exactly
   * that size (see {@link readSummary}), so one that went stale simply is not used.
   */
  async writeSummary(
    chat: ChatSummary,
    lastSeq: number,
    ts: number,
    recoverable: boolean,
  ): Promise<void> {
    const file = join(chatDirectory(this.projectDir, chat.id), "summary.json");
    await this.queued(chat.id, async () => {
      const event: ChatEvent = { type: "chat.updated", chat, chatId: chat.id, seq: lastSeq, ts };
      const summary: SummaryFile = { bytes: this.sizes.get(chat.id) ?? 0, event, recoverable };
      await writeFileAtomic(file, JSON.stringify(summary), false);
    });
  }

  /**
   * The chat's summary when the stored one still describes the log as it is now; null otherwise (read the log), also for
   * a summary without the recovery flag (written before it existed).
   */
  async readSummary(chatId: string): Promise<{ chat: ChatSummary; recoverable: boolean } | null> {
    const directory = chatDirectory(this.projectDir, chatId);
    try {
      const raw: unknown = JSON.parse(await readFile(join(directory, "summary.json"), "utf8"));
      if (
        !isRecord(raw) ||
        typeof raw.bytes !== "number" ||
        typeof raw.recoverable !== "boolean" ||
        !isChatEvent(raw.event)
      )
        return null;
      const { event } = raw;
      if (event.type !== "chat.created" && event.type !== "chat.updated") return null;
      const size = (await stat(join(directory, "events.jsonl"))).size;
      return size === raw.bytes && event.chat.id === chatId
        ? { chat: event.chat, recoverable: raw.recoverable }
        : null;
    } catch {
      return null;
    }
  }

  /** Removes a chat with everything it owns (its log and the private state of its Director and specialists). */
  async deleteChat(chatId: string): Promise<void> {
    const directory = chatDirectory(this.projectDir, chatId);
    await this.queued(chatId, async () => {
      await rm(directory, { recursive: true, force: true });
      this.sizes.delete(chatId);
    });
  }

  /**
   * Waits until every in-flight append reached the event log. Shutdown and test teardown drain before deleting
   * directories, so a still-running write cannot race the removal (on Windows the removal, or the write, fails).
   */
  async drain(): Promise<void> {
    while (this.appendTails.size > 0) {
      await Promise.allSettled([...this.appendTails.values()]);
    }
  }

  /** Creates and returns the private backend state directory for a chat's Director. */
  async stateDir(chatId: string): Promise<string> {
    const directory = resolve(chatDirectory(this.projectDir, chatId), "backend");
    await mkdir(directory, { recursive: true });
    return directory;
  }

  /** The private backend state directory of one specialist in a chat, beside (not inside) the Director's. */
  async agentStateDir(chatId: string, agent: SpecialistId): Promise<string> {
    const directory = resolve(chatDirectory(this.projectDir, chatId), "agents", agent);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  /** Runs a file operation of one chat after the earlier ones of that chat. */
  private async queued(chatId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.appendTails.get(chatId) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(operation);
    this.appendTails.set(chatId, write);
    try {
      await write;
    } finally {
      if (this.appendTails.get(chatId) === write) this.appendTails.delete(chatId);
    }
  }
}

/**
 * One process at a time serves a project's chats: two would hand out the same event numbers and drop each other's
 * events, and could run two turns on one project. Resolves with the release function; rejects with a 409
 * `project_served_elsewhere` while another live process holds it (a short wait covers a runtime that is just exiting).
 */
export async function takeProjectOwnership(
  projectDir: string,
  waitMs = 3_000,
): Promise<() => void> {
  try {
    return await takeLock(join(projectDir, ".hyperframes", "agent", "owner.pid"), waitMs);
  } catch (error) {
    if (error instanceof LockBusyError) {
      throw new RuntimeError(
        "project_served_elsewhere",
        "This project's chats are open in another OpenVids process. Close it there, or reopen the project from that window.",
        409,
        { pid: error.pid },
      );
    }
    throw error;
  }
}

/** Writes `text` to `file` through a temp file and a rename, so a reader or a crash never sees half of it. */
async function writeFileAtomic(file: string, text: string, flush: boolean): Promise<void> {
  const draft = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(draft, "w");
    try {
      await handle.writeFile(text, "utf8");
      if (flush) await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(draft, file);
  } catch (error) {
    await rm(draft, { force: true });
    throw error;
  }
}

interface ParsedLog {
  loaded: LoadedChat;
  /** The log ends in a half-written line that must be cut off at `bytes`. */
  torn: boolean;
  bytes: number;
}

function parseLog(file: string, contents: string, forkedAt: number | null): ParsedLog {
  const lines = contents.split("\n");
  const completeLineCount = lines.length - 1;
  const torn = contents.length > 0 && !contents.endsWith("\n");
  const bytes = torn
    ? Buffer.byteLength(contents.slice(0, contents.lastIndexOf("\n") + 1))
    : Buffer.byteLength(contents);
  const events: ChatEvent[] = [];
  for (let index = 0; index < completeLineCount; index += 1) {
    const line = lines[index];
    if (!line) continue;
    // One damaged or unknown record must not make the whole project's chats unreadable: skip it and say so.
    const value = parseLine(line);
    if (isChatEvent(value)) events.push(value);
    else
      console.error(`[openvids-agent] skipping invalid chat event at line ${index + 1} of ${file}`);
  }
  // A copied project keeps its chats, not the history behind their checkpoints (see forkMarker.ts).
  const shown = forkedAt === null ? events : retireCheckpointsBefore(events, forkedAt);
  return { loaded: { events: shown, state: foldChatEvents(shown), bytes }, torn, bytes };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isChatEvent(value: unknown): value is ChatEvent {
  if (
    !isRecord(value) ||
    typeof value.chatId !== "string" ||
    typeof value.seq !== "number" ||
    !Number.isInteger(value.seq) ||
    typeof value.ts !== "number"
  )
    return false;
  switch (value.type) {
    case "chat.created":
    case "chat.updated":
      return isRecord(value.chat);
    case "turn.started":
      return (
        isRecord(value.turn) && isRecord(value.promptMessage) && isRecord(value.assistantMessage)
      );
    case "message.appended":
      return isRecord(value.message);
    case "assistant.text.delta":
      return (
        typeof value.messageId === "string" &&
        typeof value.partId === "string" &&
        typeof value.delta === "string"
      );
    case "assistant.parts.interim":
      return (
        typeof value.messageId === "string" &&
        Array.isArray(value.partIds) &&
        value.partIds.every((id) => typeof id === "string")
      );
    case "thinking.updated":
      return (
        typeof value.messageId === "string" &&
        typeof value.partId === "string" &&
        typeof value.delta === "string" &&
        typeof value.done === "boolean"
      );
    case "activity.updated":
      return typeof value.messageId === "string" && isRecord(value.activity);
    case "permission.updated":
      return typeof value.messageId === "string" && isRecord(value.permission);
    case "storyOffer.updated":
      return typeof value.messageId === "string" && isStoryOffer(value.offer);
    case "message.completed":
      return typeof value.messageId === "string" && typeof value.status === "string";
    case "checkpoint.updated":
      return typeof value.turnId === "string" && isRecord(value.checkpoint);
    case "plan.updated":
      return typeof value.turnId === "string" && isRecord(value.plan);
    case "qa.updated":
      return typeof value.turnId === "string" && isRecord(value.qa);
    case "agent.started":
      return (
        isRecord(value.run) &&
        typeof value.parentMessageId === "string" &&
        isRecord(value.taskMessage) &&
        isRecord(value.assistantMessage)
      );
    case "question.updated":
      return typeof value.messageId === "string" && isRecord(value.question);
    case "usage.updated":
      return typeof value.turnId === "string" && isRecord(value.usage);
    case "agent.updated":
    case "agent.completed":
      return isRecord(value.run);
    case "turn.completed":
    case "turn.aborted":
      return isRecord(value.turn);
    case "turn.failed":
      return isRecord(value.turn) && isRecord(value.error);
    default:
      return false;
  }
}
