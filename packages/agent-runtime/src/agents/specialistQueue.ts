import type { SpecialistId } from "@hyperframes/agent-protocol";

/**
 * How many tasks one specialist works on at once. Research and Vision tasks are independent reads and searches that the
 * prompts ask the Director to batch, so they run two at a time; the others write the timeline one task at a time.
 */
export const SPECIALIST_CONCURRENCY: Readonly<Record<SpecialistId, number>> = {
  editor: 1,
  motion: 1,
  audio: 1,
  research: 2,
  vision: 2,
};

/** A place in a specialist's line. `granted` resolves with the slot, or null when the ticket was dropped first. */
export interface QueueTicket {
  readonly agent: SpecialistId;
  readonly granted: Promise<number | null>;
}

interface Waiter {
  ticket: QueueTicket;
  grant: (slot: number | null) => void;
}

/**
 * The line in front of each specialist. Slot 0 is the specialist's resumable session; further slots are ephemeral
 * sessions of the same role. A task that is dropped while waiting leaves the line at once.
 */
export class SpecialistQueue {
  private readonly taken = new Map<SpecialistId, Set<number>>();
  private readonly waiting = new Map<SpecialistId, Waiter[]>();

  /** Whether a task started now would have to wait. */
  isBusy(agent: SpecialistId): boolean {
    return (this.taken.get(agent)?.size ?? 0) >= SPECIALIST_CONCURRENCY[agent];
  }

  enqueue(agent: SpecialistId): QueueTicket {
    const { promise, resolve } = Promise.withResolvers<number | null>();
    const ticket: QueueTicket = { agent, granted: promise };
    if (!this.isBusy(agent) && (this.waiting.get(agent)?.length ?? 0) === 0) {
      resolve(this.take(agent));
    } else {
      const line = this.waiting.get(agent) ?? [];
      line.push({ ticket, grant: resolve });
      this.waiting.set(agent, line);
    }
    return ticket;
  }

  /** Removes a task that is still waiting; it never gets a slot. A ticket that already has one is unaffected. */
  drop(ticket: QueueTicket): void {
    const line = this.waiting.get(ticket.agent);
    const index = line?.findIndex((waiter) => waiter.ticket === ticket) ?? -1;
    if (!line || index < 0) return;
    const [waiter] = line.splice(index, 1);
    waiter?.grant(null);
  }

  /** Frees a slot and hands it to the next task in line. */
  release(agent: SpecialistId, slot: number): void {
    this.taken.get(agent)?.delete(slot);
    const next = this.waiting.get(agent)?.shift();
    next?.grant(this.take(agent));
  }

  private take(agent: SpecialistId): number {
    const taken = this.taken.get(agent) ?? new Set<number>();
    this.taken.set(agent, taken);
    let slot = 0;
    while (taken.has(slot)) slot += 1;
    taken.add(slot);
    return slot;
  }
}
