import type { AgentId } from "@hyperframes/agent-protocol";
import { posix } from "node:path";
import { AGENT_DISPLAY_NAMES } from "@hyperframes/agent-protocol";

/** Who writes: a delegated run, or the Director (`runId` null; it never takes a lease). */
export interface LeaseWriter {
  agent: AgentId;
  runId: string | null;
}

export interface LeaseHolder {
  agent: AgentId;
  runId: string;
}

/**
 * The key a file is leased under: project-relative, forward slashes, resolved the way the editing service resolves a
 * composition path (a leading `/` is the project root, `.` and `..` segments and doubled slashes collapse, nothing
 * climbs out of the root), lower-cased (the project may sit on a case-insensitive volume, where `Index.html` and
 * `index.html` are one file). Callers pass any spelling of the path.
 */
export function leaseKey(file: string): string {
  return posix
    .normalize(`/${file.replaceAll("\\", "/")}`)
    .slice(1)
    .toLowerCase();
}

/**
 * Per-file write leases of one running turn. A delegated run that writes a composition file (raw `edit`/`write`, or
 * `edit_timeline` applying to it) holds that file until the run ends; while it does, a write of any other run — and of
 * the Director — to the same file is refused with the name of the holder, instead of racing it and losing one side's
 * work. The Director itself never takes a lease (it would block its own team); its writes only respect the leases of
 * others.
 *
 * One instance per turn runner; every tool family that writes composition files calls {@link claim} before the write
 * and the orchestrator calls {@link release} when a run ends.
 */
export class WriteLeases {
  private readonly held = new Map<string, LeaseHolder>();

  /**
   * Takes the lease of every file for the writer, all or none. Returns null when the write may go ahead (the files are
   * free or already the writer's), otherwise the refusal text to show the agent. A writer without a run (the Director)
   * only checks.
   */
  claim(writer: LeaseWriter, files: readonly string[]): string | null {
    const refused = this.check(writer, files);
    if (refused) return refused;
    if (writer.runId !== null) {
      for (const file of files) {
        this.held.set(leaseKey(file), { agent: writer.agent, runId: writer.runId });
      }
    }
    return null;
  }

  /** Whether a write by this writer would be refused, without taking anything. */
  check(writer: LeaseWriter, files: readonly string[]): string | null {
    for (const file of files) {
      const key = leaseKey(file);
      const holder = this.held.get(key);
      if (holder && holder.runId !== writer.runId) return refusal(key, holder, writer);
    }
    return null;
  }

  /** Frees every file the run holds (the run ended, failed, was cancelled or aborted). */
  release(runId: string): void {
    for (const [key, holder] of this.held) {
      if (holder.runId === runId) this.held.delete(key);
    }
  }

  /** Frees everything (the turn ended). */
  clear(): void {
    this.held.clear();
  }

  /** The run holding the file, or null. */
  holderOf(file: string): LeaseHolder | null {
    return this.held.get(leaseKey(file)) ?? null;
  }
}

function refusal(key: string, holder: LeaseHolder, writer: LeaseWriter): string {
  const who = AGENT_DISPLAY_NAMES[holder.agent];
  const you = writer.agent === "director" ? "Your" : "This";
  return `${you} write to ${key} was refused: the ${who} run ${holder.runId} is changing that file right now and keeps it until it finishes. Wait for it (wait_for_agents), or make this change after it ends; two writers on one composition overwrite each other.`;
}
