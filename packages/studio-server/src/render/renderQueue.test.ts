// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processStartKey } from "../history/ownerLock";
import { RenderQueue, type RenderTicket } from "./renderQueue";

const dirs: string[] = [];
const children: ChildProcess[] = [];
const tickets: RenderTicket[] = [];

afterEach(() => {
  for (const ticket of tickets.splice(0)) ticket.release();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function queueIn(overrides: { staleMs?: number } = {}): { queue: RenderQueue; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "hf-render-queue-"));
  dirs.push(dir);
  return { dir, queue: new RenderQueue({ dir, pollMs: 15, heartbeatMs: 40, ...overrides }) };
}

async function join_(queue: RenderQueue, project: string): Promise<RenderTicket> {
  const ticket = await queue.enqueue(project);
  tickets.push(ticket);
  return ticket;
}

/**
 * The queue polls on real timers and its liveness rules read real files and processes, so these tests wait on the
 * real clock (short periods, bounded): fake timers cannot drive another process's death or a file's mtime.
 */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function ticketFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".ticket"));
}

/** A process that has exited: its pid is dead. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid;
  if (pid === undefined) throw new Error("could not start a child process");
  await once(child, "exit");
  return pid;
}

function aliveChild(): ChildProcess & { pid: number } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  if (child.pid === undefined) throw new Error("could not start a child process");
  return Object.assign(child, { pid: child.pid });
}

/** What another process's ticket and slot look like on disk. */
function writeForeign(
  dir: string,
  who: { pid: number; start: string | null; project: string },
  options: { enqueuedAt: number; slot?: boolean; ageMs?: number },
): string {
  const id = `foreign-${options.enqueuedAt}`;
  const ticket = join(dir, `${String(options.enqueuedAt).padStart(15, "0")}-${id}.ticket`);
  writeFileSync(ticket, JSON.stringify({ id, enqueuedAt: options.enqueuedAt, ...who }));
  const files = [ticket];
  if (options.slot) {
    const slot = join(dir, "slot.json");
    writeFileSync(slot, JSON.stringify({ ticket: id, ...who }));
    files.push(slot);
  }
  if (options.ageMs) {
    const old = new Date(Date.now() - options.ageMs);
    for (const file of files) utimesSync(file, old, old);
  }
  return ticket;
}

