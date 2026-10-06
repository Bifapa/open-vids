import { randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "@hyperframes/agent-protocol";
import { ownStartKey, processStartKey, sameStart } from "../history/ownerLock.js";

/**
 * One render at a time on the whole machine, whichever Studio server (the app's, a second window's, `hyperframes
 * preview`) and whoever (the user or the agent) asks. The queue is a folder of small files, so it works across processes
 * and survives a hard kill of any of them without a handler:
 *
 *   `<dir>/<enqueuedAt>-<uuid>.ticket`  one per render that waits or renders: who (pid, process start, project name).
 *   `<dir>/slot.json`                   the render slot: the ticket that may render now. Linked into place, so exactly
 *                                       one process gets it however the tickets race.
 *
 * Order is FIFO by ticket name. The oldest live ticket claims the free slot. Both files carry a heartbeat (their mtime,
 * touched every heartbeat period); an owner is dead when its pid is gone, when its process started at another time than
 * the file says (a reused pid), or when it has not beaten for a long while. Anyone who finds a dead ticket or slot
 * removes it, so a SIGKILLed render frees the queue at once.
 */

/** Queue folder: `$OPENVIDS_RENDER_QUEUE_DIR`, else `~/.openvids/render-queue`. */
export function defaultRenderQueueDir(): string {
  return process.env.OPENVIDS_RENDER_QUEUE_DIR || join(homedir(), ".openvids", "render-queue");
}

const HEARTBEAT_MS = 5_000;
/** A heartbeat this many periods old makes a live pid suspect: the process start is compared (where that is cheap). */
const SUSPECT_BEATS = 3;
/** A heartbeat this old is dead whatever the pid says (Windows, where starts are not looked up per check). */
const STALE_MS = 3 * 60_000;
const POLL_MS = 250;
const SLOT_FILE = "slot.json";
const TICKET_SUFFIX = ".ticket";
const MAX_PROJECT_NAME = 200;

export interface RenderQueueOptions {
  /** Defaults to {@link defaultRenderQueueDir}, read when a ticket is taken. */
  dir?: string;
  pollMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
}

/** Where a ticket stands. `position` is 0 while it holds the slot, else 1 for the next to render. */
export interface QueueStanding {
  held: boolean;
  position: number;
  /** The project of the render holding the slot, when it is not this ticket's. */
  holder: string | null;
}

export interface RenderTicket {
  readonly id: string;
  standing(): QueueStanding;
  /** Settles `true` once this ticket holds the slot, `false` when it was released before. */
  readonly granted: Promise<boolean>;
  /** Called when the standing changes. Returns the unsubscribe. */
  onChange(listener: (standing: QueueStanding) => void): () => void;
  /** Frees the slot if held and leaves the queue. Idempotent. */
  release(): void;
}

interface Who {
  pid: number;
  start: string | null;
  project: string;
}
interface TicketRecord extends Who {
  id: string;
  enqueuedAt: number;
}
interface SlotRecord extends Who {
  ticket: string;
}
interface Seen<R> {
  file: string;
  record: R;
  mtimeMs: number;
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function readWho(value: Record<string, unknown>): Who | null {
  const { pid, start, project } = value;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof project !== "string") return null;
  if (start !== null && typeof start !== "string") return null;
  return { pid, start, project };
}

function parseTicket(text: string): TicketRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    const who = readWho(value);
    if (!who || typeof value.id !== "string" || typeof value.enqueuedAt !== "number") return null;
    return { ...who, id: value.id, enqueuedAt: value.enqueuedAt };
  } catch {
    return null;
  }
}

function parseSlot(text: string): SlotRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    const who = readWho(value);
    if (!who || typeof value.ticket !== "string") return null;
    return { ...who, ticket: value.ticket };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error) && error.code === "EPERM";
  }
}

/** Reads `file`; null when it is gone or unreadable, a null record when it holds nothing usable. */
function readFileRecord<R>(
  file: string,
  parse: (text: string) => R | null,
): { record: R | null; mtimeMs: number } | null {
  try {
    const mtimeMs = statSync(file).mtimeMs;
    return { record: parse(readFileSync(file, "utf-8")), mtimeMs };
  } catch {
    return null;
  }
}

/** Removes `file`. A sharing violation (Windows, another process has it open for a moment) is left for the next poll. */
function drop(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Retried by whoever looks next.
  }
}

