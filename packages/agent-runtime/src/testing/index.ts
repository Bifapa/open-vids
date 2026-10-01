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
  renewals: number;
}

/**
 * Deterministic in-memory checkpoint host for runtime tests and embedding harnesses. A window stays open until it is
 * ended through its handle, through recover(), or by {@link expire} (the host-side lease lapsing).
 */
export class FakeCheckpointHost implements CheckpointHost {
  readonly windows: FakeWindow[] = [];
  readonly revertCalls: Array<{ entryIds: string[]; mode: RevertMode | undefined }> = [];
  readonly recoveryCalls: Array<{ label: string; startedAt: number; transactionId?: string }> = [];
  nextBeginError: Error | null = null;
  nextEndError: Error | null = null;
  nextRenewError: Error | null = null;
  nextRevertError: Error | null = null;
  nextRevertOutcome: RevertOutcome | null = null;
  nextEntryIds: string[] = [];
  /** Files each history entry changed, for {@link files}. */
  entryFiles: Record<string, string[]> = {};
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
      renewals: 0,
    };
    this.windows.push(window);
    return {
      startedAt: window.startedAt,
      transactionId: window.id,
      renew: async () => {
        if (this.nextRenewError) {
          const error = this.nextRenewError;
          this.nextRenewError = null;
          throw error;
        }
        if (window.ended) return false;
        window.renewals += 1;
        return true;
      },
      end: async () => {
        if (this.nextEndError) {
          const error = this.nextEndError;
          this.nextEndError = null;
          throw error;
        }
        this.close(window);
        return [...window.entryIds];
      },
    };
  }

  /** The host ended the window on its own (its lease lapsed): later renewals report it gone. */
  expire(id: string): void {
    const window = this.windows.find((candidate) => candidate.id === id);
    if (window) this.close(window);
  }

  async revert(
    _scope: ProjectScope,
    entryIds: readonly string[],
    mode: RevertMode | undefined,
  ): Promise<RevertOutcome> {
    this.revertCalls.push({ entryIds: [...entryIds], mode });
    if (this.nextRevertError) {
      const error = this.nextRevertError;
      this.nextRevertError = null;
      throw error;
    }
    const outcome = this.nextRevertOutcome;
    this.nextRevertOutcome = null;
    return outcome ?? { ok: true, undoEntryIds: entryIds.map((id) => `undo-${id}`).reverse() };
  }

  async files(_scope: ProjectScope, entryIds: readonly string[]): Promise<string[]> {
    return [...new Set(entryIds.flatMap((id) => this.entryFiles[id] ?? []))].sort();
  }

  async recover(
    _scope: ProjectScope,
    checkpoint: { label: string; startedAt: number; transactionId?: string },
  ): Promise<string[]> {
    this.recoveryCalls.push({ ...checkpoint });
    const open = this.windows.find((window) => window.id === checkpoint.transactionId);
    if (open && !open.ended) this.close(open);
    return this.windows
      .filter(
        (entry) => entry.label === checkpoint.label && entry.startedAt === checkpoint.startedAt,
      )
      .flatMap((entry) => entry.entryIds);
  }

  addRecoveredEntry(scope: ProjectScope, label: string, startedAt: number, id: string): void {
    this.windows.push({ scope, label, startedAt, id, entryIds: [id], ended: true, renewals: 0 });
  }

  private close(window: FakeWindow): void {
    if (window.ended) return;
    window.ended = true;
    window.entryIds = this.nextEntryIds;
    this.nextEntryIds = [];
  }
}

export { ScriptedAgentBackend, ScriptedSession } from "./backend.js";
export type { PromptScript } from "./backend.js";
export { FakeEditingHost } from "./editing.js";
export { FakeQaHost, cleanCheck, qaDraft } from "./qa.js";
export { FakeAnalysisHost, FAKE_JPEG, SAMPLE_SOURCE } from "./analysis.js";
export {
  FakeStoryHost,
  chapterNode,
  sampleBuildResult,
  storyGraph,
  storyView,
  userEditedStory,
  videoNode,
} from "./story.js";
export {
  FakeResearchHost,
  ccBy,
  researchPolicy,
  sampleCandidate,
  sampleProvenance,
  sampleSearchResult,
  sampleSourcesView,
  trustedSource,
} from "./research.js";
