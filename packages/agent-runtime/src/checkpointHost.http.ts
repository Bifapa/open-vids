import { isRecord } from "@hyperframes/agent-protocol";
import type { RevertMode } from "@hyperframes/agent-protocol";
import type {
  CheckpointHandle,
  CheckpointHost,
  ProjectScope,
  RevertOutcome,
} from "./checkpointHost.js";

const DIRECTOR = { kind: "agent", name: "Director" } as const;
/**
 * The transaction's lease on the history engine. The turn renews it every 20 s (TurnRunner's `renewIntervalMs`)
 * TurnRunner), so it never lapses while the runtime is alive, however long the agent pauses between writes; if the
 * runtime dies, the engine ends the transaction by itself within this time instead of absorbing later writes.
 */
export const TRANSACTION_LEASE_MS = 120_000;

const windowPath = (windowId: string, action: "close" | "renew") =>
  `/window/${encodeURIComponent(windowId)}/${action}`;

interface HistoryEntryMatch {
  id: string;
  label: string;
  startedAt: number;
  endedAt: number;
  who: { kind: string; name: string };
}

/** Studio's history HTTP API adapter; the runtime never reaches into the history engine directly. */
export class HttpCheckpointHost implements CheckpointHost {
  async begin(scope: ProjectScope, label: string): Promise<CheckpointHandle> {
    const response = await this.request(scope, "POST", "/window", {
      who: DIRECTOR,
      label,
      idleMs: TRANSACTION_LEASE_MS,
    });
    if (!isRecord(response)) throw new Error("Studio returned an invalid history window");
    const windowId = response.windowId;
    const startedAt = response.startedAt;
    if (typeof windowId !== "string" || typeof startedAt !== "number") {
      throw new Error("Studio returned an invalid history window");
    }
    let closed = false;
    return {
      startedAt,
      transactionId: windowId,
      renew: async () => {
        if (closed) return false;
        try {
          await this.request(scope, "POST", windowPath(windowId, "renew"), {});
          return true;
        } catch (error) {
          if (error instanceof HistoryRequestError && error.status === 409) return false;
          throw error;
        }
      },
      end: async () => {
        if (closed) return [];
        closed = true;
        await closeIfOpen(() => this.request(scope, "POST", windowPath(windowId, "close"), {}));
        return this.findEntries(scope, label, startedAt);
      },
    };
  }

  async revert(
    scope: ProjectScope,
    entryIds: readonly string[],
    mode: RevertMode | undefined,
  ): Promise<RevertOutcome> {
    const undoEntryIds: string[] = [];
    for (let index = entryIds.length - 1; index >= 0; index -= 1) {
      const entryId = entryIds[index];
      if (!entryId) continue;
      const result = await this.request(scope, "POST", "/undo", {
        entryId,
        who: DIRECTOR,
        ...(mode && { mode }),
      });
      if (!isRecord(result) || typeof result.ok !== "boolean") {
        throw new Error("Studio returned an invalid history undo result");
      }
      if (result.ok) {
        if (isRecord(result.entry) && typeof result.entry.id === "string")
          undoEntryIds.push(result.entry.id);
        continue;
      }
      const conflict = isRecord(result.conflict) ? result.conflict : null;
      const files =
        conflict && Array.isArray(conflict.files)
          ? conflict.files.filter((file): file is string => typeof file === "string")
          : [];
      return {
        ok: false,
        conflict: { files },
        remainingEntryIds: entryIds.slice(0, index + 1),
        undoEntryIds,
      };
    }
    return { ok: true, undoEntryIds };
  }

  async files(scope: ProjectScope, entryIds: readonly string[]): Promise<string[]> {
    if (entryIds.length === 0) return [];
    const response = await this.request(scope, "GET", "");
    if (!isRecord(response) || !Array.isArray(response.entries)) {
      throw new Error("Studio returned an invalid history list");
    }
    const wanted = new Set(entryIds);
    const paths = new Set<string>();
    for (const entry of response.entries) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !wanted.has(entry.id)) continue;
      if (!Array.isArray(entry.files)) continue;
      for (const file of entry.files) {
        if (isRecord(file) && typeof file.path === "string") paths.add(file.path);
      }
    }
    return [...paths].sort();
  }

  async recover(
    scope: ProjectScope,
    checkpoint: { label: string; startedAt: number; transactionId?: string },
  ): Promise<string[]> {
    const { transactionId } = checkpoint;
    if (transactionId) {
      await closeIfOpen(() => this.request(scope, "POST", windowPath(transactionId, "close"), {}));
    }
    return this.findEntries(scope, checkpoint.label, checkpoint.startedAt);
  }

  private async findEntries(
    scope: ProjectScope,
    label: string,
    startedAt: number,
  ): Promise<string[]> {
    const response = await this.request(scope, "GET", "");
    if (!isRecord(response) || !Array.isArray(response.entries)) {
      throw new Error("Studio returned an invalid history list");
    }
    const matches = response.entries.flatMap((value): HistoryEntryMatch[] => {
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        typeof value.label !== "string" ||
        typeof value.startedAt !== "number" ||
        typeof value.endedAt !== "number" ||
        !isRecord(value.who) ||
        typeof value.who.kind !== "string" ||
        typeof value.who.name !== "string"
      )
        return [];
      if (
        value.who.kind !== DIRECTOR.kind ||
        value.who.name !== DIRECTOR.name ||
        value.label !== label ||
        value.startedAt !== startedAt
      )
        return [];
      return [
        {
          id: value.id,
          label: value.label,
          startedAt: value.startedAt,
          endedAt: value.endedAt,
          who: { kind: value.who.kind, name: value.who.name },
        },
      ];
    });
    return matches.sort((left, right) => left.endedAt - right.endedAt).map((entry) => entry.id);
  }

  private async request(
    scope: ProjectScope,
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const base = `${scope.studioOrigin}/api/projects/${encodeURIComponent(scope.projectId)}/history`;
    const response = await fetch(`${base}${path}`, {
      method,
      ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `Studio history request failed (${response.status})`;
      throw new HistoryRequestError(message, response.status);
    }
    return payload;
  }
}

/** A refusal from Studio's history routes (a 409 means the engine refused: e.g. the window is no longer open). */
class HistoryRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HistoryRequestError";
  }
}

/** Closes a window that may already be gone; a refusal (409: not open here any more) is not an error. */
async function closeIfOpen(close: () => Promise<unknown>): Promise<void> {
  try {
    await close();
  } catch (error) {
    if (!(error instanceof HistoryRequestError && error.status === 409)) throw error;
  }
}

export function createHttpCheckpointHost(): CheckpointHost {
  return new HttpCheckpointHost();
}