describe("RenderQueue order", () => {
  it("renders one at a time, in the order the renders were asked for", async () => {
    const { queue, dir } = queueIn();
    const first = await join_(queue, "Alpha");
    const second = await join_(queue, "Beta");
    const third = await join_(queue, "Gamma");

    expect(first.standing()).toEqual({ held: true, position: 0, holder: null });
    expect(second.standing()).toMatchObject({ held: false, position: 1, holder: "Alpha" });
    expect(third.standing()).toMatchObject({ held: false, position: 2, holder: "Alpha" });
    expect(ticketFiles(dir)).toHaveLength(3);

    first.release();
    expect(await second.granted).toBe(true);
    expect(second.standing().held).toBe(true);
    await until(() => third.standing().position === 1, "the third to move up");
    expect(third.standing()).toMatchObject({ held: false, holder: "Beta" });

    second.release();
    expect(await third.granted).toBe(true);
    third.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("holds the slot machine-wide: tickets of two queue instances never run together", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-render-queue-"));
    dirs.push(dir);
    const one = new RenderQueue({ dir, pollMs: 15, heartbeatMs: 40 });
    const two = new RenderQueue({ dir, pollMs: 15, heartbeatMs: 40 });
    const all = await Promise.all(
      Array.from({ length: 6 }, (_, index) => join_(index % 2 ? one : two, `P${index}`)),
    );
    let running = 0;
    let peak = 0;
    let finished = 0;
    await Promise.all(
      all.map(async (ticket) => {
        if (!(await ticket.granted)) return;
        running += 1;
        peak = Math.max(peak, running);
        await sleep(15);
        running -= 1;
        finished += 1;
        ticket.release();
      }),
    );
    expect(finished).toBe(6);
    expect(peak).toBe(1);
  });

  it("notifies a waiting ticket as its place changes", async () => {
    const { queue } = queueIn();
    const first = await join_(queue, "Alpha");
    const second = await join_(queue, "Beta");
    const third = await join_(queue, "Gamma");
    const seen: number[] = [];
    third.onChange((standing) => seen.push(standing.position));
    second.release();
    await until(() => seen.length > 0, "a position change");
    expect(seen).toEqual([1]);
    first.release();
    expect(await third.granted).toBe(true);
  });
});

describe("RenderQueue cancel", () => {
  it("takes a waiting ticket out of the queue without touching the render in front", async () => {
    const { queue, dir } = queueIn();
    const first = await join_(queue, "Alpha");
    const second = await join_(queue, "Beta");
    const third = await join_(queue, "Gamma");

    second.release();
    expect(await second.granted).toBe(false);
    expect(ticketFiles(dir)).toHaveLength(2);
    expect(first.standing().held).toBe(true);
    await until(() => third.standing().position === 1, "the third to move up");

    // The slot is still the first's: a release is idempotent and never frees someone else's slot.
    second.release();
    expect(existsSync(join(dir, "slot.json"))).toBe(true);
    first.release();
    expect(await third.granted).toBe(true);
  });
});

describe("RenderQueue eviction", () => {
  it("frees the queue when the process that was rendering is killed (SIGKILL)", async () => {
    const { queue, dir } = queueIn();
    const child = aliveChild();
    const start = await processStartKey(child.pid);
    writeForeign(dir, { pid: child.pid, start, project: "Other" }, { enqueuedAt: 1, slot: true });

    const waiting = await join_(queue, "Mine");
    expect(waiting.standing()).toMatchObject({ held: false, position: 1, holder: "Other" });
    await sleep(200);
    expect(waiting.standing().held).toBe(false);

    child.kill("SIGKILL");
    expect(await waiting.granted).toBe(true);
    expect(ticketFiles(dir)).toHaveLength(1);
  });

  it("evicts a dead holder's slot and a dead ticket queued ahead", async () => {
    const { queue, dir } = queueIn();
    const pid = await deadPid();
    writeForeign(dir, { pid, start: null, project: "Gone" }, { enqueuedAt: 1, slot: true });
    writeForeign(dir, { pid, start: null, project: "AlsoGone" }, { enqueuedAt: 2 });

    const ticket = await join_(queue, "Mine");
    await ticket.granted;
    expect(ticket.standing().held).toBe(true);
    expect(ticketFiles(dir)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "slot.json"), "utf-8")).ticket).toBe(ticket.id);
  });

  it("evicts a live pid whose heartbeat went quiet for good", async () => {
    const { queue, dir } = queueIn({ staleMs: 500 });
    // This process's pid is alive, so only the quiet heartbeat can condemn it.
    writeForeign(
      dir,
      { pid: process.pid, start: null, project: "Hung" },
      { enqueuedAt: 1, slot: true, ageMs: 5_000 },
    );
    const ticket = await join_(queue, "Mine");
    await ticket.granted;
    expect(ticketFiles(dir)).toHaveLength(1);
  });

  it("does not evict a live holder that keeps its heartbeat", async () => {
    const { queue, dir } = queueIn({ staleMs: 500 });
    const holder = await join_(queue, "Alpha");
    const waiting = await join_(queue, "Beta");
    await sleep(800);
    expect(holder.standing().held).toBe(true);
    expect(waiting.standing()).toMatchObject({ held: false, position: 1, holder: "Alpha" });
    expect(ticketFiles(dir)).toHaveLength(2);
  });

  it("takes over from a live pid that started at another time (a reused pid)", async () => {
    if (process.platform === "win32") return;
    const { queue, dir } = queueIn();
    const child = aliveChild();
    const start = await processStartKey(child.pid);
    if (start === null) return;
    // The file names the child's pid but the start of some other, earlier process; its heartbeat is a while old.
    writeForeign(
      dir,
      { pid: child.pid, start: `${start} (earlier)`, project: "Stranger" },
      { enqueuedAt: 1, slot: true, ageMs: 10_000 },
    );
    const ticket = await join_(queue, "Mine");
    await ticket.granted;
    expect(ticket.standing().held).toBe(true);
  });

  it("keeps a live holder whose start matches even after a quiet spell", async () => {
    const { queue, dir } = queueIn();
    const child = aliveChild();
    const start = await processStartKey(child.pid);
    writeForeign(
      dir,
      { pid: child.pid, start, project: "Slow" },
      { enqueuedAt: 1, slot: true, ageMs: 10_000 },
    );
    const ticket = await join_(queue, "Mine");
    await sleep(200);
    expect(ticket.standing()).toMatchObject({ held: false, holder: "Slow" });
  });
});
