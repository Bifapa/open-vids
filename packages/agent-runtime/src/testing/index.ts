import type { RevertMode } from "@hyperframes/agent-protocol";
import type {
  CheckpointHandle,
  CheckpointHost,
  ProjectScope,
  RevertOutcome,
} from "../checkpointHost.js";

interface FakeWindow {
  scope: ProjectScope;
  label: string;
  startedAt: number;
  id: string;
  entryIds: string[];
  ended: boolean;
}

/** Deterministic in-memory checkpoint host for runtime tests and embedding harnesses. */
export class FakeCheckpointHost implements CheckpointHost {
  readonly windows: FakeWindow[] = [];
  readonly revertCalls: Array<{ entryIds: string[]; mode: RevertMode }> = [];
  readonly recoveryCalls: Array<{ label: string; startedAt: number }> = [];
  nextBeginError: Error | null = null;
  nextRevertError: Error | null = null;
  nextRevertOutcome: RevertOutcome | null = null;
  nextEntryIds: string[] = [];
  private sequence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async begin(scope: ProjectScope, label: string): Promise<CheckpointHandle> {
    if (this.nextBeginError) {
      const error = this.nextBeginError;
      this.nextBeginError = null;
      throw error;
    }
    const window: FakeWindow = {
      scope,
      label,
      startedAt: this.now(),
      id: `fake-window-${++this.sequence}`,
      entryIds: [],
      ended: false,
    };
    this.windows.push(window);
    return {
      startedAt: window.startedAt,
      end: async () => {
        window.ended = true;
        window.entryIds = this.nextEntryIds;
        this.nextEntryIds = [];
        return [...window.entryIds];
      },
    };
  }

  async revert(
    _scope: ProjectScope,
    entryIds: readonly string[],
    mode: RevertMode,
  ): Promise<RevertOutcome> {
    this.revertCalls.push({ entryIds: [...entryIds], mode });
    if (this.nextRevertError) {
      const error = this.nextRevertError;
      this.nextRevertError = null;
      throw error;
    }
    const outcome = this.nextRevertOutcome;
    this.nextRevertOutcome = null;
    return outcome ?? { ok: true };
  }

  async recover(_scope: ProjectScope, label: string, startedAt: number): Promise<string[]> {
    this.recoveryCalls.push({ label, startedAt });
    return this.windows
      .filter((entry) => entry.label === label && entry.startedAt === startedAt)
      .flatMap((entry) => entry.entryIds);
  }

  addRecoveredEntry(scope: ProjectScope, label: string, startedAt: number, id: string): void {
    this.windows.push({ scope, label, startedAt, id, entryIds: [id], ended: true });
  }
}

export { ScriptedAgentBackend, ScriptedSession } from "./backend.js";
export type { PromptScript } from "./backend.js";