/** Written aside and linked in, so a reader never sees a file without its content and two claimants cannot both win. */
function linkNew(file: string, content: string): boolean {
  const draft = `${file}.${randomUUID()}.tmp`;
  writeFileSync(draft, content);
  try {
    linkSync(draft, file);
    return true;
  } catch (error) {
    if (!isErrno(error) || error.code !== "EEXIST") throw error;
    return false;
  } finally {
    drop(draft);
  }
}

function touch(file: string): boolean {
  try {
    const now = new Date();
    utimesSync(file, now, now);
    return true;
  } catch {
    return false;
  }
}

/** The latest ticket stamp this process took. */
let lastStamp = 0;

/** This process's own start, looked up once (on macOS and Linux that is a child process or a read). */
let ownStart: Promise<string | null> | undefined;

/** The tickets this process still holds, released on a clean exit (a hard kill is left to the liveness rules). */
const heldTickets = new Set<{ release(): void }>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const held of [...heldTickets]) held.release();
  });
}

export class RenderQueue {
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  /** Whether a ticket's process start matched, by ticket id: a start never changes, a lookup spawns a process. */
  private readonly startMatches = new Map<string, boolean>();

  constructor(private readonly options: RenderQueueOptions = {}) {
    this.pollMs = options.pollMs ?? POLL_MS;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.staleMs = options.staleMs ?? STALE_MS;
  }

  /**
   * Takes a ticket for a render of `project`. Resolves once the ticket stands in the queue, with its first standing
   * known (a free machine grants the slot at once).
   */
  async enqueue(project: string): Promise<RenderTicket> {
    const dir = this.options.dir ?? defaultRenderQueueDir();
    mkdirSync(dir, { recursive: true });
    ownStart ??= ownStartKey();
    const start = await ownStart;
    // Strictly increasing within this process: tickets taken in the same millisecond keep their order.
    const enqueuedAt = (lastStamp = Math.max(Date.now(), lastStamp + 1));
    const id = randomUUID();
    const ticketFile = join(dir, `${String(enqueuedAt).padStart(15, "0")}-${id}${TICKET_SUFFIX}`);
    const slotFile = join(dir, SLOT_FILE);
    const who: Who = { pid: process.pid, start, project: project.slice(0, MAX_PROJECT_NAME) };
    const ticketBody = JSON.stringify({ id, enqueuedAt, ...who });
    const slotBody = JSON.stringify({ ticket: id, ...who });
    linkNew(ticketFile, ticketBody);

    let standing: QueueStanding = { held: false, position: 1, holder: null };
    let finished = false;
    let polling: NodeJS.Timeout | undefined;
    let ticking = false;
    const listeners = new Set<(standing: QueueStanding) => void>();
    let settle: (granted: boolean) => void = () => {};
    const granted = new Promise<boolean>((resolve) => {
      settle = resolve;
    });

    const publish = (next: QueueStanding): void => {
      if (
        next.held === standing.held &&
        next.position === standing.position &&
        next.holder === standing.holder
      )
        return;
      standing = next;
      for (const listener of [...listeners]) listener(next);
    };

    const heartbeat = setInterval(() => {
      if (finished) return;
      try {
        if (!touch(ticketFile)) linkNew(ticketFile, ticketBody);
        if (standing.held && !touch(slotFile)) linkNew(slotFile, slotBody);
      } catch {
        // The folder is gone or unwritable for the moment; the next beat tries again.
      }
    }, this.heartbeatMs);
    heartbeat.unref();

    const handle = {
      release: () => {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        clearTimeout(polling);
        heldTickets.delete(handle);
        // Only the slot this ticket holds: a release never takes a later holder's slot.
        if (readFileRecord(slotFile, parseSlot)?.record?.ticket === id) drop(slotFile);
        drop(ticketFile);
        listeners.clear();
        settle(false);
      },
    };
    heldTickets.add(handle);
    installExitHook();

    const tick = async (): Promise<void> => {
      if (finished || ticking) return;
      ticking = true;
      try {
        const view = await this.survey(dir, ticketFile, slotFile);
        if (finished) return;
        const waiting = view.tickets.filter((t) => t.record.id !== view.slot?.record.ticket);
        if (!view.slot && waiting[0]?.record.id === id && linkNew(slotFile, slotBody)) {
          publish({ held: true, position: 0, holder: null });
          settle(true);
          return;
        }
        const mine = waiting.findIndex((t) => t.record.id === id);
        publish({
          held: false,
          position: mine === -1 ? waiting.length + 1 : mine + 1,
          holder: view.slot?.record.project ?? null,
        });
      } catch {
        // A queue folder that cannot be read for a moment: the next poll looks again.
      } finally {
        ticking = false;
      }
    };
    const schedule = (): void => {
      if (finished || standing.held) return;
      polling = setTimeout(() => {
        void tick().finally(schedule);
      }, this.pollMs);
      polling.unref();
    };

    await tick();
    schedule();

    return {
      id,
      standing: () => standing,
      granted,
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      release: handle.release,
    };
  }

