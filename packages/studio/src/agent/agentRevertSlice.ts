import type { StoreApi } from "zustand/vanilla";
import type { RevertMode, RevertTurnRequest, TurnSummary } from "@hyperframes/agent-protocol";
import { AgentApiError, type AgentClient } from "./agentClient";
import { describeAgentFailure } from "./agentErrors";
import type { AgentState } from "./agentStore";

/** A turn footer's checkpoint action in flight (revert or Undo revert), or how it ended without changing files. */
export interface RevertUi {
  status: "pending" | "conflict" | "error";
  /** Which way the call goes: a conflict's choices repeat it with a mode. */
  action: "revert" | "unrevert";
  /** Files that changed after the turn (or after its revert), for a conflict. */
  files: string[];
  message?: string;
}

/** Revert this turn / Undo revert of the open chat's turns. */
export interface AgentRevertSlice {
  reverts: Record<string, RevertUi>;
  revert(turnId: string, mode?: RevertMode): Promise<void>;
  /** Undo revert: the turn's changes are back and it can be reverted again. */
  unrevert(turnId: string, mode?: RevertMode): Promise<void>;
  dismissRevert(turnId: string): void;
}

export interface AgentRevertSliceDeps {
  client: AgentClient;
  set: StoreApi<AgentState>["setState"];
  get: StoreApi<AgentState>["getState"];
  /** Called once a revert or Undo revert rewrote project files: refresh the editor. */
  onTurnReverted?: () => void | Promise<void>;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

export function createAgentRevertSlice({
  client,
  set,
  get,
  onTurnReverted,
}: AgentRevertSliceDeps): AgentRevertSlice {
  const setRevert = (turnId: string, ui: RevertUi) =>
    set((state) => ({ reverts: { ...state.reverts, [turnId]: ui } }));

  const applyTurn = (chatId: string, turn: TurnSummary) =>
    set((state) => {
      const chat = state.chat;
      if (chat?.chat.id !== chatId) return {};
      const turns = chat.turns.map((existing) => (existing.id === turn.id ? turn : existing));
      return { chat: { ...chat, turns } };
    });

  /** Both directions share one request/response shape: only the endpoint differs. */
  const run = async (
    turnId: string,
    action: RevertUi["action"],
    mode: RevertMode | undefined,
  ): Promise<void> => {
    const chatId = get().chatId;
    if (!chatId) return;
    const request: RevertTurnRequest = mode ? { mode } : {};
    setRevert(turnId, { status: "pending", action, files: [] });
    try {
      const result =
        action === "revert"
          ? await client.revertTurn(chatId, turnId, request)
          : await client.unrevertTurn(chatId, turnId, request);
      if (!result.ok) {
        setRevert(turnId, { status: "conflict", action, files: result.conflict.files });
        return;
      }
      applyTurn(chatId, result.turn);
      set((state) => ({ reverts: withoutKey(state.reverts, turnId) }));
      // Only a completed call changed files on disk; a conflict or failure changed nothing.
      try {
        await onTurnReverted?.();
      } catch {
        // The revert itself succeeded; a failed editor refresh must not turn it into an error.
      }
    } catch (error) {
      const message =
        error instanceof AgentApiError
          ? describeAgentFailure(error.code, error.message)
          : describeAgentFailure("internal");
      setRevert(turnId, { status: "error", action, files: [], message });
    }
  };

  return {
    reverts: {},
    revert: (turnId, mode) => run(turnId, "revert", mode),
    unrevert: (turnId, mode) => run(turnId, "unrevert", mode),
    dismissRevert: (turnId) => set((state) => ({ reverts: withoutKey(state.reverts, turnId) })),
  };
}
