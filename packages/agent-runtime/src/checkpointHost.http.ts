import { isRecord } from "@hyperframes/agent-protocol";
import type { RevertMode } from "@hyperframes/agent-protocol";
import type {
  CheckpointHandle,
  CheckpointHost,
  ProjectScope,
  RevertOutcome,
} from "./checkpointHost.js";

const DIRECTOR = { kind: "agent", name: "Director" } as const;
const IDLE_MS = 600_000;

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
      idleMs: IDLE_MS,
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
      end: async () => {
        if (closed) return [];
        closed = true;
        await this.request(scope, "POST", `/window/${encodeURIComponent(windowId)}/close`, {});
        return this.findEntries(scope, label, startedAt);
      },
    };
  }

  async revert(
    scope: ProjectScope,
    entryIds: readonly string[],
    mode: RevertMode,
  ): Promise<RevertOutcome> {
    for (let index = entryIds.length - 1; index >= 0; index -= 1) {
      const entryId = entryIds[index];
      if (!entryId) continue;
      const result = await this.request(scope, "POST", "/undo", {
        entryId,
        who: DIRECTOR,
        mode,
      });
      if (!isRecord(result) || typeof result.ok !== "boolean") {
        throw new Error("Studio returned an invalid history undo result");
      }
      if (result.ok) continue;
      const conflict = isRecord(result.conflict) ? result.conflict : null;
      const files =
        conflict && Array.isArray(conflict.files)
          ? conflict.files.filter((file): file is string => typeof file === "string")
          : [];
      return {
        ok: false,
        conflict: { files },
        remainingEntryIds: entryIds.slice(0, index + 1),
      };
    }
    return { ok: true };
  }

  async recover(scope: ProjectScope, label: string, startedAt: number): Promise<string[]> {
    return this.findEntries(scope, label, startedAt);
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
      throw new Error(message);
    }
    return payload;
  }
}

export function createHttpCheckpointHost(): CheckpointHost {
  return new HttpCheckpointHost();
}