  /** Live tickets in FIFO order and the live slot, after removing what is dead. */
  private async survey(
    dir: string,
    ownTicketFile: string,
    slotFile: string,
  ): Promise<{ tickets: Seen<TicketRecord>[]; slot: Seen<SlotRecord> | null }> {
    const now = Date.now();
    const suspectMs = this.heartbeatMs * SUSPECT_BEATS;
    const tickets: Seen<TicketRecord>[] = [];
    const present = new Set<string>();
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name);
      if (name.endsWith(".tmp") || name.endsWith(".dead")) {
        // A claim or write killed half way.
        const draft = readFileRecord(file, () => null);
        if (draft && now - draft.mtimeMs > this.staleMs) drop(file);
        continue;
      }
      if (!name.endsWith(TICKET_SUFFIX)) continue;
      const seen = readFileRecord(file, parseTicket);
      if (!seen) continue;
      const { record } = seen;
      if (record === null) {
        // A ticket that holds nothing usable was never complete; a fresh one gets the benefit of the doubt.
        if (now - seen.mtimeMs > suspectMs) drop(file);
        continue;
      }
      if (file !== ownTicketFile && !(await this.holds(record, record.id, seen.mtimeMs, now))) {
        drop(file);
        continue;
      }
      present.add(record.id);
      tickets.push({ file, record, mtimeMs: seen.mtimeMs });
    }
    for (const id of [...this.startMatches.keys()]) {
      if (!present.has(id.replace(/^slot:/, ""))) this.startMatches.delete(id);
    }

    let slot: Seen<SlotRecord> | null = null;
    const slotSeen = readFileRecord(slotFile, parseSlot);
    if (slotSeen) {
      const { record } = slotSeen;
      if (record && (await this.holds(record, `slot:${record.ticket}`, slotSeen.mtimeMs, now))) {
        slot = { file: slotFile, record, mtimeMs: slotSeen.mtimeMs };
      } else if (tickets.length === 0 || tickets[0]?.file === ownTicketFile) {
        // Only the oldest waiter evicts, so evictors do not pile up.
        this.evictSlot(slotFile, record);
      }
    }
    return { tickets, slot };
  }

  /**
   * Whether the process that wrote a ticket or slot still runs. A fresh heartbeat of a live pid is enough; one that
   * has gone quiet makes the pid suspect (it may belong to a stranger now), so the process start is compared where
   * that is a cheap read, and a heartbeat quiet for the stale limit is dead everywhere. A process whose start cannot
   * be told counts as the owner: better a wait than two renders at once.
   */
  private async holds(who: Who, key: string, mtimeMs: number, now: number): Promise<boolean> {
    if (!pidAlive(who.pid)) return false;
    const quiet = now - mtimeMs;
    if (quiet > this.staleMs) return false;
    if (quiet <= this.heartbeatMs * SUSPECT_BEATS || who.start === null) return true;
    if (who.pid === process.pid) return true;
    // Windows has no cheap lookup (PowerShell takes seconds per query): the stale rule covers it.
    if (process.platform === "win32") return true;
    let matches = this.startMatches.get(key);
    if (matches === undefined) {
      const current = await processStartKey(who.pid);
      matches = current === null || sameStart(current, who.start);
      this.startMatches.set(key, matches);
    }
    return matches;
  }

  /**
   * Removes a dead holder's slot. The file is first moved to a name of this process's own (only one evictor's move can
   * succeed), then checked to be the dead one: a live holder's fresh slot that slipped in between is put back.
   */
  private evictSlot(slotFile: string, dead: SlotRecord | null): void {
    const moved = `${slotFile}.${randomUUID()}.dead`;
    try {
      renameSync(slotFile, moved);
    } catch {
      return;
    }
    const taken = readFileRecord(moved, parseSlot)?.record ?? null;
    const same = taken === null ? dead === null : dead !== null && taken.ticket === dead.ticket;
    if (!same) {
      try {
        linkSync(moved, slotFile);
      } catch {
        // Another claimant took the slot meanwhile: nothing to restore.
      }
    }
    drop(moved);
  }
}
